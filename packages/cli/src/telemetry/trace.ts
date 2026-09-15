/**
 * W3C trace context, parsed and minted by hand.
 *
 * ADR-010 again: the OTel context API would arrive with a 13 MB dependency
 * tree, and what AgentFuse needs from it is one 55-character string.
 *
 * ## The rule that decides the shape of this file
 *
 * **AgentFuse never fabricates a `traceparent` on the wire.** The proxy copies
 * `traceparent`, `tracestate` and `baggage` from the agent's `_meta` (SEP-414)
 * onto the request it forwards and invents none of them; a synthesised one
 * would graft a made-up span onto somebody's real trace, which is worse than no
 * trace at all. This module is the reading side of the same rule: an inbound
 * header that does not parse is treated as absent rather than repaired.
 *
 * What we *do* mint is the identity of our own span. With an inbound context
 * the span is a child of the agent's; without one it is the root of a trace
 * that starts here and carries no parent. In that case calls no longer share a
 * trace id, and the correlation key is `tunedness.session_id` — which every
 * span and every event carries anyway.
 *
 * {@link formatTraceparent} does put that minted identity back on the wire, on
 * the request the proxy forwards to the guarded server, so the server's work
 * hangs beneath our span instead of beside it. That is not fabrication: the
 * string names a span this process exports. The rule above still holds in full
 * — with telemetry off there is no span to name and nothing is written.
 */

import { randomBytes } from 'node:crypto';

/** 32 lowercase hex characters. */
const TRACE_ID = /^[0-9a-f]{32}$/;
/** 16 lowercase hex characters. */
const SPAN_ID = /^[0-9a-f]{16}$/;
/** Two lowercase hex characters. */
const HEX_BYTE = /^[0-9a-f]{2}$/;

const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

/**
 * How much `tracestate` we are willing to carry.
 *
 * The specification caps a list at 32 members and asks implementations to drop
 * the rest; a byte cap is the cheap version of the same protection against a
 * header that grew without limit upstream.
 */
const MAX_TRACESTATE = 512;

/** An inbound W3C trace context. */
export interface TraceContext {
  /** 32 hex characters, never all zeros. */
  readonly traceId: string;
  /** 16 hex characters, never all zeros. */
  readonly spanId: string;
  /** Two hex characters. Bit 0 is `sampled`. */
  readonly flags: string;
  /** The `tracestate` that travelled with it, when there was one. */
  readonly tracestate?: string | undefined;
}

/** The identity of a span we are about to export. */
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  /** Absent when the span is the root of its trace. */
  readonly parentSpanId?: string | undefined;
  readonly flags: string;
  readonly tracestate?: string | undefined;
}

/** Source of randomness. A parameter so ids are deterministic under test. */
export type RandomBytes = (size: number) => Uint8Array;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Parses a `traceparent`.
 *
 * Returns `undefined` for anything the specification calls invalid: the wrong
 * shape, uppercase hex, the forbidden `ff` version, an all-zero trace or span
 * id. A future version (`01` and up) is accepted with its extra
 * hyphen-delimited fields ignored, which is exactly what the specification asks
 * of a receiver that does not understand them — refusing would make AgentFuse
 * the component that breaks tracing on the day the format grows.
 */
export function parseTraceparent(
  value: string | undefined,
  tracestate?: string | undefined,
): TraceContext | undefined {
  if (value === undefined) return undefined;
  const fields = value.split('-');
  if (fields.length < 4) return undefined;
  const [version, traceId, spanId, flags] = fields;
  if (version === undefined || !HEX_BYTE.test(version) || version === 'ff') return undefined;
  // Version `00` is exactly four fields; later versions may carry more, and
  // only they may.
  if (version === '00' && fields.length !== 4) return undefined;
  if (traceId === undefined || !TRACE_ID.test(traceId) || traceId === INVALID_TRACE_ID) {
    return undefined;
  }
  if (spanId === undefined || !SPAN_ID.test(spanId) || spanId === INVALID_SPAN_ID) return undefined;
  if (flags === undefined || !HEX_BYTE.test(flags)) return undefined;

  return {
    traceId,
    spanId,
    flags,
    ...(tracestate !== undefined && tracestate !== ''
      ? { tracestate: tracestate.slice(0, MAX_TRACESTATE) }
      : undefined),
  };
}

/** Renders a context back onto the wire, always as version `00`. */
export function formatTraceparent(context: {
  readonly traceId: string;
  readonly spanId: string;
  readonly flags: string;
}): string {
  return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

/**
 * The identity of a span for one tool call.
 *
 * With a parent: same trace, our own fresh span id, the parent's id recorded,
 * and the parent's flags carried through unchanged so a backend reassembling
 * the trace sees one consistent sampling decision.
 *
 * The flags are propagated but **not obeyed**: AgentFuse exports the span
 * either way. This telemetry is the record of what a breaker allowed and
 * refused, and letting somebody else's head sampler decide that a blocked call
 * goes unrecorded would put a hole in an audit trail to save a few bytes.
 *
 * Without a parent: a fresh trace id and no parent span id. Nothing is written
 * back onto the wire in this case; see the module doc.
 */
export function spanContextFor(
  parent: TraceContext | undefined,
  random: RandomBytes = randomBytes,
): SpanContext {
  const spanId = hex(random(8));
  if (parent === undefined) return { traceId: hex(random(16)), spanId, flags: '01' };
  return {
    traceId: parent.traceId,
    spanId,
    parentSpanId: parent.spanId,
    flags: parent.flags,
    ...(parent.tracestate !== undefined ? { tracestate: parent.tracestate } : undefined),
  };
}
