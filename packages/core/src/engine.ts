import { DenyAllApprovalGateway } from './adapters/approval.js';
import { SystemClock } from './adapters/clock.js';
import { InMemorySessionStore } from './adapters/session-store.js';
import { NoopTelemetrySink } from './adapters/telemetry.js';
import { HeuristicTokenizer, TableCostModel } from './adapters/tokenizer.js';
import { UlidGenerator } from './adapters/ulid.js';
import type { BreakerPhase } from './domain/breaker.js';
import type { Decision, DecisionAction, Reason, TripCode } from './domain/decision.js';
import type { CallOutcome, ToolAnnotations, ToolCallRecord } from './domain/records.js';
import type { SessionState, SessionSummary } from './domain/session.js';
import { applyBreakerEvent } from './guards/breaker.js';
import { runGuards } from './guards/pipeline.js';
import type { GuardContext } from './guards/types.js';
import { fingerprint } from './loop/fingerprint.js';
import { argsPreview, normalizeArgs } from './loop/normalize.js';
import { type CompiledPolicy, compilePolicy } from './policy/compile.js';
import { evaluateRules } from './policy/evaluate.js';
import type { FusePolicy } from './policy/schema.js';
import type { Ports } from './ports/index.js';
import { buildTripReport, TOKEN_ESTIMATE_NOTE, type TripReport } from './report/trip-report.js';

/** What the proxy hands the engine before forwarding a call. */
export interface BeforeCallInput {
  sessionId: string;
  serverName: string;
  toolName: string;
  args: unknown;
  /** Untrusted server-supplied hints, if the transport carried any. */
  annotations?: ToolAnnotations;
  /** W3C trace context from the request's `_meta`, if present. */
  traceparent?: string;
}

/** The read-only view of a call handed to an `onDecision` hook. */
export interface HookCallView {
  readonly id: string;
  readonly sessionId: string;
  readonly serverName: string;
  readonly toolName: string;
  /** A frozen deep copy. Mutating it is impossible by construction. */
  readonly args: unknown;
  readonly argsNormalized: string;
  readonly fingerprint: string;
  readonly annotations: ToolAnnotations | undefined;
}

/** The session facts a hook may want. */
export interface HookSessionView {
  readonly sessionId: string;
  readonly calls: number;
  readonly durationMs: number;
  readonly breakerPhase: BreakerPhase;
}

/** What an `onDecision` hook receives. */
export interface DecisionHookContext {
  readonly decision: Decision;
  readonly call: HookCallView;
  readonly session: HookSessionView;
}

/**
 * What a hook may change.
 *
 * ADR-004: the hook can change the **action** and append **reasons**. It cannot
 * touch the arguments. Rewriting an agent's requests is McpGuard's job;
 * AgentFuse decides whether a call happens, never what it says. Returning
 * anything else — including an `args` field — is ignored.
 */
export interface DecisionHookResult {
  action?: DecisionAction;
  reasons?: Reason[];
}

/**
 * ADR-004's single programmatic escape hatch.
 *
 * The `void` in the return union is deliberate: a hook that only observes is
 * written with a plain statement body and returns nothing, and narrowing this
 * to `undefined` would force every such hook to end in `return undefined;`.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: observer hooks return nothing; see the doc above.
export type DecisionHook = (ctx: DecisionHookContext) => DecisionHookResult | undefined | void;

/**
 * Notified after every completed call.
 *
 * **This is the seam phase 3 plugs the embedding queue into.** The semantic
 * scorer subscribes here, enqueues the record, scores it off the hot path, and
 * writes its verdict back with {@link FuseEngine.markPendingTrip} for the next
 * `beforeCall` to act on. Nothing in phase 2 subscribes.
 */
export type RecordCompleteListener = (record: ToolCallRecord, session: SessionState) => void;

const VALID_ACTIONS = new Set<DecisionAction>(['allow', 'warn', 'deny', 'require_approval']);

const encoder = new TextEncoder();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** A frozen deep copy, falling back to the original when cloning is impossible. */
function frozenCopy(value: unknown): unknown {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return value;
  }
}

/**
 * The decision engine.
 *
 * Pure: no file system, no network, no protocol. Time, identity, persistence,
 * approval, tokenisation, pricing and telemetry all arrive through {@link Ports}
 * so the whole thing is deterministic under a fake clock and a counter-based id
 * generator. That is what makes the in-process SDK mode possible, and what will
 * let McpGuard reuse the same engine.
 */
export class FuseEngine {
  readonly #policy: CompiledPolicy;
  readonly #ports: Ports;
  readonly #hooks: DecisionHook[] = [];
  readonly #recordListeners: RecordCompleteListener[] = [];
  /** callId → owning session, so `afterCall` needs only the call id. */
  readonly #callIndex = new Map<string, SessionState>();

  constructor(policy: FusePolicy, ports: Partial<Ports> = {}) {
    this.#policy = compilePolicy(policy);
    const clock = ports.clock ?? new SystemClock();
    this.#ports = {
      clock,
      ids: ports.ids ?? new UlidGenerator(clock),
      sessions: ports.sessions ?? new InMemorySessionStore(),
      // Fails closed: with no gateway configured there is no way to obtain
      // consent, and synthesising it would be the worst possible default.
      approvals: ports.approvals ?? new DenyAllApprovalGateway(),
      // Off unless opted in, per umbrella ADR-003.
      telemetry: ports.telemetry ?? new NoopTelemetrySink(),
      tokenizer: ports.tokenizer ?? new HeuristicTokenizer(),
      cost:
        ports.cost ??
        new TableCostModel({
          inputPerMTokUsd: policy.pricing.input_per_mtok_usd,
          outputPerMTokUsd: policy.pricing.output_per_mtok_usd,
        }),
    };
  }

  /** The compiled policy this engine was built with. */
  get policy(): CompiledPolicy {
    return this.#policy;
  }

  /** The ports in use, including the defaults that were filled in. */
  get ports(): Readonly<Ports> {
    return this.#ports;
  }

  /** Registers an escape-hatch hook. Hooks run in registration order. */
  onDecision(hook: DecisionHook): void {
    this.#hooks.push(hook);
  }

  /** Registers a completed-call listener. See {@link RecordCompleteListener}. */
  onRecordComplete(listener: RecordCompleteListener): void {
    this.#recordListeners.push(listener);
  }

  /**
   * Leaves a verdict for the next call in a session.
   *
   * The supported way for an out-of-band detector — phase 3's semantic scorer —
   * to trip the breaker without blocking the hot path. A pending trip already
   * waiting is not overwritten: the first verdict is the one that matters.
   */
  markPendingTrip(sessionId: string, reason: Reason): void {
    const session = this.#ports.sessions.get(sessionId);
    if (!session) return;
    session.pendingTrip ??= reason;
  }

  /** Records that the semantic layer is sampling rather than scoring every call. */
  markDegraded(sessionId: string): void {
    const session = this.#ports.sessions.get(sessionId);
    if (session) session.degraded = 'sampled';
  }

  /**
   * Decides what to do with a call.
   *
   * Returns a promise only because of the human approval await — every guard
   * itself is synchronous, and the common path resolves without yielding to a
   * microtask queue more than once.
   */
  async beforeCall(input: BeforeCallInput): Promise<Decision> {
    const { clock, ids, sessions, telemetry } = this.#ports;
    const now = clock.now();
    const session = sessions.get(input.sessionId) ?? sessions.create(input.sessionId, now);
    sessions.touch(session, now);

    const callId = ids.next();
    const argsNormalized = normalizeArgs(input.args, now);
    const record: ToolCallRecord = {
      id: callId,
      sessionId: input.sessionId,
      serverName: input.serverName,
      toolName: input.toolName,
      args: input.args,
      argsNormalized,
      fingerprint: fingerprint(input.serverName, input.toolName, argsNormalized),
      startedAt: now,
      ...(input.annotations !== undefined ? { annotations: input.annotations } : undefined),
      ...(input.traceparent !== undefined ? { traceparent: input.traceparent } : undefined),
    };
    session.inFlight.set(callId, record);
    this.#callIndex.set(callId, session);

    const evaluation = evaluateRules(this.#policy, input.serverName, input.toolName);
    const mode = this.#policy.policy.mode;
    const ctx: GuardContext = {
      policy: this.#policy,
      mode,
      session,
      record,
      evaluation,
      clock,
      now,
      telemetry,
    };

    const state = runGuards(ctx);
    let enforceAction = state.action;

    if (enforceAction === 'require_approval' && mode === 'enforce') {
      enforceAction = await this.#resolveApproval(ctx, state.reasons);
    } else if (mode === 'warn' && session.breaker.phase === 'half_open' && !state.trip) {
      // Warn mode never asks a human, but the breaker still has to be able to
      // recover: a call that was forwarded without re-tripping is the warn-mode
      // equivalent of an approved probe.
      this.#recordProbe(session, evaluation.loop.cooldown.calls);
    }

    const wouldTrip =
      mode === 'warn' && (enforceAction === 'deny' || enforceAction === 'require_approval');
    const action: DecisionAction = wouldTrip ? 'warn' : enforceAction;

    let report: TripReport | undefined;
    if (state.trip) {
      report = buildTripReport({
        tripId: ids.next(),
        policy: this.#policy,
        session,
        current: record,
        trigger: state.trip,
        loop: evaluation.loop,
        now,
      });
    }

    const decision: Decision = {
      action,
      reasons: state.reasons,
      wouldTrip,
      callId,
      ...(state.matchedRule !== undefined ? { matchedRule: state.matchedRule } : undefined),
      ...(report !== undefined ? { report } : undefined),
    };

    const final = this.#applyHooks(decision, record, session);

    telemetry.emit({
      type: 'policy_decision',
      timestamp: now,
      sessionId: session.sessionId,
      callId,
      action: final.decision.action,
      mode,
      wouldTrip: final.decision.wouldTrip,
      codes: final.decision.reasons.map((r): TripCode => r.code),
      ...(state.matchedRule !== undefined ? { matchedRule: state.matchedRule } : undefined),
      ...(final.hookError !== undefined ? { hookError: final.hookError } : undefined),
    });

    // A call the engine refused never happened, so it must not linger as
    // in-flight state waiting for an `afterCall` that will never come.
    if (final.decision.action === 'deny') {
      session.inFlight.delete(callId);
      this.#callIndex.delete(callId);
    }

    return final.decision;
  }

  /**
   * Records the outcome of a call and folds it into the session.
   *
   * Synchronous, and safe to call for an unknown id — a proxy may see a
   * response for a call the engine already discarded.
   */
  afterCall(callId: string, outcome: CallOutcome): void {
    const session = this.#callIndex.get(callId);
    if (!session) return;
    this.#callIndex.delete(callId);
    const record = session.inFlight.get(callId);
    if (!record) return;
    session.inFlight.delete(callId);

    const { clock, sessions, telemetry, tokenizer, cost } = this.#ports;
    const now = clock.now();
    record.endedAt = now;
    record.outcome = outcome;

    const argsTokens = tokenizer.count(record.argsNormalized);
    const resultTokens = this.#estimateResultTokens(outcome);
    record.tokensEstimated = { argsTokens, resultTokens };

    const counters = session.counters;
    counters.calls += 1;
    counters.argsTokens += argsTokens;
    counters.resultTokens += resultTokens;
    counters.tokensEstimated += argsTokens + resultTokens;
    counters.usdEstimated += cost.estimateUsd({ input: argsTokens, output: resultTokens });
    if (outcome.isError) session.errorCalls += 1;

    sessions.touch(session, now);

    session.window.push(record);
    while (session.window.length > this.#policy.windowCapacity) session.window.shift();

    telemetry.emit({
      type: 'tool_call',
      timestamp: now,
      sessionId: session.sessionId,
      callId,
      serverName: record.serverName,
      toolName: record.toolName,
      isError: outcome.isError,
      durationMs: now - record.startedAt,
      tokensEstimated: { args: argsTokens, results: resultTokens },
      ...(outcome.errorSignature !== undefined
        ? { errorSignature: outcome.errorSignature }
        : undefined),
    });

    // Phase 3's embedding queue subscribes here.
    for (const listener of this.#recordListeners) listener(record, session);
  }

  /**
   * Closes a session and returns its totals.
   *
   * An unknown session yields a zeroed summary rather than throwing: a
   * transport can close at the same moment an idle sweep drops the session, and
   * that race is not the caller's problem.
   */
  endSession(sessionId: string): SessionSummary {
    const { sessions, clock } = this.#ports;
    const now = clock.now();
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        sessionId,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        calls: 0,
        errorCalls: 0,
        tokensEstimated: { args: 0, results: 0, total: 0, note: TOKEN_ESTIMATE_NOTE },
        usdEstimated: 0,
        breakerPhase: 'closed',
        trips: [],
        degraded: false,
      };
    }

    this.#abortApprovals(session);
    for (const callId of session.inFlight.keys()) this.#callIndex.delete(callId);
    sessions.delete(sessionId);

    const counters = session.counters;
    return {
      sessionId,
      startedAt: session.startedAt,
      endedAt: now,
      durationMs: now - session.startedAt,
      calls: counters.calls,
      errorCalls: session.errorCalls,
      tokensEstimated: {
        args: counters.argsTokens,
        results: counters.resultTokens,
        total: counters.tokensEstimated,
        note: TOKEN_ESTIMATE_NOTE,
      },
      usdEstimated: counters.usdEstimated,
      breakerPhase: session.breaker.phase,
      trips: [...session.trips],
      degraded: session.degraded !== undefined,
    };
  }

  /**
   * Closes the breaker by operator action — what `agentfuse approve --reset`
   * calls. Drops the loop window, because the history that tripped it would
   * simply trip it again. Budget counters survive: a budget is a cumulative
   * fact, not a fault to recover from.
   */
  resetBreaker(sessionId: string): void {
    const session = this.#ports.sessions.get(sessionId);
    if (!session) return;
    const transition = applyBreakerEvent(session.breaker, { kind: 'reset' });
    if (transition.clearWindow) session.window.length = 0;
    delete session.pendingTrip;
    this.#abortApprovals(session);
  }

  /** Drops sessions idle beyond `session.idle_timeout`. Returns the ids dropped. */
  sweepIdleSessions(): string[] {
    const { sessions, clock } = this.#ports;
    const dropped = sessions.sweepIdle(this.#policy.policy.session.idle_timeout, clock.now());
    if (dropped.length === 0) return dropped;
    const gone = new Set(dropped);
    for (const [callId, session] of this.#callIndex) {
      if (gone.has(session.sessionId)) this.#callIndex.delete(callId);
    }
    return dropped;
  }

  // -------------------------------------------------------------------------

  async #resolveApproval(ctx: GuardContext, reasons: Reason[]): Promise<DecisionAction> {
    const { approvals, ids } = this.#ports;
    const { session, evaluation, record } = ctx;
    const config = this.#policy.policy.approvals;

    const controller = new AbortController();
    session.pendingApprovals.add(controller);
    let verdict: 'approved' | 'denied' | 'timeout';
    try {
      verdict = await approvals.requestApproval(
        {
          approvalId: ids.next(),
          sessionId: session.sessionId,
          toolName: record.toolName,
          serverName: record.serverName,
          argsPreview: this.#policy.policy.report.redact_args
            ? record.fingerprint
            : argsPreview(record.args),
          reasons: [...reasons],
          timeoutMs: config.timeout,
        },
        controller.signal,
      );
    } catch {
      // A gateway that throws is a gateway that could not obtain consent.
      verdict = 'denied';
    } finally {
      session.pendingApprovals.delete(controller);
    }

    if (verdict === 'approved') {
      this.#recordProbe(session, evaluation.loop.cooldown.calls);
      return 'allow';
    }

    if (verdict === 'denied') {
      applyBreakerEvent(session.breaker, { kind: 'denied', now: ctx.now });
      reasons.push({
        code: 'APPROVAL_DENIED',
        message: 'A human denied this call. Do not retry it; ask the user what to do instead.',
        evidence: { toolName: record.toolName, serverName: record.serverName },
      });
      return 'deny';
    }

    const allowed = config.on_timeout === 'allow';
    if (!allowed) applyBreakerEvent(session.breaker, { kind: 'denied', now: ctx.now });
    reasons.push({
      code: 'APPROVAL_TIMEOUT',
      message: allowed
        ? `No human answered within ${config.timeout}ms; the policy forwards unanswered approvals.`
        : `No human answered within ${config.timeout}ms; the policy denies unanswered approvals.`,
      evidence: { timeoutMs: config.timeout, onTimeout: config.on_timeout },
    });
    // A timeout is nobody's approval, so it never counts towards closing the
    // breaker even when the policy forwards the call.
    return allowed ? 'allow' : 'deny';
  }

  #recordProbe(session: SessionState, cooldownCalls: number): void {
    const transition = applyBreakerEvent(session.breaker, { kind: 'approved', cooldownCalls });
    if (transition.clearWindow) session.window.length = 0;
  }

  #abortApprovals(session: SessionState): void {
    for (const controller of session.pendingApprovals) controller.abort();
    session.pendingApprovals.clear();
  }

  #estimateResultTokens(outcome: CallOutcome): number {
    const { tokenizer } = this.#ports;
    const summary = outcome.resultSummary;
    const summaryBytes = encoder.encode(summary).length;
    if (summaryBytes === 0) return Math.ceil(Math.max(0, outcome.resultBytes) / 4);
    // The summary is capped at 512 characters, so for a large result the real
    // token count is scaled from the summary's observed token density. A floor
    // estimate either way — see TOKEN_ESTIMATE_NOTE.
    const scale = Math.max(1, outcome.resultBytes / summaryBytes);
    return Math.round(tokenizer.count(summary) * scale);
  }

  #applyHooks(
    decision: Decision,
    record: ToolCallRecord,
    session: SessionState,
  ): { decision: Decision; hookError?: string } {
    if (this.#hooks.length === 0) return { decision };

    const call: HookCallView = Object.freeze({
      id: record.id,
      sessionId: record.sessionId,
      serverName: record.serverName,
      toolName: record.toolName,
      args: frozenCopy(record.args),
      argsNormalized: record.argsNormalized,
      fingerprint: record.fingerprint,
      annotations: record.annotations,
    });
    const sessionView: HookSessionView = Object.freeze({
      sessionId: session.sessionId,
      calls: session.counters.calls,
      durationMs: session.counters.durationMs,
      breakerPhase: session.breaker.phase,
    });

    let current = decision;
    let hookError: string | undefined;

    for (const hook of this.#hooks) {
      const reasonsView = [...current.reasons];
      Object.freeze(reasonsView);
      const decisionView = Object.freeze({ ...current, reasons: reasonsView });

      // biome-ignore lint/suspicious/noConfusingVoidType: mirrors DecisionHook.
      let result: DecisionHookResult | undefined | void;
      try {
        result = hook({ decision: decisionView, call, session: sessionView });
      } catch (error) {
        // A broken hook must never take down the proxy.
        hookError ??= error instanceof Error ? error.message : String(error);
        continue;
      }
      if (!result || typeof result !== 'object') continue;

      // Only `action` and `reasons` are read. An `args` field on the result is
      // ignored by construction: rewriting requests is not AgentFuse's job.
      const next: Decision = { ...current, reasons: [...current.reasons] };
      if (result.action !== undefined && VALID_ACTIONS.has(result.action)) {
        next.action = result.action;
      }
      if (Array.isArray(result.reasons)) {
        for (const reason of result.reasons) {
          if (reason && typeof reason === 'object' && typeof reason.code === 'string') {
            next.reasons.push(reason);
          }
        }
      }
      current = next;
    }

    return { decision: current, ...(hookError !== undefined ? { hookError } : undefined) };
  }
}
