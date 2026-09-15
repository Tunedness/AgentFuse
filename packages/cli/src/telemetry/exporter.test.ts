import { afterEach, describe, expect, it } from 'vitest';
import { OtlpReceiver } from '../testing/otlp-receiver.js';
import { OtlpExporter, type OtlpExporterOptions } from './exporter.js';
import {
  attributes,
  int,
  type OtlpLogRecord,
  type OtlpSpan,
  SEVERITY_INFO,
  SPAN_KIND_CLIENT,
  STATUS_CODE_ERROR,
  str,
  unixNano,
} from './otlp.js';

/**
 * The exporter, against a receiver on a real loopback socket.
 *
 * ADR-010 put the wire format's correctness on us, so the payload is checked
 * field by field from the collector's side rather than asserted to have been
 * POSTed. The other half of this file is the promise that telemetry cannot
 * break the proxy: a collector that is down, slow, or answering nonsense costs
 * one diagnostic line and nothing else.
 */

const RESOURCE = {
  attributes: attributes({
    'service.name': str('agentfuse'),
    'service.version': str('9.9.9'),
  }),
};
const SCOPE = { name: 'agentfuse', version: '9.9.9' };

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function span(overrides: Partial<OtlpSpan> = {}): OtlpSpan {
  return {
    traceId: TRACE_ID,
    spanId: '00f067aa0ba902b7',
    name: 'mcp.tools/call',
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: unixNano(1_700_000_000_000),
    endTimeUnixNano: unixNano(1_700_000_000_050),
    attributes: attributes({
      'tunedness.session_id': str('session-1'),
      'tunedness.call.duration_ms': int(50),
    }),
    ...overrides,
  };
}

function record(overrides: Partial<OtlpLogRecord> = {}): OtlpLogRecord {
  return {
    timeUnixNano: unixNano(1_700_000_000_050),
    observedTimeUnixNano: unixNano(1_700_000_000_050),
    severityNumber: SEVERITY_INFO,
    severityText: 'INFO',
    eventName: 'tunedness.tool_call',
    attributes: attributes({ 'tunedness.session_id': str('session-1') }),
    ...overrides,
  };
}

/** Collects the lines the exporter writes to the host's diagnostics. */
function diagnostics(): {
  lines: { event: string; fields: Record<string, unknown> }[];
  emit: (event: string, fields: Record<string, unknown>) => void;
} {
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  return { lines, emit: (event, fields) => lines.push({ event, fields }) };
}

const open: OtlpReceiver[] = [];
const started: OtlpExporter[] = [];

async function receiver(): Promise<OtlpReceiver> {
  const next = await OtlpReceiver.start();
  open.push(next);
  return next;
}

function exporter(
  endpoint: string,
  options: Omit<OtlpExporterOptions, 'endpoint'> = {},
): OtlpExporter {
  const made = new OtlpExporter(RESOURCE, SCOPE, {
    endpoint,
    // Small, so a test never waits a second for a batch that is already full.
    flushIntervalMs: 5,
    timeoutMs: 500,
    ...options,
  });
  started.push(made);
  return made;
}

afterEach(async () => {
  for (const instance of started.splice(0)) await instance.shutdown();
  for (const instance of open.splice(0)) await instance.close();
});

describe('what a collector actually receives', () => {
  it('posts spans as OTLP/HTTP JSON to /v1/traces', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    subject.enqueueSpan(span());
    await subject.flush();

    const [request] = collector.traceExports;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/v1/traces');
    expect(request?.contentType).toBe('application/json');
  });

  it('carries the resource and the scope on every payload', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    subject.enqueueSpan(span());
    await subject.flush();

    const body = collector.traceExports[0]?.body as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeSpans: { scope: { name: string; version: string } }[];
      }[];
    };
    expect(body.resourceSpans).toHaveLength(1);
    expect(body.resourceSpans[0]?.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'agentfuse' } },
      { key: 'service.version', value: { stringValue: '9.9.9' } },
    ]);
    expect(body.resourceSpans[0]?.scopeSpans[0]?.scope).toEqual({
      name: 'agentfuse',
      version: '9.9.9',
    });
  });

  it('encodes a span field by field, with the units the format requires', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    subject.enqueueSpan(span({ status: { code: STATUS_CODE_ERROR } }));
    await subject.flush();

    expect(collector.spans).toEqual([
      {
        traceId: TRACE_ID,
        spanId: '00f067aa0ba902b7',
        name: 'mcp.tools/call',
        // SPAN_KIND_CLIENT, as an integer rather than the enum's name.
        kind: 3,
        // Nanoseconds, as strings: the values are past 2^53.
        startTimeUnixNano: '1700000000000000000',
        endTimeUnixNano: '1700000000050000000',
        attributes: [
          { key: 'tunedness.session_id', value: { stringValue: 'session-1' } },
          { key: 'tunedness.call.duration_ms', value: { intValue: '50' } },
        ],
        status: { code: 2 },
      },
    ]);
  });

  it('encodes a log record field by field, on its own signal path', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    subject.enqueueLog(record({ traceId: TRACE_ID, spanId: '00f067aa0ba902b7' }));
    await subject.flush();

    expect(collector.logExports[0]?.url).toBe('/v1/logs');
    expect(collector.logRecords).toEqual([
      {
        timeUnixNano: '1700000000050000000',
        observedTimeUnixNano: '1700000000050000000',
        severityNumber: 9,
        severityText: 'INFO',
        eventName: 'tunedness.tool_call',
        attributes: [{ key: 'tunedness.session_id', value: { stringValue: 'session-1' } }],
        traceId: TRACE_ID,
        spanId: '00f067aa0ba902b7',
      },
    ]);
  });

  it('omits parentSpanId entirely for a root span rather than sending zeros', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    subject.enqueueSpan(span());
    await subject.flush();

    expect(collector.spans[0]).not.toHaveProperty('parentSpanId');
    expect(collector.traceExports[0]?.raw).not.toContain('parentSpanId');
  });

  it('batches what is waiting into one request per signal', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    for (let i = 0; i < 5; i += 1) {
      subject.enqueueSpan(span());
      subject.enqueueLog(record());
    }
    await subject.flush();

    expect(collector.traceExports).toHaveLength(1);
    expect(collector.logExports).toHaveLength(1);
    expect(collector.spans).toHaveLength(5);
    expect(collector.logRecords).toHaveLength(5);
  });

  it('splits a backlog into batches of the configured size', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint, { batchSize: 2 });

    for (let i = 0; i < 4; i += 1) subject.enqueueSpan(span());
    await subject.flush();

    expect(collector.traceExports).toHaveLength(2);
    expect(collector.spans).toHaveLength(4);
  });

  it('exports on its own timer, without anybody asking it to flush', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    subject.enqueueSpan(span());
    await collector.waitFor(() => collector.spans.length === 1);

    expect(subject.stats.exported).toBe(1);
  });
});

describe('a collector that is down, slow or nonsense', () => {
  it('drops the batch, counts it and writes exactly one line per outage', async () => {
    const log = diagnostics();
    // Nothing is listening on this port.
    const subject = exporter('http://127.0.0.1:1', { onDiagnostic: log.emit, timeoutMs: 200 });

    subject.enqueueSpan(span());
    await subject.flush();
    subject.enqueueSpan(span());
    await subject.flush();

    expect(subject.stats.failures).toBeGreaterThanOrEqual(1);
    expect(log.lines.filter((line) => line.event === 'telemetry_export_failed')).toHaveLength(1);
  });

  it('gives up on a slow answer instead of holding the queue', async () => {
    const collector = await receiver();
    collector.behaviour = { delayMs: 5_000 };
    const log = diagnostics();
    const subject = exporter(collector.endpoint, { onDiagnostic: log.emit, timeoutMs: 50 });

    subject.enqueueSpan(span());
    const started = Date.now();
    await subject.flush();

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(subject.stats.failures).toBe(1);
    expect(log.lines[0]?.event).toBe('telemetry_export_failed');
  });

  it('treats an HTTP error as a failure and names the status', async () => {
    const collector = await receiver();
    collector.behaviour = { status: 503 };
    const log = diagnostics();
    const subject = exporter(collector.endpoint, { onDiagnostic: log.emit });

    subject.enqueueSpan(span());
    await subject.flush();

    expect(log.lines[0]?.fields.message).toContain('503');
  });

  it('accepts a 200 whose body is nonsense, because the body is never read', async () => {
    const collector = await receiver();
    collector.behaviour = { body: 'not json at all' };
    const subject = exporter(collector.endpoint);

    subject.enqueueSpan(span());
    await subject.flush();

    expect(subject.stats.exported).toBe(1);
    expect(subject.stats.failures).toBe(0);
  });

  it('survives a collector that hangs up mid-request', async () => {
    const collector = await receiver();
    collector.behaviour = { hangUp: true };
    const subject = exporter(collector.endpoint, { timeoutMs: 500 });

    subject.enqueueSpan(span());
    await subject.flush();

    expect(subject.stats.failures).toBe(1);
  });

  it('backs off, and doubles the delay while the failures continue', async () => {
    let now = 0;
    const log = diagnostics();
    const subject = exporter('http://127.0.0.1:1', {
      onDiagnostic: log.emit,
      now: () => now,
      timeoutMs: 100,
      retryDelayMs: 1_000,
    });

    subject.enqueueSpan(span());
    await subject.flush();
    expect(subject.stats.backingOff).toBe(true);
    const [failure] = log.lines;
    expect(failure?.fields.retryInMs).toBe(1_000);

    // Inside the backoff nothing is sent at all.
    subject.enqueueSpan(span());
    await subject.flush();
    expect(subject.stats.failures).toBe(1);

    now = 1_001;
    await subject.flush();
    expect(subject.stats.failures).toBe(2);
    expect(log.lines.filter((line) => line.event === 'telemetry_export_failed')).toHaveLength(1);
    // Second failure of the streak: 1000 × 2.
    expect(subject.stats.backingOff).toBe(true);
    now = 2_000;
    expect(subject.stats.backingOff).toBe(true);
    now = 3_002;
    expect(subject.stats.backingOff).toBe(false);
  });

  it('says so when the collector comes back', async () => {
    const collector = await receiver();
    collector.behaviour = { status: 500 };
    const log = diagnostics();
    const subject = exporter(collector.endpoint, { onDiagnostic: log.emit, retryDelayMs: 1 });

    subject.enqueueSpan(span());
    await subject.flush();
    collector.behaviour = {};
    await new Promise((resolve) => setTimeout(resolve, 5));
    subject.enqueueSpan(span());
    await subject.flush();

    expect(log.lines.map((line) => line.event)).toEqual([
      'telemetry_export_failed',
      'telemetry_export_recovered',
    ]);
  });
});

describe('the bounds', () => {
  it('leaves the rest of a backlog queued when a batch fails', async () => {
    const log = diagnostics();
    const subject = exporter('http://127.0.0.1:1', {
      onDiagnostic: log.emit,
      batchSize: 1,
      timeoutMs: 100,
      retryDelayMs: 60_000,
    });

    subject.enqueueSpan(span());
    subject.enqueueSpan(span());
    subject.enqueueSpan(span());
    await subject.flush();

    // One batch tried, one batch lost, and the backoff stopped the rest from
    // being thrown at a collector that has just proved it is not there.
    expect(subject.stats.failures).toBe(1);
    expect(subject.depth).toBe(2);
  });

  it('counts a record it cannot even serialise, instead of wedging the queue', async () => {
    const collector = await receiver();
    const log = diagnostics();
    const subject = exporter(collector.endpoint, { onDiagnostic: log.emit });

    // A BigInt is the everyday way to make `JSON.stringify` throw. Nothing we
    // build can contain one; the path exists so that a future attribute type
    // that does is a counter and a line rather than a stuck exporter.
    subject.enqueueSpan(
      span({
        attributes: [{ key: 'x', value: { intValue: 1n } }] as unknown as OtlpSpan['attributes'],
      }),
    );
    subject.enqueueSpan(span());
    await subject.flush();

    expect(log.lines[0]?.event).toBe('telemetry_export_failed');
    expect(subject.stats.failures).toBe(1);
  });

  it('drops the oldest record when a queue is full', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint, { capacity: 2, batchSize: 10 });

    subject.enqueueSpan(span({ spanId: '0000000000000001' }));
    subject.enqueueSpan(span({ spanId: '0000000000000002' }));
    subject.enqueueSpan(span({ spanId: '0000000000000003' }));
    await subject.flush();

    expect(collector.spans.map((entry) => entry.spanId)).toEqual([
      '0000000000000002',
      '0000000000000003',
    ]);
    expect(subject.stats.dropped).toBe(1);
  });

  it('stops accepting once it has been shut down', async () => {
    const collector = await receiver();
    const subject = exporter(collector.endpoint);

    await subject.shutdown();
    subject.enqueueSpan(span());

    expect(subject.depth).toBe(0);
    expect(collector.spans).toHaveLength(0);
  });

  it('flushes what is queued on the way out and reports the counters once', async () => {
    const collector = await receiver();
    const log = diagnostics();
    const subject = new OtlpExporter(RESOURCE, SCOPE, {
      endpoint: collector.endpoint,
      onDiagnostic: log.emit,
    });

    subject.enqueueSpan(span());
    await subject.shutdown();
    await subject.shutdown();

    expect(collector.spans).toHaveLength(1);
    expect(log.lines.filter((line) => line.event === 'telemetry_stats')).toEqual([
      {
        event: 'telemetry_stats',
        fields: { accepted: 1, exported: 1, dropped: 0, requests: 1, failures: 0 },
      },
    ]);
  });

  it('does not wait out a backoff on the way out', async () => {
    const log = diagnostics();
    const subject = new OtlpExporter(RESOURCE, SCOPE, {
      endpoint: 'http://127.0.0.1:1',
      onDiagnostic: log.emit,
      timeoutMs: 100,
      retryDelayMs: 60_000,
    });

    subject.enqueueSpan(span());
    await subject.flush();
    subject.enqueueSpan(span());
    const started = Date.now();
    await subject.shutdown();

    expect(Date.now() - started).toBeLessThan(1_000);
    // The record that could not go is counted rather than forgotten.
    expect(subject.stats.dropped).toBeGreaterThanOrEqual(2);
  });
});
