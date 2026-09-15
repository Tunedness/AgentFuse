import type { ApprovalGateway, ApprovalRequest } from '../ports/index.js';

/** Verdicts a gateway may return. */
export type ApprovalVerdict = 'approved' | 'denied' | 'timeout';

/**
 * The default gateway: denies.
 *
 * A policy can ask for human approval; if no human is reachable there is no
 * safe way to synthesise consent. Failing closed is the only defensible
 * default, and the CLI replaces this with a real prompt in phase 7.
 */
export class DenyAllApprovalGateway implements ApprovalGateway {
  async requestApproval(): Promise<ApprovalVerdict> {
    return 'denied';
  }
}

/**
 * Test gateway that replays a scripted sequence of verdicts and records what it
 * was asked.
 */
export class ScriptedApprovalGateway implements ApprovalGateway {
  readonly requests: ApprovalRequest[] = [];
  readonly #script: ApprovalVerdict[];
  readonly #fallback: ApprovalVerdict;

  constructor(script: ApprovalVerdict[] | ApprovalVerdict, fallback: ApprovalVerdict = 'denied') {
    this.#script = Array.isArray(script) ? [...script] : [script];
    this.#fallback = Array.isArray(script) ? fallback : script;
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalVerdict> {
    this.requests.push(req);
    return this.#script.shift() ?? this.#fallback;
  }
}
