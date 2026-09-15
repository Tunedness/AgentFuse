import { describe, expect, it } from 'vitest';
import {
  anyValue,
  attributes,
  bool,
  double,
  int,
  logsRequest,
  type OtlpLogRecord,
  type OtlpSpan,
  SEVERITY_INFO,
  SPAN_KIND_CLIENT,
  STATUS_CODE_ERROR,
  signalUrl,
  str,
  strings,
  traceRequest,
  unixNano,
} from './otlp.js';

/**
 * The encoding ADR-010 made ours.
 *
 * These are the unit-level assertions; `exporter.test.ts` puts the same payload
 * through a real socket into an in-process receiver and checks it field by
 * field from the other side. Both exist because the format is only correct if
 * it is correct in the bytes, and neither a shape test nor a smoke test alone
 * would show that.
 */

describe('anyValue', () => {
  it('tags each type the way proto3 JSON does', () => {
    expect(anyValue(str('x'))).toEqual({ stringValue: 'x' });
    expect(anyValue(bool(false))).toEqual({ boolValue: false });
    expect(anyValue(double(0.5))).toEqual({ doubleValue: 0.5 });
    expect(anyValue(strings(['a', 'b']))).toEqual({
      arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] },
    });
  });

  it('writes integers as strings, because they are int64 on the wire', () => {
    expect(anyValue(int(42))).toEqual({ intValue: '42' });
    expect(anyValue(int(0))).toEqual({ intValue: '0' });
  });

  it('keeps a whole-numbered double a double', () => {
    // A ratio of exactly 1 must not arrive as an int on the call where the
    // budget was hit and as a double on every other one.
    expect(anyValue(double(1))).toEqual({ doubleValue: 1 });
  });

  it('rounds an int rather than emitting a fraction inside a string', () => {
    expect(anyValue(int(1.6))).toEqual({ intValue: '2' });
  });
});

describe('attributes', () => {
  it('drops the keys with no value instead of writing null', () => {
    const encoded = attributes({
      'tunedness.a': str('yes'),
      'tunedness.b': undefined,
    });

    expect(encoded).toEqual([{ key: 'tunedness.a', value: { stringValue: 'yes' } }]);
  });

  it('preserves the declared order', () => {
    const encoded = attributes({ z: str('1'), a: str('2') });

    expect(encoded.map((entry) => entry.key)).toEqual(['z', 'a']);
  });
});

describe('unixNano', () => {
  it('goes through BigInt, so the last nanoseconds are not rounded away', () => {
    // 1.7e12 ms × 1e6 is about 1.7e18, well past Number.MAX_SAFE_INTEGER, so
    // the naive product is no longer an integer the runtime can represent —
    // which is why this goes through BigInt rather than through `*`.
    expect(Number.isSafeInteger(1_758_000_000_123 * 1_000_000)).toBe(false);
    expect(unixNano(1_758_000_000_123)).toBe((1_758_000_000_123n * 1_000_000n).toString());
    expect(unixNano(1_758_000_000_123)).toBe('1758000000123000000');
  });

  it('answers zero for a time that cannot exist', () => {
    expect(unixNano(Number.NaN)).toBe('0');
    expect(unixNano(-1)).toBe('0');
  });
});

const RESOURCE = { attributes: attributes({ 'service.name': str('agentfuse') }) };
const SCOPE = { name: 'agentfuse', version: '0.0.0' };

const SPAN: OtlpSpan = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name: 'mcp.tools/call',
  kind: SPAN_KIND_CLIENT,
  startTimeUnixNano: unixNano(1_000),
  endTimeUnixNano: unixNano(1_050),
  attributes: attributes({ 'tunedness.tool.name': str('echo') }),
  status: { code: STATUS_CODE_ERROR },
};

const LOG: OtlpLogRecord = {
  timeUnixNano: unixNano(1_050),
  observedTimeUnixNano: unixNano(1_050),
  severityNumber: SEVERITY_INFO,
  severityText: 'INFO',
  eventName: 'tunedness.tool_call',
  attributes: attributes({ 'tunedness.session_id': str('s1') }),
};

describe('the request envelopes', () => {
  it('nests spans as resourceSpans → scopeSpans → spans', () => {
    expect(traceRequest(RESOURCE, SCOPE, [SPAN])).toEqual({
      resourceSpans: [
        {
          resource: RESOURCE,
          scopeSpans: [{ scope: SCOPE, spans: [SPAN] }],
        },
      ],
    });
  });

  it('nests log records as resourceLogs → scopeLogs → logRecords', () => {
    expect(logsRequest(RESOURCE, SCOPE, [LOG])).toEqual({
      resourceLogs: [
        {
          resource: RESOURCE,
          scopeLogs: [{ scope: SCOPE, logRecords: [LOG] }],
        },
      ],
    });
  });

  it('survives JSON.stringify with the ids still hex', () => {
    const encoded = JSON.parse(JSON.stringify(traceRequest(RESOURCE, SCOPE, [SPAN]))) as {
      resourceSpans: { scopeSpans: { spans: { traceId: string }[] }[] }[];
    };

    // Not base64: the OTLP JSON mapping overrides proto3's default for these.
    expect(encoded.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.traceId).toBe('a'.repeat(32));
  });
});

describe('signalUrl', () => {
  it('appends the signal path to a base endpoint', () => {
    expect(signalUrl('http://localhost:4318', 'traces')).toBe('http://localhost:4318/v1/traces');
    expect(signalUrl('http://localhost:4318', 'logs')).toBe('http://localhost:4318/v1/logs');
  });

  it('tolerates a trailing slash', () => {
    expect(signalUrl('http://localhost:4318/', 'traces')).toBe('http://localhost:4318/v1/traces');
  });

  it('leaves an endpoint that already names the signal alone', () => {
    // Somebody pasted a full URL out of their vendor's documentation.
    expect(signalUrl('https://otlp.example.com/v1/traces', 'traces')).toBe(
      'https://otlp.example.com/v1/traces',
    );
  });

  it('keeps a base path that is not the signal path', () => {
    expect(signalUrl('https://example.com/otlp', 'logs')).toBe('https://example.com/otlp/v1/logs');
  });
});
