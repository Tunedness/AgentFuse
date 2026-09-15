import type { FuseEvent } from '@agentfuse/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { OtlpExporter } from './exporter.js';
import { SCOPE } from './index.js';
import type { KeyValue } from './otlp.js';
import { attributes, str } from './otlp.js';
import { OtlpTelemetrySink } from './sink.js';

/**
 * The mapping from core's four `FuseEvent`s onto OTLP.
 *
 * The exporter underneath is the real one, with `fetch` replaced: these
 * assertions are about the encoded payload a collector would receive, not about
 * an intermediate object nobody ships.
 */

const RESOURCE = { attributes: attributes({ 'service.name': str('agentfuse') }) };
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN}-01`;

interface Payloads {
  spans: Record<string, unknown>[];
  records: Record<string, unknown>[];
}

let sent: Payloads;
let sink: OtlpTelemetrySink;
let exporter: OtlpExporter;
let inbound: Map<string, string>;
let counter: number;

beforeEach(() => {
  sent = { spans: [], records: [] };
  inbound = new Map();
  counter = 0;
  exporter = new OtlpExporter(RESOURCE, SCOPE, {
    endpoint: 'http://collector.test',
    flushIntervalMs: 1,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, never>;
      const dig = (outer: string, middle: string, inner: string): Record<string, unknown>[] =>
        ((body[outer] ?? []) as Record<string, never>[]).flatMap((resource) =>
          ((resource[middle] ?? []) as Record<string, never>[]).flatMap(
            (scope) => (scope[inner] ?? []) as Record<string, unknown>[],
          ),
        );
      if (url.endsWith('/v1/traces'))
        sent.spans.push(...dig('resourceSpans', 'scopeSpans', 'spans'));
      else sent.records.push(...dig('resourceLogs', 'scopeLogs', 'logRecords'));
      return new Response('{}', { status: 200 });
    },
  });
  sink = new OtlpTelemetrySink({
    exporter,
    // Deterministic span ids, so a parent/child relationship is assertable.
    random: (size) => {
      counter += 1;
      return new Uint8Array(size).fill(counter);
    },
    now: () => 1_700_000_000_000,
  });
  sink.bindCallLookup((_sessionId, callId) => inbound.get(callId));
});

/** Emits, flushes, and hands back what the collector saw. */
async function exported(...events: FuseEvent[]): Promise<Payloads> {
  for (const event of events) sink.emit(event);
  await exporter.flush();
  return sent;
}

/** One attribute of a record, by key. */
function attribute(record: Record<string, unknown> | undefined, key: string): unknown {
  const bag = (record?.attributes ?? []) as KeyValue[];
  return bag.find((entry) => entry.key === key)?.value;
}

/** Every attribute key of a record, in order. */
function keys(record: Record<string, unknown> | undefined): string[] {
  return ((record?.attributes ?? []) as KeyValue[]).map((entry) => entry.key);
}

const decision = (overrides: Partial<Extract<FuseEvent, { type: 'policy_decision' }>> = {}) =>
  ({
    type: 'policy_decision',
    timestamp: 1_700_000_000_000,
    sessionId: 'S1',
    callId: 'C1',
    action: 'deny',
    mode: 'enforce',
    wouldTrip: false,
    codes: ['LOOP_EXACT_REPEAT'],
    ...overrides,
  }) satisfies Extract<FuseEvent, { type: 'policy_decision' }>;

const call = (overrides: Partial<Extract<FuseEvent, { type: 'tool_call' }>> = {}) =>
  ({
    type: 'tool_call',
    timestamp: 1_700_000_000_050,
    sessionId: 'S1',
    callId: 'C1',
    serverName: 'fs',
    toolName: 'read_file',
    isError: false,
    durationMs: 50,
    tokensEstimated: { args: 10, results: 90 },
    ...overrides,
  }) satisfies Extract<FuseEvent, { type: 'tool_call' }>;

describe('a forwarded tool call', () => {
  it('produces a span and an event, with the attributes the contract names', async () => {
    const { spans, records } = await exported(call());

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'mcp.tools/call',
      kind: 3,
      startTimeUnixNano: '1700000000000000000',
      endTimeUnixNano: '1700000000050000000',
    });
    expect(keys(spans[0])).toEqual([
      'tunedness.session_id',
      'tunedness.call.id',
      'tunedness.tool.name',
      'tunedness.server.name',
      'tunedness.call.is_error',
      'tunedness.call.duration_ms',
      'tunedness.call.tokens_estimated',
    ]);
    expect(attribute(spans[0], 'tunedness.tool.name')).toEqual({ stringValue: 'read_file' });
    expect(attribute(spans[0], 'tunedness.server.name')).toEqual({ stringValue: 'fs' });
    expect(attribute(spans[0], 'tunedness.call.is_error')).toEqual({ boolValue: false });
    expect(attribute(spans[0], 'tunedness.call.duration_ms')).toEqual({ intValue: '50' });
    // ADR-007: args plus results, and the name says it is an estimate.
    expect(attribute(spans[0], 'tunedness.call.tokens_estimated')).toEqual({ intValue: '100' });

    expect(records).toHaveLength(1);
    expect(records[0]?.eventName).toBe('tunedness.tool_call');
    expect(attribute(records[0], 'event.name')).toEqual({
      stringValue: 'tunedness.tool_call',
    });
    expect(records[0]?.traceId).toBe(spans[0]?.traceId);
    expect(records[0]?.spanId).toBe(spans[0]?.spanId);
  });

  it('marks an error call on the span and carries its signature', async () => {
    const { spans } = await exported(call({ isError: true, errorSignature: 'ENOENT' }));

    expect(spans[0]?.status).toEqual({ code: 2 });
    expect(attribute(spans[0], 'tunedness.call.error_signature')).toEqual({
      stringValue: 'ENOENT',
    });
  });

  it('leaves the status off a call that worked', async () => {
    const { spans } = await exported(call());

    expect(spans[0]).not.toHaveProperty('status');
  });
});

describe('trace context', () => {
  it('makes the span a child of the traceparent the request carried', async () => {
    inbound.set('C1', TRACEPARENT);

    const { spans, records } = await exported(decision({ action: 'allow' }), call());

    expect(spans[0]?.traceId).toBe(TRACE_ID);
    expect(spans[0]?.parentSpanId).toBe(PARENT_SPAN);
    // The decision and the call it decided are one span, minted once.
    expect(records.filter((entry) => entry.eventName === 'tunedness.tool_call')[0]?.spanId).toBe(
      spans[0]?.spanId,
    );
  });

  it('fabricates no parent when nothing came in, and correlates by session id', async () => {
    const { spans, records } = await exported(call());

    expect(spans[0]).not.toHaveProperty('parentSpanId');
    expect(spans[0]?.traceId).not.toBe(TRACE_ID);
    expect(attribute(spans[0], 'tunedness.session_id')).toEqual({ stringValue: 'S1' });
    expect(attribute(records[0], 'tunedness.session_id')).toEqual({ stringValue: 'S1' });
  });

  it('ignores a traceparent that does not parse rather than repairing it', async () => {
    inbound.set('C1', 'garbage');

    const { spans } = await exported(call());

    expect(spans[0]).not.toHaveProperty('parentSpanId');
  });

  it('gives a blocked call the decision event inside the agent’s trace', async () => {
    inbound.set('C1', TRACEPARENT);

    const { spans, records } = await exported(decision());

    // Nothing was forwarded, so there is no span — but the event still belongs
    // to the trace the agent is running.
    expect(spans).toHaveLength(0);
    expect(records[0]?.traceId).toBe(TRACE_ID);
  });

  it('hands the minted span back as a traceparent, for the upstream request', async () => {
    inbound.set('C1', TRACEPARENT);
    sink.emit(decision({ action: 'allow' }));

    const injected = sink.traceparentFor('C1');
    const { spans } = await exported(call());

    // What the wrapped server is told, and what the collector is told, are the
    // same span: the guarded server's work hangs beneath ours.
    expect(injected).toBe(`00-${TRACE_ID}-${String(spans[0]?.spanId)}-01`);
  });

  it('has no traceparent for a call it never minted a span for', async () => {
    // Which is every call when telemetry is off — there is no sink at all then
    // — and any call whose context has already been consumed or evicted.
    expect(sink.traceparentFor('never-seen')).toBeUndefined();

    sink.emit(decision({ action: 'allow' }));
    sink.emit(call());

    expect(sink.traceparentFor('C1')).toBeUndefined();
  });

  it('keeps the call context map bounded', async () => {
    const small = new OtlpTelemetrySink({ exporter, capacity: 2 });
    for (const callId of ['a', 'b', 'c']) small.emit(decision({ callId, action: 'deny' }));
    // The first call's context was evicted, so its completion mints a new one
    // rather than growing the map for the length of the wrap.
    small.emit(call({ callId: 'a' }));
    await exporter.flush();

    expect(sent.spans).toHaveLength(1);
  });
});

describe('a decision', () => {
  it('is not exported when it was a plain allow', async () => {
    const { records } = await exported(decision({ action: 'allow' }));

    expect(records).toHaveLength(0);
  });

  it('is exported with its action, rule and codes when it was not', async () => {
    const { records } = await exported(
      decision({ action: 'deny', matchedRule: 'tools[2]', codes: ['POLICY_DENY', 'BREAKER_OPEN'] }),
    );

    expect(records[0]?.eventName).toBe('tunedness.policy_decision');
    expect(attribute(records[0], 'tunedness.decision.action')).toEqual({ stringValue: 'deny' });
    expect(attribute(records[0], 'tunedness.decision.rule')).toEqual({ stringValue: 'tools[2]' });
    expect(attribute(records[0], 'tunedness.decision.codes')).toEqual({
      arrayValue: { values: [{ stringValue: 'POLICY_DENY' }, { stringValue: 'BREAKER_OPEN' }] },
    });
  });

  it('carries the warn-mode verdict, which is the number an operator watches', async () => {
    const { records } = await exported(
      decision({ action: 'warn', mode: 'warn', wouldTrip: true, codes: ['LOOP_CYCLE'] }),
    );

    expect(attribute(records[0], 'tunedness.decision.mode')).toEqual({ stringValue: 'warn' });
    expect(attribute(records[0], 'tunedness.decision.would_trip')).toEqual({ boolValue: true });
  });

  it('omits the rule it did not match', async () => {
    const { records } = await exported(decision());

    expect(keys(records[0])).not.toContain('tunedness.decision.rule');
  });

  it('reports a hook that threw, because a contained error is still an error', async () => {
    const { records } = await exported(decision({ hookError: 'hook blew up' }));

    expect(attribute(records[0], 'tunedness.decision.hook_error')).toEqual({
      stringValue: 'hook blew up',
    });
  });
});

describe('a budget crossing', () => {
  it('names the dimension the way ADR-007 insists', async () => {
    const { records } = await exported(
      {
        type: 'budget_event',
        timestamp: 1_700_000_000_000,
        sessionId: 'S1',
        dimension: 'tokens',
        ratio: 0.8,
        value: 80,
        limit: 100,
        action: 'warn',
      },
      {
        type: 'budget_event',
        timestamp: 1_700_000_000_000,
        sessionId: 'S1',
        dimension: 'usd',
        ratio: 1,
        value: 5,
        limit: 5,
        action: 'deny',
      },
    );

    expect(records.map((entry) => attribute(entry, 'tunedness.budget.dimension'))).toEqual([
      { stringValue: 'tokens_estimated' },
      { stringValue: 'usd_estimated' },
    ]);
    expect(attribute(records[0], 'tunedness.budget.ratio')).toEqual({ doubleValue: 0.8 });
    expect(attribute(records[0], 'tunedness.budget.action')).toEqual({ stringValue: 'warn' });
    // A ratio of exactly 1 is still a double.
    expect(attribute(records[1], 'tunedness.budget.ratio')).toEqual({ doubleValue: 1 });
  });

  it('belongs to a session rather than to a span', async () => {
    const { records } = await exported({
      type: 'budget_event',
      timestamp: 1_700_000_000_000,
      sessionId: 'S1',
      dimension: 'calls',
      ratio: 0.5,
      value: 5,
      limit: 10,
      action: 'warn',
    });

    expect(records[0]).not.toHaveProperty('traceId');
    expect(attribute(records[0], 'tunedness.session_id')).toEqual({ stringValue: 'S1' });
  });
});

describe('a loop detection', () => {
  it('records a warn-mode firing as not enforced', async () => {
    const { records } = await exported({
      type: 'loop_detection',
      timestamp: 1_700_000_000_000,
      sessionId: 'S1',
      code: 'LOOP_EXACT_REPEAT',
      threshold: 3,
      enforced: false,
      callIds: ['C1', 'C2', 'C3'],
    });

    expect(records[0]?.eventName).toBe('tunedness.loop_detection');
    expect(attribute(records[0], 'tunedness.loop.enforced')).toEqual({ boolValue: false });
    expect(attribute(records[0], 'tunedness.loop.threshold')).toEqual({ doubleValue: 3 });
    expect(attribute(records[0], 'tunedness.loop.call_ids')).toEqual({
      arrayValue: {
        values: [{ stringValue: 'C1' }, { stringValue: 'C2' }, { stringValue: 'C3' }],
      },
    });
    // Only the semantic rule has a score; a deterministic one must not claim one.
    expect(keys(records[0])).not.toContain('tunedness.loop.window_score');
  });

  it('carries the window score of a semantic trip', async () => {
    const { records } = await exported({
      type: 'loop_detection',
      timestamp: 1_700_000_000_000,
      sessionId: 'S1',
      code: 'LOOP_SEMANTIC',
      windowScore: 0.91,
      threshold: 0.83,
      enforced: true,
      callIds: ['C1'],
    });

    expect(attribute(records[0], 'tunedness.loop.window_score')).toEqual({ doubleValue: 0.91 });
  });
});

describe('approvals, inside the four-type contract', () => {
  it('lands on the decision they gated, wait included', async () => {
    let clock = 1_000;
    const timed = new OtlpTelemetrySink({ exporter, now: () => clock });
    timed.observeDiagnostic('approval_pending', { approvalId: 'A1', sessionId: 'S1' });
    clock = 3_500;
    timed.observeDiagnostic('approval_resolved', {
      approvalId: 'A1',
      sessionId: 'S1',
      verdict: 'approved',
      source: 'cli',
      reason: 'looks fine to me',
    });
    // An approved call's decision is an `allow`; it is exported anyway.
    timed.emit(decision({ action: 'allow' }));
    await exporter.flush();

    const [record] = sent.records;
    expect(attribute(record, 'tunedness.approval.verdict')).toEqual({ stringValue: 'approved' });
    expect(attribute(record, 'tunedness.approval.source')).toEqual({ stringValue: 'cli' });
    expect(attribute(record, 'tunedness.approval.wait_ms')).toEqual({ intValue: '2500' });
  });

  it('measures a webhook approval from the POST that asked', async () => {
    let clock = 0;
    const timed = new OtlpTelemetrySink({ exporter, now: () => clock });
    timed.observeDiagnostic('approval_posted', { approvalId: 'A1', sessionId: 'S1' });
    clock = 120;
    timed.observeDiagnostic('approval_resolved', {
      approvalId: 'A1',
      sessionId: 'S1',
      verdict: 'denied',
      source: 'webhook',
    });
    timed.emit(decision({ action: 'deny' }));
    await exporter.flush();

    expect(attribute(sent.records[0], 'tunedness.approval.wait_ms')).toEqual({ intValue: '120' });
  });

  it('carries nothing from the diagnostic but the verdict, the source and the wait', async () => {
    sink.observeDiagnostic('approval_pending', {
      approvalId: 'A1',
      sessionId: 'S1',
      // Not that any diagnostic carries a secret — phase 7 only ever writes
      // `secretEnv`, the variable's name — but nothing here copies a field it
      // was not asked for either.
      secret: 'hunter2',
      secretEnv: 'AGENTFUSE_WEBHOOK_SECRET',
      socket: '/tmp/agentfuse/approvals.sock',
    });
    sink.observeDiagnostic('approval_resolved', {
      approvalId: 'A1',
      sessionId: 'S1',
      verdict: 'denied',
      source: 'cli',
      reason: 'no, and here is a secret: hunter2',
    });
    const { records } = await exported(decision());

    const encoded = JSON.stringify(records);
    expect(encoded).not.toContain('hunter2');
    expect(encoded).not.toContain('approvals.sock');
    expect(encoded).not.toContain('here is a secret');
    expect(keys(records[0]).filter((key) => key.startsWith('tunedness.approval'))).toEqual([
      'tunedness.approval.verdict',
      'tunedness.approval.source',
      'tunedness.approval.wait_ms',
    ]);
  });

  it('ignores every other diagnostic on the stream', async () => {
    sink.observeDiagnostic('wrap_end', { reason: 'agent-closed' });
    sink.observeDiagnostic('approval_socket_open', { path: '/tmp/x.sock' });
    sink.observeDiagnostic('approval_pending', { sessionId: 'S1' });
    sink.observeDiagnostic('approval_resolved', { approvalId: 'A2', sessionId: 'S1' });
    const { records } = await exported(decision());

    expect(records).toHaveLength(1);
    expect(keys(records[0]).some((key) => key.startsWith('tunedness.approval'))).toBe(false);
  });

  it('reports a resolution it never saw asked as a zero wait rather than a negative one', async () => {
    sink.observeDiagnostic('approval_resolved', {
      approvalId: 'A9',
      sessionId: 'S1',
      verdict: 'timeout',
      source: 'timeout',
    });
    const { records } = await exported(decision({ action: 'deny' }));

    expect(attribute(records[0], 'tunedness.approval.wait_ms')).toEqual({ intValue: '0' });
    expect(attribute(records[0], 'tunedness.approval.source')).toEqual({ stringValue: 'timeout' });
  });

  it('attaches a resolution once, to the next decision of its session', async () => {
    sink.observeDiagnostic('approval_pending', { approvalId: 'A1', sessionId: 'S1' });
    sink.observeDiagnostic('approval_resolved', {
      approvalId: 'A1',
      sessionId: 'S1',
      verdict: 'approved',
      source: 'cli',
    });
    const { records } = await exported(
      decision({ action: 'allow', callId: 'C1' }),
      decision({ action: 'allow', callId: 'C2' }),
    );

    expect(records).toHaveLength(1);
    expect(attribute(records[0], 'tunedness.call.id')).toEqual({ stringValue: 'C1' });
  });

  it('defaults an unnamed source rather than dropping the measurement', async () => {
    sink.observeDiagnostic('approval_resolved', {
      approvalId: 'A1',
      sessionId: 'S1',
      verdict: 'approved',
    });
    const { records } = await exported(decision({ action: 'allow' }));

    expect(attribute(records[0], 'tunedness.approval.source')).toEqual({ stringValue: 'unknown' });
  });
});

describe('shutdown', () => {
  it('flushes the exporter and forgets what it was holding', async () => {
    sink.emit(call());
    await sink.shutdown();

    expect(sent.spans).toHaveLength(1);
    expect(exporter.stats.exported).toBe(2);
  });
});
