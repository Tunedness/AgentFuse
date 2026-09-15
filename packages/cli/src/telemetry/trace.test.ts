import { describe, expect, it } from 'vitest';
import { formatTraceparent, parseTraceparent, spanContextFor } from './trace.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

/** Deterministic ids, so a span's identity is assertable. */
function fixedBytes(fill: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(fill);
}

describe('parseTraceparent', () => {
  it('reads the W3C example', () => {
    expect(parseTraceparent(TRACEPARENT)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      flags: '01',
    });
  });

  it('carries tracestate alongside it when there is one', () => {
    expect(parseTraceparent(TRACEPARENT, 'vendor=value')?.tracestate).toBe('vendor=value');
  });

  it('caps a tracestate that grew without limit upstream', () => {
    const huge = `vendor=${'x'.repeat(2_000)}`;

    expect(parseTraceparent(TRACEPARENT, huge)?.tracestate?.length).toBe(512);
  });

  it('treats an empty tracestate as none', () => {
    expect(parseTraceparent(TRACEPARENT, '')?.tracestate).toBeUndefined();
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['truncated', `00-${TRACE_ID}-${SPAN_ID}`],
    ['version ff', `ff-${TRACE_ID}-${SPAN_ID}-01`],
    ['uppercase hex', `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${SPAN_ID}-01`],
    ['all-zero span id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
    ['short trace id', `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`],
    ['non-hex flags', `00-${TRACE_ID}-${SPAN_ID}-zz`],
    ['non-hex version', `zz-${TRACE_ID}-${SPAN_ID}-01`],
    ['version 00 with extra fields', `00-${TRACE_ID}-${SPAN_ID}-01-extra`],
    ['nonsense', 'not a traceparent'],
  ])('treats %s as absent rather than repairing it', (_name, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });

  it('accepts a future version and ignores the fields it does not know', () => {
    // The specification asks a receiver to do exactly this. Refusing would make
    // AgentFuse the thing that breaks tracing the day the format grows.
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-something`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      flags: '01',
    });
  });
});

describe('formatTraceparent', () => {
  it('writes version 00 whatever it read', () => {
    expect(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, flags: '01' })).toBe(
      TRACEPARENT,
    );
  });
});

describe('spanContextFor', () => {
  it('makes a child of an inbound context', () => {
    const parent = parseTraceparent(TRACEPARENT, 'vendor=value');

    expect(spanContextFor(parent, fixedBytes(0xab))).toEqual({
      traceId: TRACE_ID,
      spanId: 'ab'.repeat(8),
      parentSpanId: SPAN_ID,
      flags: '01',
      tracestate: 'vendor=value',
    });
  });

  it('keeps the parent flags rather than re-deciding sampling', () => {
    const parent = parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`);

    expect(spanContextFor(parent, fixedBytes(1)).flags).toBe('00');
  });

  it('roots a trace here when nothing came in, and fabricates no parent', () => {
    const context = spanContextFor(undefined, fixedBytes(0x0c));

    expect(context.parentSpanId).toBeUndefined();
    expect(context.traceId).toBe('0c'.repeat(16));
    expect(context.spanId).toBe('0c'.repeat(8));
  });

  it('mints a different span id every time', () => {
    const parent = parseTraceparent(TRACEPARENT);

    expect(spanContextFor(parent).spanId).not.toBe(spanContextFor(parent).spanId);
  });

  it('mints ids of the lengths the format requires', () => {
    const context = spanContextFor(undefined);

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});
