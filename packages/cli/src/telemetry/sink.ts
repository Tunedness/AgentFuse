/**
 * The `TelemetrySink` that turns engine events into OTLP.
 *
 * Umbrella ADR-003 fixes the schema at **four** event types — `tool_call`,
 * `policy_decision`, `budget_event`, `loop_detection` — under the `tunedness.*`
 * namespace, and core's `FuseEvent` union is exactly those four. A fifth would
 * poison a schema shared with McpGuard, so this file maps and never invents:
 * `security_event` belongs to McpGuard and AgentFuse must never emit it, and
 * phase 3's embedding-queue failures stay in `SemanticLoopStats` and the
 * diagnostics for the same reason.
 *
 * | when | what goes out |
 * | --- | --- |
 * | every forwarded `tools/call` | a `mcp.tools/call` span **and** a `tunedness.tool_call` event |
 * | every decision that is not `allow` | `tunedness.policy_decision` |
 * | 50% / 80% / 100% budget crossings | `tunedness.budget_event` |
 * | any loop rule firing, warn mode included | `tunedness.loop_detection` |
 *
 * Spans go to `/v1/traces`; the four events are OTLP log records with an
 * `eventName`, which is where the log data model puts events, and they go to
 * `/v1/logs`.
 *
 * ## Where a span's identity comes from
 *
 * The proxy reads `traceparent` out of the request's `_meta` (SEP-414) and
 * hands it to `beforeCall`, which keeps it on the in-flight
 * `ToolCallRecord`. That record is reachable from the engine's session store
 * while the call is in flight, which is exactly the window in which
 * `policy_decision` is emitted — so the span's identity is minted **there**,
 * on first sight of the call id, and reused when the call completes. A
 * decision and the call it decided therefore share one span id, and a blocked
 * call still gets its event placed in the agent's trace.
 *
 * With no inbound context the span is the root of a trace that starts here: a
 * fresh trace id and no parent. Calls then no longer share a trace id and the
 * correlation key is `tunedness.session_id`, which every span and every event
 * carries regardless.
 *
 * That identity is also what goes **upstream**. {@link
 * OtlpTelemetrySink.traceparentFor} renders it as a `traceparent` and
 * `runtime.ts` hands it to `ToolCallGuardOptions.traceparentFor`, so the
 * guarded server's own work is a child of this span rather than a sibling of
 * it. Nothing is fabricated by doing so — the string names a span that is
 * already on its way to the collector — and with telemetry off there is no
 * span, no lookup and no override, so the agent's context crosses the proxy
 * exactly as it does today.
 *
 * `tracestate` and `baggage` are forwarded upstream by the proxy but never
 * reach this package — the engine's record carries `traceparent` and nothing
 * else — so an exported span names its parent and no vendor state, and the
 * re-injected `traceparent` travels beside the agent's own `tracestate`.
 *
 * `budget_event` and `loop_detection` carry **no** trace ids. A budget crossing
 * belongs to a session rather than a call, and a loop detection names the
 * window of past calls that produced it (`tunedness.loop.call_ids`); attaching
 * either to the span that happened to be open would be a guess dressed as a
 * link.
 *
 * ## How approvals surface without becoming a fifth type
 *
 * They do not get an event of their own. A human-gated call already arrives as
 * a `policy_decision` — `POLICY_APPROVAL` while it is asked for,
 * `APPROVAL_DENIED` or `APPROVAL_TIMEOUT` when it comes back badly — so what is
 * missing is only the one measurement phase 7 called out: how long the person
 * took. {@link OtlpTelemetrySink.observeDiagnostic} watches the diagnostic
 * stream for the `approval_pending` → `approval_resolved` pair (and
 * `approval_posted` for the webhook channel), and the resulting verdict, source
 * and wait land as attributes on that call's `policy_decision`.
 *
 * One consequence is deliberate and documented: an **approved** call's decision
 * is an `allow`, which the table above would not export. It is exported anyway,
 * because a decision a human was asked about is the one an audit asks about
 * (ADR-009). No other `allow` ever crosses the wire.
 *
 * Exactly three fields of those diagnostics are copied, by name. The webhook
 * secret is not one of them and could not be: the diagnostics carry only
 * `secretEnv`, the variable's *name*, and this reads `verdict`, `source` and
 * the timestamps.
 */

import type { BudgetDimension, FuseEvent, TelemetrySink } from '@agentfuse/core';
import type { OtlpExporter } from './exporter.js';
import {
  attributes,
  bool,
  double,
  int,
  type KeyValue,
  type OtlpLogRecord,
  SEVERITY_INFO,
  SEVERITY_WARN,
  SPAN_KIND_CLIENT,
  STATUS_CODE_ERROR,
  str,
  strings,
  unixNano,
} from './otlp.js';
import {
  formatTraceparent,
  parseTraceparent,
  type RandomBytes,
  type SpanContext,
  spanContextFor,
} from './trace.js';

/** The span name every forwarded tool call gets. */
export const SPAN_NAME = 'mcp.tools/call';

/**
 * The four event names, and the only four.
 *
 * `event-types.test.ts` derives its assertions from this table, so adding a
 * fifth key is a decision that breaks a test rather than a line that slips
 * through review.
 */
export const EVENT_NAMES = {
  tool_call: 'tunedness.tool_call',
  policy_decision: 'tunedness.policy_decision',
  budget_event: 'tunedness.budget_event',
  loop_detection: 'tunedness.loop_detection',
} as const satisfies Record<FuseEvent['type'], string>;

/**
 * Budget dimensions as ADR-007 insists they be named.
 *
 * The proxy cannot see the LLM's tokens; every figure it produces is a floor
 * estimate of tool I/O, and the `_estimated` suffix travels with it — into the
 * schema, the reports and, here, the telemetry.
 */
const DIMENSION_NAMES: Record<BudgetDimension, string> = {
  calls: 'calls',
  duration: 'duration',
  tokens: 'tokens_estimated',
  usd: 'usd_estimated',
};

/**
 * Reads the inbound trace context of a call that is still in flight.
 *
 * Bound by `runtime.ts` to the engine's session store. Returns `undefined` for
 * a call the engine no longer holds, which is not an error: it is what a
 * blocked call looks like once it has been discarded.
 */
export type CallLookup = (sessionId: string, callId: string) => string | undefined;

/** How an {@link OtlpTelemetrySink} is built. */
export interface OtlpTelemetrySinkOptions {
  readonly exporter: OtlpExporter;
  /** Injected for tests. */
  readonly now?: (() => number) | undefined;
  /** Injected for tests. */
  readonly random?: RandomBytes | undefined;
  /** How many in-flight call contexts to remember. Default 1024. */
  readonly capacity?: number | undefined;
}

/** What a resolved approval contributes to the decision it gated. */
interface ApprovalNote {
  readonly verdict: string;
  readonly source: string;
  readonly waitMs: number;
}

const DEFAULT_CAPACITY = 1_024;

/** Reads a string field out of a diagnostic's untyped bag. */
function text(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Maps `FuseEvent`s onto OTLP and hands them to the exporter.
 *
 * `emit` is fire-and-forget by contract: it must not throw and must not block,
 * because it runs inside `beforeCall` and `afterCall`, on the proxy's hot path.
 * Everything here is a few object literals and an array push; the socket work
 * belongs to {@link OtlpExporter} and happens on a timer.
 */
export class OtlpTelemetrySink implements TelemetrySink {
  readonly #exporter: OtlpExporter;
  readonly #now: () => number;
  readonly #random: RandomBytes | undefined;
  readonly #capacity: number;

  /** callId → the span identity minted when the decision was made. */
  readonly #contexts = new Map<string, SpanContext>();
  /** approvalId → when it was asked. */
  readonly #asked = new Map<string, number>();
  /** sessionId → the resolution waiting to be attached to a decision. */
  readonly #resolved = new Map<string, ApprovalNote>();

  #lookup: CallLookup | undefined;

  constructor(options: OtlpTelemetrySinkOptions) {
    this.#exporter = options.exporter;
    this.#now = options.now ?? Date.now;
    this.#random = options.random;
    this.#capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  }

  /**
   * Binds the reader of in-flight calls.
   *
   * Late, and it has to be: the sink is a constructor port of the engine, so it
   * exists first. Same shape as the approval channel's `bindHost`.
   */
  bindCallLookup(lookup: CallLookup): void {
    this.#lookup = lookup;
  }

  emit(event: FuseEvent): void {
    switch (event.type) {
      case 'policy_decision':
        this.#policyDecision(event);
        return;
      case 'tool_call':
        this.#toolCall(event);
        return;
      case 'budget_event':
        this.#budget(event);
        return;
      default:
        this.#loop(event);
    }
  }

  /**
   * Watches the host's diagnostics for the approval pair.
   *
   * Everything else on that stream is ignored on purpose. The four-type
   * contract has no room for `approval_socket_open` or `wrap_end`, and a sink
   * that forwarded whatever it was handed would be inventing types by
   * accident.
   */
  observeDiagnostic(event: string, fields: Record<string, unknown>): void {
    if (event === 'approval_pending' || event === 'approval_posted') {
      const approvalId = text(fields, 'approvalId');
      if (approvalId === undefined) return;
      this.#remember(this.#asked, approvalId, this.#now());
      return;
    }
    if (event !== 'approval_resolved') return;

    const approvalId = text(fields, 'approvalId');
    const sessionId = text(fields, 'sessionId');
    const verdict = text(fields, 'verdict');
    if (approvalId === undefined || sessionId === undefined || verdict === undefined) return;
    const asked = this.#asked.get(approvalId);
    this.#asked.delete(approvalId);
    this.#remember(this.#resolved, sessionId, {
      verdict,
      source: text(fields, 'source') ?? 'unknown',
      waitMs: asked === undefined ? 0 : Math.max(0, this.#now() - asked),
    });
  }

  /**
   * The `traceparent` naming our span for a call, for re-injection upstream.
   *
   * `ToolCallGuardOptions.traceparentFor` is bound to this in `runtime.ts`, so
   * the guarded server's work becomes a child of the proxy's span instead of
   * its sibling. The identity is the one minted for the decision and is
   * therefore already on its way to the collector — nothing is fabricated here,
   * and `undefined` (a call with no span, which is every call when telemetry is
   * off) leaves the agent's own context on the wire untouched.
   */
  traceparentFor(callId: string): string | undefined {
    const context = this.#contexts.get(callId);
    return context === undefined ? undefined : formatTraceparent(context);
  }

  /** Flushes whatever is queued and stops the exporter. */
  async shutdown(): Promise<void> {
    this.#contexts.clear();
    this.#asked.clear();
    this.#resolved.clear();
    await this.#exporter.shutdown();
  }

  // -------------------------------------------------------------------------

  #policyDecision(event: Extract<FuseEvent, { type: 'policy_decision' }>): void {
    const context = this.#context(event.sessionId, event.callId);
    const approval = this.#resolved.get(event.sessionId);
    if (approval !== undefined) this.#resolved.delete(event.sessionId);

    // The table's rule, plus the one documented exception: a call a human was
    // asked about is exported even when they said yes.
    if (event.action === 'allow' && approval === undefined) return;

    this.#log(
      event.timestamp,
      'policy_decision',
      SEVERITY_WARN,
      context,
      attributes({
        'tunedness.session_id': str(event.sessionId),
        'tunedness.call.id': str(event.callId),
        'tunedness.decision.action': str(event.action),
        'tunedness.decision.mode': str(event.mode),
        'tunedness.decision.would_trip': bool(event.wouldTrip),
        'tunedness.decision.rule':
          event.matchedRule === undefined ? undefined : str(event.matchedRule),
        'tunedness.decision.codes': strings(event.codes),
        'tunedness.decision.hook_error':
          event.hookError === undefined ? undefined : str(event.hookError),
        'tunedness.approval.verdict': approval === undefined ? undefined : str(approval.verdict),
        'tunedness.approval.source': approval === undefined ? undefined : str(approval.source),
        'tunedness.approval.wait_ms': approval === undefined ? undefined : int(approval.waitMs),
      }),
    );
  }

  #toolCall(event: Extract<FuseEvent, { type: 'tool_call' }>): void {
    // The decision minted this; a sink attached mid-session mints one now
    // rather than dropping the call.
    const context =
      this.#contexts.get(event.callId) ?? this.#context(event.sessionId, event.callId);
    this.#contexts.delete(event.callId);

    const encoded = attributes({
      'tunedness.session_id': str(event.sessionId),
      'tunedness.call.id': str(event.callId),
      'tunedness.tool.name': str(event.toolName),
      'tunedness.server.name': str(event.serverName),
      'tunedness.call.is_error': bool(event.isError),
      'tunedness.call.duration_ms': int(event.durationMs),
      // ADR-007: the proxy sees tool I/O and nothing else, and says so in the
      // name. Args plus results, which is what a budget meters.
      'tunedness.call.tokens_estimated': int(
        event.tokensEstimated.args + event.tokensEstimated.results,
      ),
      'tunedness.call.error_signature':
        event.errorSignature === undefined ? undefined : str(event.errorSignature),
    });

    this.#exporter.enqueueSpan({
      traceId: context.traceId,
      spanId: context.spanId,
      ...(context.parentSpanId !== undefined ? { parentSpanId: context.parentSpanId } : undefined),
      name: SPAN_NAME,
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: unixNano(event.timestamp - event.durationMs),
      endTimeUnixNano: unixNano(event.timestamp),
      attributes: encoded,
      ...(event.isError ? { status: { code: STATUS_CODE_ERROR } } : undefined),
    });
    this.#log(event.timestamp, 'tool_call', SEVERITY_INFO, context, encoded);
  }

  #budget(event: Extract<FuseEvent, { type: 'budget_event' }>): void {
    this.#log(
      event.timestamp,
      'budget_event',
      SEVERITY_WARN,
      undefined,
      attributes({
        'tunedness.session_id': str(event.sessionId),
        'tunedness.budget.dimension': str(DIMENSION_NAMES[event.dimension]),
        'tunedness.budget.ratio': double(event.ratio),
        'tunedness.budget.value': double(event.value),
        'tunedness.budget.limit': double(event.limit),
        'tunedness.budget.action': str(event.action),
      }),
    );
  }

  #loop(event: Extract<FuseEvent, { type: 'loop_detection' }>): void {
    this.#log(
      event.timestamp,
      'loop_detection',
      SEVERITY_WARN,
      undefined,
      attributes({
        'tunedness.session_id': str(event.sessionId),
        'tunedness.loop.code': str(event.code),
        'tunedness.loop.window_score':
          event.windowScore === undefined ? undefined : double(event.windowScore),
        'tunedness.loop.threshold': double(event.threshold),
        // False in warn mode: the rule fired and the call went through anyway,
        // which is the number an operator watches before turning enforcement on.
        'tunedness.loop.enforced': bool(event.enforced),
        'tunedness.loop.call_ids': strings(event.callIds),
      }),
    );
  }

  /** Builds one log record and queues it. */
  #log(
    timestamp: number,
    type: FuseEvent['type'],
    severity: number,
    context: SpanContext | undefined,
    encoded: KeyValue[],
  ): void {
    const name = EVENT_NAMES[type];
    const record: OtlpLogRecord = {
      timeUnixNano: unixNano(timestamp),
      observedTimeUnixNano: unixNano(this.#now()),
      severityNumber: severity,
      severityText: severity === SEVERITY_INFO ? 'INFO' : 'WARN',
      eventName: name,
      // `event.name` as well as the field: see `OtlpLogRecord.eventName`.
      attributes: [...attributes({ 'event.name': str(name) }), ...encoded],
      ...(context !== undefined ? { traceId: context.traceId, spanId: context.spanId } : undefined),
    };
    this.#exporter.enqueueLog(record);
  }

  /**
   * Mints the span identity for a call and remembers it until the call ends.
   *
   * Called once per call, from the decision — the one moment at which the
   * inbound `traceparent` is still readable. The completion reuses what is
   * remembered and only comes back here when there is nothing to reuse.
   */
  #context(sessionId: string, callId: string): SpanContext {
    const parent = parseTraceparent(this.#lookup?.(sessionId, callId));
    const context = spanContextFor(parent, this.#random);
    this.#remember(this.#contexts, callId, context);
    return context;
  }

  /**
   * Stores a value, dropping the oldest when the map is full.
   *
   * A denied call never completes, so its context is never consumed; without a
   * bound, a session that is being blocked in a tight loop would grow this map
   * for as long as the wrap runs. Same reasoning, and the same oldest-first
   * answer, as the export queue.
   */
  #remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    if (map.size <= this.#capacity) return;
    // One in, so at most one out. The cast is safe by construction: the map is
    // over a capacity of at least one, so it has a first key.
    const [oldest] = map.keys();
    map.delete(oldest as string);
  }
}
