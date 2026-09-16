/**
 * What the agent sees when the circuit breaks.
 *
 * ## A result, not a protocol error
 *
 * A block comes back as `isError: true` on a normal `tools/call` result. That
 * is precisely why the spec has `isError`: a JSON-RPC error is a transport
 * failure and clients treat it as one — retry, reconnect, crash — whereas an
 * `isError` result lands in the model's context as text it can read and act on.
 * The whole point of the breaker is that the agent *understands* it was
 * refused and changes course; an exception it never reads cannot do that.
 *
 * ## The text is a product surface
 *
 * It is snapshot-tested, and it has to carry four things:
 *
 * 1. **what happened** — the code, and the number that crossed a line;
 * 2. **that a retry will not work.** Without this sentence the agent retries
 *    the circuit breaker in a tight loop, and you have built a second loop on
 *    top of the first one you were trying to stop. This is the single
 *    load-bearing sentence in the package;
 * 3. **two or three concrete alternatives**, because "stop" is not an
 *    instruction a goal-seeking agent can follow;
 * 4. **where the report is**, so a human can find out more.
 *
 * Around 120 tokens. Longer crowds the context the agent needs to recover with;
 * shorter stops being actionable.
 *
 * ## And, for a denial, the human's own reason
 *
 * ADR-009: "a human denied this call" is measurably less useful to an agent
 * than "a human denied this call, because we do not allow calls that delete
 * production data". The reason goes in — for denials only, since an approved
 * call is forwarded and has no refusal text at all. See
 * {@link humanDenialLine} for why it is attributed rather than stated.
 *
 * Every {@link TripCode} gets its own variant. A blown budget and a semantic
 * loop are different situations and the advice that fits one is noise in the
 * other: "try a materially different strategy" is exactly wrong when the
 * problem is that the session has run out of money.
 *
 * ## The human report is not reimplemented here
 *
 * `@agentfuse/core`'s `renderTripReport` already renders the operator-facing
 * report, and {@link renderTripDiagnostic} is a thin pass-through to it. The
 * proxy writes that to stderr and puts the report's id and path in the result;
 * it does not build a second, divergent description of the same trip.
 */

import {
  APPROVAL_REASON_LIMIT,
  type ApprovalRecord,
  type BreakerPhase,
  type Decision,
  formatDuration,
  type Reason,
  renderTripReport,
  sanitizeFreeText,
  TOKEN_ESTIMATE_NOTE,
  type TripCode,
  type TripReport,
} from '@agentfuse/core';
import type { CallToolResult } from '@modelcontextprotocol/server';

/** The reserved `_meta` key AgentFuse stamps a trip onto. */
export const TRIP_META_KEY = 'io.tunedness.agentfuse/trip';

/** The sentence that stops the agent retrying the circuit breaker in a loop. */
export const RETRY_WARNING =
  'Retrying this call unchanged — or with only cosmetic changes to its arguments — will be blocked too.';

/** Inputs for {@link buildTripResult}. */
export interface TripResultInput {
  /** The engine's verdict. Its first blocking reason picks the variant. */
  readonly decision: Decision;
  /** Where the host wrote the JSON report, when it wrote one. */
  readonly reportPath?: string | undefined;
}

/** The machine-readable half of a trip, as it appears in `structuredContent`. */
export interface TripStructuredContent {
  readonly agentfuse: {
    readonly trip: {
      readonly code: TripCode;
      readonly breaker: BreakerPhase;
      /** Present only when the trip came with a similarity score. */
      readonly windowScore?: number;
      /** Present only when a report was built. */
      readonly reportId?: string;
      /** Present only when the host wrote the report somewhere. */
      readonly reportPath?: string;
    };
  };
}

/** How one variant of the refusal text is built. */
interface Advice {
  /** One sentence naming what crossed which line. */
  readonly headline: (reason: Reason) => string;
  /** Two or three things the agent can actually do instead. */
  readonly alternatives: readonly string[];
}

function num(evidence: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = evidence?.[key];
  return typeof value === 'number' ? value : undefined;
}

function text(evidence: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = evidence?.[key];
  return typeof value === 'string' ? value : undefined;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function count(value: number | undefined, fallback: string): string {
  return value === undefined ? fallback : String(value);
}

/** `1234` → `1,234`, so a five-digit budget is readable at a glance. */
function grouped(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * One variant per code.
 *
 * The advice is written for a model, in the imperative, with the most useful
 * option first. "Ask the user" is always on the list and never first: an agent
 * that gives up at the first refusal is as useless as one that loops.
 */
const ADVICE: Record<TripCode, Advice> = {
  LOOP_EXACT_REPEAT: {
    headline: (reason) =>
      `you have now made ${count(num(reason.evidence, 'count'), 'several')} calls with byte-identical arguments (limit ${count(num(reason.evidence, 'threshold'), 'reached')}). The result will not change.`,
    alternatives: [
      'Treat the last result as final and move on to the next step of the task.',
      'If it was not usable, change what you are asking for — a different tool, a different path, a genuinely different question.',
      'If you cannot proceed, tell the user what you tried and what you need from them.',
    ],
  },
  LOOP_ERROR_REPEAT: {
    headline: (reason) =>
      `${text(reason.evidence, 'toolName') ?? 'this tool'} has failed ${count(num(reason.evidence, 'count'), 'repeatedly')} times in a row with the same error (${text(reason.evidence, 'errorSignature') ?? 'unknown_error'}). The cause has not changed between attempts.`,
    alternatives: [
      'Read the error text and fix the cause, not the call — a missing file, a wrong permission, a malformed argument.',
      'If the cause is outside your reach, reach the same goal another way.',
      'If neither is possible, report the error verbatim to the user and stop.',
    ],
  },
  LOOP_CYCLE: {
    headline: (reason) =>
      `your last calls repeat a cycle of ${count(num(reason.evidence, 'period'), 'two')} steps (A-B-A-B). The loop is not converging on anything.`,
    alternatives: [
      'Pick one branch of the cycle and carry it through to a conclusion before touching the other.',
      'Write down what you actually know so far; the oscillation usually means two attempts are undoing each other.',
      'If both branches are blocked, say so to the user rather than alternating.',
    ],
  },
  LOOP_SEMANTIC: {
    headline: (reason) => {
      const score = num(reason.evidence, 'score');
      const threshold = num(reason.evidence, 'threshold');
      const window = num(reason.evidence, 'windowSize');
      return (
        `your last ${count(window, 'several')} calls are ${score === undefined ? 'highly' : percent(score)} similar to one another on average` +
        `${threshold === undefined ? '' : ` (limit ${percent(threshold)})`}. The arguments keep changing; the work does not.`
      );
    },
    alternatives: [
      'Stop varying the arguments and state the sub-problem in words — what specifically is not working.',
      'Change strategy, not wording: a different tool, a different level of abstraction, a different assumption.',
      'Hand the user what you have, plus the one question that would unblock you.',
    ],
  },
  BUDGET_CALLS: {
    headline: (reason) =>
      `this session has used its whole call budget (${count(num(reason.evidence, 'value'), 'all')} of ${count(num(reason.evidence, 'limit'), 'the allowed')} calls). No further tool call will be forwarded.`,
    alternatives: [
      'Summarise what you achieved and what is left, and hand it back now.',
      'Ask the user to raise `budgets.max_calls` in fusepolicy.yaml if the task genuinely needs more.',
      'Propose a smaller next step that a fresh session could finish.',
    ],
  },
  BUDGET_DURATION: {
    headline: (reason) => {
      const value = num(reason.evidence, 'value');
      const limit = num(reason.evidence, 'limit');
      return `this session has run for its whole time budget (${value === undefined ? 'the limit' : formatDuration(value)} of ${limit === undefined ? 'the limit' : formatDuration(limit)}). No further tool call will be forwarded.`;
    },
    alternatives: [
      'Summarise what you achieved and what is left, and hand it back now.',
      'Ask the user to raise `budgets.max_duration` in fusepolicy.yaml if the task genuinely needs longer.',
      'Propose a smaller next step that a fresh session could finish.',
    ],
  },
  BUDGET_TOKENS: {
    headline: (reason) => {
      const value = num(reason.evidence, 'value');
      const limit = num(reason.evidence, 'limit');
      return (
        `this session has used its whole estimated token budget (${value === undefined ? 'the limit' : `~${grouped(value)}`} of ` +
        `${limit === undefined ? 'the limit' : grouped(limit)} tokens_estimated; ${TOKEN_ESTIMATE_NOTE}). No further tool call will be forwarded.`
      );
    },
    alternatives: [
      'Summarise what you achieved and what is left, and hand it back now.',
      'Stop pulling large payloads into context — read narrower slices, or ask for a summary instead of a dump.',
      'Ask the user to raise `budgets.max_tokens_estimated` if the task genuinely needs more.',
    ],
  },
  BUDGET_USD: {
    headline: (reason) => {
      const value = num(reason.evidence, 'value');
      const limit = num(reason.evidence, 'limit');
      return (
        `this session has used its whole estimated spend budget (~$${(value ?? 0).toFixed(2)} of ` +
        `$${(limit ?? 0).toFixed(2)} usd_estimated; ${TOKEN_ESTIMATE_NOTE}). No further tool call will be forwarded.`
      );
    },
    alternatives: [
      'Summarise what you achieved and what is left, and hand it back now.',
      'Stop pulling large payloads into context — that is what the estimate is measuring.',
      'Ask the user to raise `budgets.max_usd_estimated` if the task genuinely needs more.',
    ],
  },
  POLICY_DENY: {
    headline: (reason) =>
      `policy denies ${text(reason.evidence, 'key') ?? 'this tool'}${text(reason.evidence, 'match') === undefined ? '' : ` (rule \`${text(reason.evidence, 'match')}\`)`}. This is a standing configuration decision, not a reaction to what you did.`,
    alternatives: [
      'Reach the goal with a tool the policy does allow.',
      'If there is no such tool, tell the user which tool you needed and why.',
      'Do not probe for variations of the same tool name; the rule is a pattern, not a blocklist of one.',
    ],
  },
  POLICY_APPROVAL: {
    headline: () => 'policy requires a human to approve this tool, and no approval was granted.',
    alternatives: [
      'Ask the user directly for permission, explaining exactly what the call would do.',
      'Meanwhile, continue with the parts of the task that need no approval.',
      'Do not re-issue the call hoping for a different answer.',
    ],
  },
  POLICY_WARN: {
    headline: (reason) => `policy flags ${text(reason.evidence, 'key') ?? 'this tool'} for review.`,
    alternatives: [
      'Continue, but say in your next message that this tool is flagged.',
      'Prefer an unflagged tool if one would do the same job.',
      'If the user did not expect this tool to be in play, say so.',
    ],
  },
  APPROVAL_DENIED: {
    headline: () => 'a human explicitly denied this call.',
    alternatives: [
      'Accept the decision: ask the user what they would like instead.',
      'Continue with the parts of the task that do not need this call.',
      'Do not re-issue the call, and do not look for an equivalent tool to do it with.',
    ],
  },
  APPROVAL_TIMEOUT: {
    headline: (reason) => {
      const timeout = num(reason.evidence, 'timeoutMs');
      return `nobody answered the approval request${timeout === undefined ? '' : ` within ${formatDuration(timeout)}`}, and the policy denies unanswered approvals.`;
    },
    alternatives: [
      'Tell the user an approval is pending and ask them to answer it.',
      'Continue with the parts of the task that do not need this call.',
      'Do not re-issue the call to trigger a second prompt.',
    ],
  },
  BREAKER_OPEN: {
    headline: (reason) => {
      const remaining = num(reason.evidence, 'remainingMs');
      const cause = text(reason.evidence, 'tripCode');
      return (
        `the breaker is already open from an earlier trip${cause === undefined ? '' : ` (${cause})`}` +
        `${remaining === undefined || remaining <= 0 ? '' : `, with ${formatDuration(remaining)} of cooldown left`}. Every tool call in this session is refused until it closes.`
      );
    },
    alternatives: [
      'Stop calling tools and report what you were trying to achieve when the circuit broke.',
      'Tell the user a human reset (`agentfuse approve --reset`) or the cooldown will reopen the path.',
      'Do not poll the breaker; a call that only checks whether it is closed is itself blocked.',
    ],
  },
};

/** The blocking reason that decides which variant of the text is used. */
export function primaryReason(decision: Decision): Reason | undefined {
  // The report's trigger is the authority when there is one: it is the reason
  // the breaker actually moved, which is not always the first one recorded.
  const triggerCode = decision.report?.trigger.code;
  if (triggerCode !== undefined) {
    const matching = decision.reasons.find((reason) => reason.code === triggerCode);
    if (matching !== undefined) return matching;
  }
  return decision.reasons.at(-1) ?? decision.reasons[0];
}

/**
 * A reason for a block that arrived without one.
 *
 * The engine always explains itself, but `onDecision` is a public escape hatch
 * and ADR-004 lets a hook raise the action while returning no `reasons` at all.
 * Throwing here would be the one thing this whole file exists to prevent: the
 * agent would receive a JSON-RPC error instead of a refusal it can read, and a
 * misconfigured hook would look like a broken server. So a block is always
 * explainable, even when the explanation is "something upstream of the engine
 * said no".
 */
function unexplained(decision: Decision): Reason {
  const gated = decision.action === 'require_approval';
  return {
    code: gated ? 'POLICY_APPROVAL' : 'POLICY_DENY',
    message: gated
      ? 'An onDecision hook required approval for this call without giving a reason.'
      : 'An onDecision hook denied this call without giving a reason.',
    evidence: { rule: 'onDecision', action: decision.action },
  };
}

/**
 * The human's own words about a denial, attributed to them.
 *
 * ADR-009 decided this text reaches the agent, and the attribution is the
 * decision, not decoration. What lands in the model's context is free-form
 * prose written by somebody at a terminal — or, on the webhook channel, by a
 * remote endpoint. Stated bare it reads as another instruction in the tool
 * result; introduced as `A human denied this call. Reason given: …` it reads as
 * a report of what a person said, which is what it is.
 *
 * **Denials only.** An approved call is forwarded and never sees this file, and
 * a timeout is nobody's statement — attributing one to a human who never
 * answered would be the one kind of lie this text must not tell. The guard is
 * on the verdict rather than the {@link TripCode} so that a gateway answering
 * `denied` is always quoted, whichever code the engine settled on.
 *
 * The sanitiser is core's, the same one the engine already ran through
 * `approvalRecordOf`, and it is idempotent — running it twice costs nothing and
 * changes nothing. It runs again here because {@link buildTripResult} is a
 * public entry point that takes any `Decision` a host hands it, and an escape
 * sequence on its way into a model's context is not a place to trust an
 * upstream invariant.
 */
function humanDenialLine(approval: ApprovalRecord | undefined): string | undefined {
  if (approval?.verdict !== 'denied') return undefined;
  const reason = sanitizeFreeText(approval.reason, APPROVAL_REASON_LIMIT);
  if (reason === undefined) return undefined;
  return `A human denied this call. Reason given: ${reason}`;
}

/**
 * Renders the agent-facing refusal text. Snapshot-tested; change it on purpose.
 *
 * @param approval the human's answer when the policy asked for one. Only a
 * `denied` verdict carrying words adds anything; see {@link humanDenialLine}.
 */
export function renderTripText(
  reason: Reason,
  reportRef: string | undefined,
  approval?: ApprovalRecord | undefined,
): string {
  const advice = ADVICE[reason.code];
  const lines = [`AgentFuse circuit breaker OPEN — ${advice.headline(reason)}`];
  const denial = humanDenialLine(approval);
  if (denial !== undefined) {
    // Before the retry warning, not after: the reason is part of what happened,
    // and the warning plus the alternatives are what to do about it.
    lines.push('', denial);
  }
  lines.push(
    '',
    RETRY_WARNING,
    '',
    'Do this instead:',
    ...advice.alternatives.map((alternative, index) => `  ${index + 1}. ${alternative}`),
  );
  if (reportRef !== undefined) {
    lines.push('', `Trip report: ${reportRef}`);
  }
  return lines.join('\n');
}

/**
 * Builds the `isError: true` result the agent receives instead of its call.
 *
 * `resultType: 'complete'` is explicit: on the 2026-07-28 revision every result
 * carries the discriminator, and a refusal is a *complete* answer — it is not
 * an `input_required` round trip and must never be auto-fulfilled by a client
 * driver looking for one.
 *
 * `structuredContent` is object-shaped on purpose, so that the SDK's
 * `projectCallToolResult` is the identity on both eras and the proxy never has
 * to call it (calling it on an already-projected upstream result would
 * double-append the SEP-2106 text fallback).
 */
export function buildTripResult(input: TripResultInput): CallToolResult {
  const { decision, reportPath } = input;
  const reason = primaryReason(decision) ?? unexplained(decision);

  const report = decision.report;
  const reportId = report?.tripId;
  const windowScore = num(reason.evidence, 'score');
  const breaker: BreakerPhase =
    report?.breaker.phase ?? (decision.action === 'deny' ? 'open' : 'half_open');

  const structured: TripStructuredContent = {
    agentfuse: {
      trip: {
        code: reason.code,
        breaker,
        ...(windowScore !== undefined ? { windowScore } : undefined),
        ...(reportId !== undefined ? { reportId } : undefined),
        ...(reportPath !== undefined ? { reportPath } : undefined),
      },
    },
  };

  return {
    resultType: 'complete',
    isError: true,
    content: [
      { type: 'text', text: renderTripText(reason, reportPath ?? reportId, decision.approval) },
    ],
    structuredContent: structured as unknown as Record<string, unknown>,
    _meta: {
      [TRIP_META_KEY]: {
        code: reason.code,
        ...(reportId !== undefined ? { reportId } : undefined),
      },
    },
  } satisfies CallToolResult;
}

/**
 * The operator-facing report, rendered by `@agentfuse/core`.
 *
 * Deliberately a pass-through. There is one renderer for the human report and
 * it lives in core, where the CLI, the Control Plane and the test snapshots all
 * reach the same text. A second implementation here would drift within a
 * release.
 */
export function renderTripDiagnostic(report: TripReport): string {
  return renderTripReport(report);
}
