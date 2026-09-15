/**
 * The OTLP/HTTP JSON encoding, written by hand.
 *
 * ADR-010 is the decision this file implements: the official OpenTelemetry
 * stack is not a dependency. `@opentelemetry/semantic-conventions` alone
 * unpacks to about 12 MB and buys us nothing, because umbrella ADR-003 fixes
 * our attribute names under `tunedness.*` rather than OTel's own conventions;
 * what would be left of the SDK is exporter plumbing and a context API, and at
 * our scale — four event types, one span kind, a W3C `traceparent` string —
 * both are smaller written out than installed. Telemetry is off by default, and
 * inflating what `npx agentfuse` downloads for a feature nobody switched on is
 * the mistake ADR-003 already rejected for `onnxruntime-node`.
 *
 * The price is that the wire format's correctness is ours. Hence this module is
 * pure — no I/O, no clock, no randomness — and `otlp.test.ts` plus the
 * in-process receiver in `exporter.test.ts` check the payload field by field
 * rather than checking that a POST happened.
 *
 * ## What is implemented, and what is deliberately not
 *
 * Implemented: the `ExportTraceServiceRequest` and `ExportLogsServiceRequest`
 * bodies, resource and scope, spans with status, log records with
 * `eventName`, and the `AnyValue` / `KeyValue` attribute encoding.
 *
 * Not implemented, because nothing in AgentFuse produces them: metrics, span
 * events and links, profile signals, `droppedAttributesCount` (we never drop
 * attributes), instrumentation scope attributes, and the `partialSuccess`
 * half of the response — a collector's reply is read for its status code and
 * nothing else. See `exporter.ts`.
 *
 * ## The two encoding rules that are easy to get wrong
 *
 * 1. **64-bit integers are JSON strings.** That is proto3's JSON mapping, not a
 *    stylistic choice, and it matters here: a Unix millisecond timestamp times
 *    a million is about 1.7e18, which is far past `Number.MAX_SAFE_INTEGER`.
 *    Computing it as a `number` silently rounds the last few hundred
 *    nanoseconds away, so {@link unixNano} goes through `BigInt`.
 * 2. **Trace and span ids are hex, not base64.** The OTLP JSON specification
 *    overrides proto3's default `bytes` encoding for exactly these fields.
 */

/** A value as OTLP's `AnyValue`, already tagged with the type it will take. */
export type AttributeValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'double'; readonly value: number }
  | { readonly kind: 'strings'; readonly value: readonly string[] };

/**
 * A string attribute.
 *
 * The type is chosen at the mapping site rather than inferred from the runtime
 * value, and that is the point: a ratio of exactly `1` is still a double, and a
 * backend that saw `budget.ratio` arrive as an int on some calls and a double
 * on others would have two columns for one field.
 */
export const str = (value: string): AttributeValue => ({ kind: 'string', value });
/** A boolean attribute. */
export const bool = (value: boolean): AttributeValue => ({ kind: 'bool', value });
/** A 64-bit integer attribute. Encoded as a JSON string, per proto3. */
export const int = (value: number): AttributeValue => ({ kind: 'int', value: Math.round(value) });
/** A floating point attribute. */
export const double = (value: number): AttributeValue => ({ kind: 'double', value });
/** A homogeneous array of strings. */
export const strings = (value: readonly string[]): AttributeValue => ({ kind: 'strings', value });

/** OTLP's `AnyValue`, as it appears in JSON. */
export type AnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly arrayValue: { readonly values: AnyValue[] } };

/** OTLP's `KeyValue`. */
export interface KeyValue {
  readonly key: string;
  readonly value: AnyValue;
}

/** Encodes one tagged value. */
export function anyValue(attribute: AttributeValue): AnyValue {
  switch (attribute.kind) {
    case 'string':
      return { stringValue: attribute.value };
    case 'bool':
      return { boolValue: attribute.value };
    case 'int':
      return { intValue: String(attribute.value) };
    case 'double':
      return { doubleValue: attribute.value };
    default:
      return { arrayValue: { values: attribute.value.map((item) => ({ stringValue: item })) } };
  }
}

/**
 * Encodes an attribute bag, dropping the keys that have no value.
 *
 * `undefined` is how an optional attribute says it is absent — `matchedRule` on
 * a decision that matched no rule, `windowScore` on a deterministic loop rule.
 * Emitting `null` instead would give a collector a key whose value is "the
 * absence of a value", which is a different claim.
 */
export function attributes(bag: Record<string, AttributeValue | undefined>): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [key, value] of Object.entries(bag)) {
    if (value === undefined) continue;
    out.push({ key, value: anyValue(value) });
  }
  return out;
}

/**
 * Milliseconds since the epoch as OTLP's nanosecond string.
 *
 * Through `BigInt` deliberately; see the module doc. Negative and non-finite
 * inputs cannot reach here from a `Clock`, but a zero is cheaper than a throw
 * on the telemetry path, which must never be able to break a tool call.
 */
export function unixNano(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '0';
  return (BigInt(Math.round(milliseconds)) * 1_000_000n).toString();
}

/** OTLP's `SpanKind`, restricted to the one kind AgentFuse produces. */
export const SPAN_KIND_CLIENT = 3;

/** OTLP's `StatusCode`. */
export const STATUS_CODE_ERROR = 2;

/** Severity numbers, from the OTLP log data model. */
export const SEVERITY_INFO = 9;
/** @see SEVERITY_INFO */
export const SEVERITY_WARN = 13;

/** One span, in the shape the JSON encoding wants. */
export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: KeyValue[];
  readonly status?: { readonly code: number; readonly message?: string };
}

/** One log record, which is how the four `tunedness.*` events travel. */
export interface OtlpLogRecord {
  readonly timeUnixNano: string;
  readonly observedTimeUnixNano: string;
  readonly severityNumber: number;
  readonly severityText: string;
  /**
   * The event name, e.g. `tunedness.tool_call`.
   *
   * Written twice on purpose: as the `eventName` field, which is where the
   * current log data model puts it, and as an `event.name` attribute, which is
   * where every collector built before that field existed looks. The duplicate
   * costs a few bytes and removes a whole class of "the events arrive but the
   * backend cannot group them" report.
   */
  readonly eventName: string;
  readonly attributes: KeyValue[];
  readonly traceId?: string;
  readonly spanId?: string;
}

/** The resource every payload carries. */
export interface OtlpResource {
  readonly attributes: KeyValue[];
}

/** The instrumentation scope every payload carries. */
export interface OtlpScope {
  readonly name: string;
  readonly version: string;
}

/** `ExportTraceServiceRequest`. */
export function traceRequest(
  resource: OtlpResource,
  scope: OtlpScope,
  spans: readonly OtlpSpan[],
): unknown {
  return { resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] };
}

/** `ExportLogsServiceRequest`. */
export function logsRequest(
  resource: OtlpResource,
  scope: OtlpScope,
  logRecords: readonly OtlpLogRecord[],
): unknown {
  return { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords }] }] };
}

/**
 * The per-signal URL for a base endpoint.
 *
 * The policy's `telemetry.otlp_endpoint` is a base — `http://localhost:4318` —
 * exactly like `OTEL_EXPORTER_OTLP_ENDPOINT`, and the signal path is appended.
 * An endpoint that already names the signal is left alone, because an operator
 * who pasted a full URL from their vendor's documentation meant it.
 */
export function signalUrl(endpoint: string, signal: 'traces' | 'logs'): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith(`/v1/${signal}`) ? base : `${base}/v1/${signal}`;
}
