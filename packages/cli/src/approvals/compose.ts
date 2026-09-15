/**
 * `approvals.gateways: [cli, webhook]` — two channels, one answer.
 *
 * ## The rule
 *
 * The request goes to **every** configured gateway at once, and then:
 *
 * 1. **The first decisive answer wins.** `approved` and `denied` are decisive;
 *    the other channels are stood down immediately, and a verdict that arrives
 *    after that is discarded and logged.
 * 2. **A timeout is not an answer.** One channel giving up does not end the
 *    request — the others keep their full window. Only when *every* channel has
 *    timed out does the composite report `'timeout'`, which is the one verdict
 *    `approvals.on_timeout` is allowed to reinterpret.
 * 3. **A channel that fails is a denial, not a timeout.** If no channel was
 *    decisive and at least one threw, the composite denies. Failing closed here
 *    is what stops a broken gateway from being converted into consent by an
 *    `on_timeout: allow` policy.
 *
 * ## Why this is the safe reading
 *
 * Configuring two gateways means saying "either of these channels reaches a
 * person who may answer for me" — redundancy, which is the only thing
 * two channels can usefully be. Requiring both to agree would instead mean
 * every approval waits on the slowest channel and a quiet one denies
 * everything, so an operator who added a Slack webhook to a working terminal
 * setup would find approvals had stopped working.
 *
 * The composite can only ever *shorten* the window, never invent consent: every
 * `approved` it returns is traceable to exactly one channel that returned
 * `approved`, and if all channels go quiet the answer is a timeout and the
 * policy decides. Disagreement in the strict sense is therefore not reachable —
 * the first answer ends the request and the second channel's prompt is aborted
 * before anyone can answer it. A verdict that races in anyway is recorded
 * (`approval_discarded`) rather than silently dropped, because "I approved that
 * and it was refused" must be answerable from the log.
 */

import type {
  ApprovalAnswer,
  ApprovalGateway,
  ApprovalRequest,
  ApprovalVerdict,
} from '@agentfuse/core';
import type { Diagnostics } from '@agentfuse/proxy';
import { messageOf } from '../errors.js';

/** One channel, named for the log. */
export interface NamedGateway {
  readonly name: string;
  readonly gateway: ApprovalGateway;
}

/**
 * Normalises a member's answer.
 *
 * The port accepts a bare verdict as well as `{ verdict, reason }`, so that an
 * embedder's three-line gateway keeps working; a composite over a mixture of
 * both has to read them the same way. The reason travels on untouched — the
 * engine is where it is sanitised, once.
 */
function answerOf(result: ApprovalVerdict | ApprovalAnswer): ApprovalAnswer {
  return typeof result === 'string' ? { verdict: result } : result;
}

/** Asks several gateways and applies the rule in the module doc. */
export class CompositeApprovalGateway implements ApprovalGateway {
  readonly #members: readonly NamedGateway[];
  readonly #diagnostics: Diagnostics;

  constructor(members: readonly NamedGateway[], diagnostics: Diagnostics) {
    this.#members = members;
    this.#diagnostics = diagnostics;
  }

  /** The channel names, in the order the policy listed them. */
  get names(): string[] {
    return this.#members.map((member) => member.name);
  }

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    // Stands the losers down. Chained to the engine's signal so an ended
    // session still aborts every channel.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });

    let decided = false;
    let settle!: (answer: ApprovalAnswer) => void;
    const answer = new Promise<ApprovalAnswer>((resolve) => {
      settle = resolve;
    });

    let outstanding = this.#members.length;
    let anyFailed = false;

    for (const member of this.#members) {
      void member.gateway
        .requestApproval(request, controller.signal)
        .then(
          (result) => {
            const answered = answerOf(result);
            const verdict = answered.verdict;
            if (verdict === 'approved' || verdict === 'denied') {
              if (decided) {
                this.#diagnostics.emit('approval_discarded', {
                  approvalId: request.approvalId,
                  source: member.name,
                  verdict,
                });
              } else {
                decided = true;
                this.#diagnostics.emit('approval_decided_by', {
                  approvalId: request.approvalId,
                  source: member.name,
                  verdict,
                });
                // The winning channel's words travel with its verdict: every
                // `approved` this returns is traceable to one channel, and so
                // is the reason recorded beside it.
                settle(answered);
              }
            }
          },
          (error: unknown) => {
            anyFailed = true;
            this.#diagnostics.emit('approval_gateway_failed', {
              approvalId: request.approvalId,
              source: member.name,
              message: messageOf(error),
            });
          },
        )
        .finally(() => {
          outstanding -= 1;
          // Every channel has spoken and none was decisive: a failure anywhere
          // fails closed, otherwise this really was nobody answering in time.
          // No reason on either: nobody wrote one. A channel's failure is its
          // own `approval_gateway_failed` line, not a sentence in an audit
          // record claiming a person said it.
          if (outstanding === 0 && !decided) {
            settle({ verdict: anyFailed ? 'denied' : 'timeout' });
          }
        });
    }

    try {
      return await answer;
    } finally {
      controller.abort();
      signal.removeEventListener('abort', onAbort);
    }
  }
}
