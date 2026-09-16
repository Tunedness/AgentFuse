import type { Reason } from '../domain/decision.js';
import type { ToolCallRecord } from '../domain/records.js';
import { shortFingerprint } from '../loop/fingerprint.js';
import { maskString } from '../loop/normalize.js';
import type { LoopDetectionSettings } from '../policy/schema.js';
import { applyTrip, type GuardContext, type GuardState } from './types.js';

/**
 * Guard 4 of 4: the deterministic loop rules.
 *
 * These three catch the overwhelming majority of real runaway agents without an
 * embedding model anywhere in sight, which is why they run in-process on the
 * hot path and the semantic rule does not.
 *
 * `min_calls` deliberately does not gate these — it is the semantic rule's
 * "enough signal to compare" threshold. Gating R1 behind it would mean a
 * three-call loop could not be caught on the third call, which is the single
 * most common thing AgentFuse exists to catch.
 */

/** Result of one rule firing. */
type RuleHit = Reason | undefined;

function recentWindow(window: readonly ToolCallRecord[], size: number): ToolCallRecord[] {
  return size >= window.length ? [...window] : window.slice(-size);
}

/**
 * What "the same answer" means for R1.
 *
 * An error is identified by its signature, which `errorSignature` has already
 * stripped of volatile paths, hex runs and numbers. A success is identified by
 * its summary with the same value masks the argument normalizer applies, so a
 * result that differs only in a timestamp, a uuid or a request id still counts
 * as the same answer — otherwise a tool that stamps its output would make R1
 * permanently blind.
 */
function answerIdentity(record: ToolCallRecord, now: number): string {
  const outcome = record.outcome;
  if (outcome === undefined) return '';
  if (outcome.isError) return `e:${outcome.errorSignature ?? 'unknown_error'}`;
  return `r:${maskString(outcome.resultSummary, now)}`;
}

/**
 * R1 — the same fingerprint, over and over, **getting the same answer**.
 *
 * The answer condition is not decoration: the rule's own message says "the
 * result will not change", and phase 9 measured what happens when nothing
 * checks that. A converging build-test loop — `npm test`, read, fix, `npm test`
 * again — repeats one command verbatim while the answer moves from seven
 * failures to four to none. With the window at its default 8, **every** such
 * session in the benchmark corpus was halted, and so were half the
 * try-then-fix sessions: a 31% false-positive rate from the deterministic tier
 * alone, on the single most common shape an agent that is *working* produces.
 *
 * So the count is over the largest group of previous identical calls that also
 * agreed on their answer, rather than over every identical call. An agent
 * hammering a broken thing still trips on the third attempt; an agent whose
 * repeats keep returning something new does not, because it is being told
 * something new.
 *
 * The threshold doubles when the operator declared the rule `idempotent`, or
 * when the server claims `idempotentHint` **and** the policy has opted into
 * trusting server hints. Repeating a genuinely idempotent read is wasteful, not
 * dangerous, so it earns more rope.
 */
function exactRepeat(
  ctx: GuardContext,
  loop: LoopDetectionSettings,
  recent: ToolCallRecord[],
): RuleHit {
  const trusted =
    ctx.policy.policy.annotations.trust_hints && ctx.record.annotations?.idempotentHint === true;
  const idempotent = ctx.evaluation.idempotent || trusted;
  const threshold = loop.exact_repeat.count * (idempotent ? 2 : 1);

  const identical = recent.filter((r) => r.fingerprint === ctx.record.fingerprint);
  // Group by answer and keep the largest group. The call being decided has no
  // outcome yet, so it joins whichever group is already the strongest evidence.
  const groups = new Map<string, ToolCallRecord[]>();
  for (const record of identical) {
    const key = answerIdentity(record, ctx.now);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  let matches: ToolCallRecord[] = [];
  for (const group of groups.values()) if (group.length > matches.length) matches = group;

  const count = matches.length + 1; // +1 for the call being decided
  if (count < threshold) return undefined;

  return {
    code: 'LOOP_EXACT_REPEAT',
    message: `This is call ${count} with identical arguments to ${ctx.record.toolName}, and the earlier ones all came back the same (threshold ${threshold}). The result will not change. Try a different approach or report the blocker.`,
    evidence: {
      count,
      threshold,
      idempotent,
      fingerprint: shortFingerprint(ctx.record.fingerprint),
      callIds: [...matches.map((r) => r.id), ctx.record.id],
      windowSize: loop.window,
    },
  };
}

/**
 * R2 — the same failure, over and over.
 *
 * Counts the *trailing* run of identical `(toolName, errorSignature)` pairs. A
 * run only counts while the agent keeps hammering the same tool: switching
 * tools after three failures is a recovery attempt, and denying it would punish
 * exactly the behaviour we want.
 */
function errorRepeat(loop: LoopDetectionSettings, recent: ToolCallRecord[], toolName: string) {
  let signature: string | undefined;
  const run: ToolCallRecord[] = [];

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const candidate = recent[i];
    if (!candidate?.outcome?.isError) break;
    if (candidate.toolName !== toolName) break;
    const candidateSignature = candidate.outcome.errorSignature ?? 'unknown_error';
    if (signature === undefined) signature = candidateSignature;
    else if (candidateSignature !== signature) break;
    run.push(candidate);
  }

  if (signature === undefined || run.length < loop.error_repeat.count) return undefined;

  return {
    code: 'LOOP_ERROR_REPEAT',
    message: `${toolName} has failed ${run.length} times in a row with the same error (${signature}). Retrying will not help; the cause has not changed.`,
    evidence: {
      count: run.length,
      threshold: loop.error_repeat.count,
      errorSignature: signature,
      toolName,
      callIds: run.map((r) => r.id).reverse(),
    },
  } satisfies Reason;
}

/**
 * R3 — A-B-A-B.
 *
 * Looks for a repeating period of 2..`cycle.max_period` over the last `2p`
 * fingerprints. Catches oscillation between two tools long before either one
 * individually reaches the exact-repeat threshold.
 *
 * A period made of a single fingerprint is ignored: that is a plain repeat and
 * belongs to R1, and reporting it as a cycle would be a worse explanation of
 * the same fact.
 */
function shortCycle(
  loop: LoopDetectionSettings,
  recent: ToolCallRecord[],
  current: ToolCallRecord,
) {
  const ids = [...recent.map((r) => r.id), current.id];
  const prints = [...recent.map((r) => r.fingerprint), current.fingerprint];

  for (let period = 2; period <= loop.cycle.max_period; period += 1) {
    const span = period * 2;
    if (prints.length < span) break;
    const tail = prints.slice(-span);
    let periodic = true;
    for (let i = 0; i < period; i += 1) {
      if (tail[i] !== tail[i + period]) {
        periodic = false;
        break;
      }
    }
    if (!periodic) continue;
    if (new Set(tail.slice(0, period)).size < 2) continue;

    return {
      code: 'LOOP_CYCLE',
      message: `The last ${span} calls repeat a cycle of ${period} (A-B-A-B). The loop is not converging; change strategy or report what is blocking you.`,
      evidence: {
        period,
        repeats: 2,
        threshold: loop.cycle.max_period,
        fingerprints: tail.slice(0, period).map(shortFingerprint),
        callIds: ids.slice(-span),
      },
    } satisfies Reason;
  }
  return undefined;
}

/**
 * Runs the deterministic loop rules and trips on the first hit.
 *
 * Only one trip per call: two reasons for the same halt is noise, and the first
 * rule to fire is the most specific description of what went wrong.
 */
export function ruleLoopGuard(ctx: GuardContext, state: GuardState): void {
  const loop = ctx.evaluation.loop;
  const recent = recentWindow(ctx.session.window, loop.window);

  const hit =
    exactRepeat(ctx, loop, recent) ??
    errorRepeat(loop, recent, ctx.record.toolName) ??
    shortCycle(loop, recent, ctx.record);
  if (!hit) return;

  const outcome = applyTrip(ctx, state, hit, loop.on_trip);
  ctx.telemetry.emit({
    type: 'loop_detection',
    timestamp: ctx.now,
    sessionId: ctx.session.sessionId,
    code: hit.code,
    threshold: Number(hit.evidence?.threshold ?? 0),
    enforced: ctx.mode === 'enforce' && outcome.action !== 'warn',
    callIds: Array.isArray(hit.evidence?.callIds) ? (hit.evidence.callIds as string[]) : [],
  });
}
