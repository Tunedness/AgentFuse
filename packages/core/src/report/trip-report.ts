import type { BreakerPhase } from '../domain/breaker.js';
import type { Reason, TripCode } from '../domain/decision.js';
import type { ToolCallRecord } from '../domain/records.js';
import type { SessionState } from '../domain/session.js';
import { argsPreview } from '../loop/normalize.js';
import type { CompiledPolicy } from '../policy/compile.js';
import { toolKey } from '../policy/glob.js';
import type { LoopDetectionSettings, PolicyMode } from '../policy/schema.js';
import { CORE_VERSION } from '../version.js';

/**
 * The caveat that travels with every estimated token figure.
 *
 * ADR-007: an estimate must carry its caveat *where a reader will see it*, not
 * in documentation nobody opens during an incident. AgentFuse meters the bytes
 * that crossed the proxy; it never sees the model's own prompt.
 */
export const TOKEN_ESTIMATE_NOTE = 'tool-I/O floor estimate, not LLM usage';

/** One line of the report's recent-calls table. */
export interface ReportedCall {
  id: string;
  /** `<server>__<tool>`. */
  tool: string;
  fingerprint: string;
  isError: boolean;
  errorSignature?: string;
  durationMs: number;
  /** ISO-8601. */
  startedAt: string;
  /** Raw preview, or the fingerprint when `report.redact_args` is on. */
  argsPreview: string;
}

/** The artifact a human reads after a trip. */
export interface TripReport {
  reportVersion: 1;
  kind: 'trip';
  tripId: string;
  sessionId: string;
  /** ISO-8601. */
  trippedAt: string;
  mode: PolicyMode;
  trigger: { code: TripCode; message: string; evidence?: Record<string, unknown> };
  breaker: { phase: BreakerPhase; cooldown: { calls: number; durationMs: number } };
  budgets: {
    durationMs: number;
    calls: number;
    tokensEstimated: { args: number; results: number; note: string };
    usdEstimated: number;
    limits: {
      durationMs: number;
      calls: number;
      tokensEstimated: number;
      usdEstimated: number;
    };
  };
  recentCalls: ReportedCall[];
  policy: { sha256: string; version: 1 };
  traceparent?: string;
  agentfuse: { version: string };
}

/** Inputs for {@link buildTripReport}. */
export interface BuildTripReportInput {
  tripId: string;
  policy: CompiledPolicy;
  session: SessionState;
  /** The call being decided when the breaker tripped. */
  current: ToolCallRecord;
  trigger: Reason;
  /** Loop settings in force for the current call, rule override merged. */
  loop: LoopDetectionSettings;
  now: number;
}

function reportCall(
  record: ToolCallRecord,
  redact: boolean,
  now: number,
  inFlight: boolean,
): ReportedCall {
  const outcome = record.outcome;
  return {
    id: record.id,
    tool: toolKey(record.serverName, record.toolName),
    fingerprint: record.fingerprint,
    isError: outcome?.isError ?? false,
    ...(outcome?.errorSignature !== undefined
      ? { errorSignature: outcome.errorSignature }
      : undefined),
    durationMs: inFlight ? 0 : (record.endedAt ?? now) - record.startedAt,
    startedAt: new Date(record.startedAt).toISOString(),
    // Redaction replaces the preview with the fingerprint rather than dropping
    // it: a reader can still tell two different calls apart, and can still see
    // a repeat, without any argument value leaving the process.
    argsPreview: redact ? record.fingerprint : argsPreview(record.args),
  };
}

/**
 * Assembles the JSON a trip report is made of.
 *
 * Writing it to disk is the CLI's job — core builds the object and renders the
 * string, and does no I/O. The call that tripped the breaker is included as the
 * last entry of `recentCalls` even though it never completed, because "what was
 * it about to do" is the first question anyone asks.
 */
export function buildTripReport(input: BuildTripReportInput): TripReport {
  const { policy, session, current, trigger, loop, now } = input;
  const { budgets, report } = policy.policy;
  const redact = report.redact_args;

  const history = session.window.slice(-Math.max(0, report.recent_calls - 1));
  const recentCalls = [
    ...history.map((record) => reportCall(record, redact, now, false)),
    reportCall(current, redact, now, true),
  ];

  return {
    reportVersion: 1,
    kind: 'trip',
    tripId: input.tripId,
    sessionId: session.sessionId,
    trippedAt: new Date(now).toISOString(),
    mode: policy.policy.mode,
    trigger: {
      code: trigger.code,
      message: trigger.message,
      ...(trigger.evidence !== undefined ? { evidence: trigger.evidence } : undefined),
    },
    breaker: {
      phase: session.breaker.phase,
      cooldown: { calls: loop.cooldown.calls, durationMs: loop.cooldown.duration },
    },
    budgets: {
      durationMs: now - session.startedAt,
      calls: session.counters.calls,
      tokensEstimated: {
        args: session.counters.argsTokens,
        results: session.counters.resultTokens,
        note: TOKEN_ESTIMATE_NOTE,
      },
      usdEstimated: Number(session.counters.usdEstimated.toFixed(6)),
      limits: {
        durationMs: budgets.max_duration,
        calls: budgets.max_calls,
        tokensEstimated: budgets.max_tokens_estimated,
        usdEstimated: budgets.max_usd_estimated,
      },
    },
    recentCalls,
    policy: { sha256: policy.sha256, version: 1 },
    // Copied, never invented: a fabricated traceparent would silently corrupt
    // the operator's distributed traces.
    ...(current.traceparent !== undefined ? { traceparent: current.traceparent } : undefined),
    agentfuse: { version: CORE_VERSION },
  };
}
