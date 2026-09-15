/**
 * `approvals.gateways: [cli]` — the pending prompt and the socket that answers it.
 *
 * ## The prompt goes to stderr, and it is not a diagnostic
 *
 * In wrap mode this process has no terminal of its own: stdout **is** the
 * agent's JSON-RPC stream and there is no tty to prompt on. So the question is
 * written to stderr, where the operator is already reading the wrapped server's
 * output, prefixed like every other AgentFuse line so it is distinguishable
 * from it.
 *
 * It carries everything needed to decide without going to look anything up:
 * which tool on which server, the reason the *policy* asked for a human, the
 * truncated arguments, the approval id, and the exact command to type — with
 * `--socket` included when the socket is not at the default path, because then
 * the command without it would talk to a different wrap.
 *
 * **`--quiet` does not silence it.** `--quiet` exists to silence AgentFuse's
 * own chatter — lines the operator did not ask for. A prompt is not chatter: it
 * is the policy's own question, written by the operator in their own policy
 * file, and suppressing it turns every `require_approval` into a call that
 * hangs for two minutes and is then denied with no explanation anywhere. The
 * structured `approval_pending` event *does* respect `--quiet`, so the machine
 * line and the human line are separable.
 *
 * ## The timeout belongs here
 *
 * Phase 2 put the approval clock in the gateway and left the engine with none:
 * core's only source of time is an injected `Clock` and it starts no timers.
 * The engine passes `timeoutMs`, accepts `'timeout'` as an answer, and supplies
 * an `AbortSignal` that fires when the session ends or the breaker is reset.
 *
 * An abort resolves as **`'denied'`**, not `'timeout'`. The difference matters:
 * `'timeout'` is routed through `approvals.on_timeout`, which an operator may
 * have set to `allow`, so answering a dead session with `'timeout'` could
 * *forward* a call nobody ever approved. `'denied'` cannot be misread — and a
 * denial while the breaker is not half-open moves nothing, so a reset that
 * abandons a prompt does not immediately re-open the circuit it just closed.
 *
 * ## What happens to `--reason`
 *
 * It is recorded in the `approval_resolved` diagnostic and echoed to the person
 * who typed it. It does **not** reach the agent-facing refusal text or the JSON
 * trip report, and it cannot: `ApprovalGateway.requestApproval` returns a bare
 * verdict string, the report is built inside the engine before any of this is
 * known, and both of those live in frozen packages. The seam that would close
 * it is a verdict object (`{ verdict, reason }`) on the port — a core change,
 * recorded in `docs/implementation-status.md` rather than made here.
 */

import type { ApprovalGateway, ApprovalRequest, ApprovalVerdict } from '@agentfuse/core';
import type { Diagnostics } from '@agentfuse/proxy';
import { type Writer, writeNotice } from '../io.js';
import type { CommandFrame, ReplyFrame } from './protocol.js';
import { type ApprovalSocket, listenApprovalSocket, type SocketListener } from './socket.js';

/** What the gateway needs from the engine to serve a `--reset`. */
export interface ApprovalHost {
  /**
   * Resets a session's breaker.
   *
   * @returns the phase afterwards, or `undefined` when there is no such
   * session — so the person who typed the command is told which of the two
   * happened instead of being congratulated either way.
   */
  resetBreaker(sessionId: string): string | undefined;
}

/** How a {@link CliApprovalGateway} is built. */
export interface CliApprovalGatewayOptions {
  /** The preferred socket path, from `resolveApprovalSocketPath`. */
  readonly path: string;
  /** The path to use if the preferred one belongs to a live wrap. */
  readonly fallback?: string | undefined;
  /** Where the default path is, so the prompt knows whether to print `--socket`. */
  readonly defaultPath?: string | undefined;
  /** Where the prompt goes. Never stdout; see the module doc. */
  readonly stderr: Writer;
  /** AgentFuse's structured stderr. Carries `--quiet`. */
  readonly diagnostics: Diagnostics;
  /** This user's uid, where the platform has one. */
  readonly uid?: number | undefined;
  /** Injected for tests. */
  readonly listen?: SocketListener | undefined;
}

/** How much of the argument preview the prompt shows. */
export const ARGS_PREVIEW_LIMIT = 240;

/** How many policy reasons the prompt lists before it stops. */
export const PROMPT_REASON_LIMIT = 3;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Whole seconds, minutes or hours — the prompt says "2m", not "120000ms". */
function humanDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * The lines a human reads and answers.
 *
 * A pure function of the request, so the text is testable and so the one thing
 * that must never happen here — printing arguments the policy said to redact —
 * is testable too. Nothing is redacted at this layer: `argsPreview` arrives
 * already reduced to the call's fingerprint when `report.redact_args` is on,
 * because the engine is the only place that has seen the raw arguments.
 */
export function approvalPrompt(
  request: ApprovalRequest,
  options: { readonly socketPath: string; readonly atDefaultPath: boolean },
): string[] {
  const where = options.atDefaultPath ? '' : ` --socket ${options.socketPath}`;
  const reasons = request.reasons.slice(-PROMPT_REASON_LIMIT);
  return [
    `approval needed — ${request.toolName} on ${request.serverName}`,
    ...reasons.map((reason) => `why: ${reason.message}`),
    `args: ${clip(request.argsPreview, ARGS_PREVIEW_LIMIT)}`,
    `session: ${request.sessionId}   ·   expires in ${humanDuration(request.timeoutMs)}`,
    `allow it:  agentfuse approve ${request.approvalId}${where} --reason "why you said yes"`,
    `refuse it: agentfuse deny ${request.approvalId}${where} --reason "why you said no"`,
  ];
}

/** How one pending approval was resolved, and by which route. */
interface Answer {
  readonly verdict: ApprovalVerdict;
  /** The human's words, where there are any. Empty for a timeout. */
  readonly reason: string;
  /** `cli`, `timeout` or `abort`, for the log. */
  readonly source: string;
}

/** One call waiting for a human. */
interface Pending {
  readonly request: ApprovalRequest;
  readonly settle: (answer: Answer) => void;
}

/** Asks the human at the other end of the socket. */
export class CliApprovalGateway implements ApprovalGateway {
  readonly #socket: ApprovalSocket;
  readonly #stderr: Writer;
  readonly #diagnostics: Diagnostics;
  readonly #atDefaultPath: boolean;
  readonly #pending = new Map<string, Pending>();
  #host: ApprovalHost | undefined;

  private constructor(
    socket: ApprovalSocket,
    options: CliApprovalGatewayOptions,
    atDefaultPath: boolean,
  ) {
    this.#socket = socket;
    this.#stderr = options.stderr;
    this.#diagnostics = options.diagnostics;
    this.#atDefaultPath = atDefaultPath;
  }

  /**
   * Binds the socket and returns a gateway.
   *
   * @throws {CliError} when the socket cannot be opened at all. Loudly, at
   * startup: a policy that asks for approval and has no channel to ask on is a
   * policy that denies everything, and the operator should learn that from a
   * line when the wrap starts rather than from a tool call two minutes in.
   */
  static async open(options: CliApprovalGatewayOptions): Promise<CliApprovalGateway> {
    const listen = options.listen ?? listenApprovalSocket;
    // Assigned through a holder because the connection handler and the gateway
    // need each other: the socket is created with a handler, and the handler
    // answers out of the gateway's pending table.
    let gateway: CliApprovalGateway | undefined;
    const socket = await listen({
      path: options.path,
      ...(options.fallback !== undefined ? { fallback: options.fallback } : undefined),
      ...(options.uid !== undefined ? { uid: options.uid } : undefined),
      handle: (frame) => (gateway === undefined ? notReady() : gateway.#handle(frame)),
      onEvent: (event, fields) => {
        options.diagnostics.emit(event, fields);
      },
    });

    const defaultPath = options.defaultPath ?? options.path;
    gateway = new CliApprovalGateway(socket, options, socket.path === defaultPath);
    options.diagnostics.emit('approval_socket_open', {
      path: socket.path,
      fallback: socket.path !== options.path,
    });
    return gateway;
  }

  /** The path actually bound, which is the one the prompts name. */
  get path(): string {
    return this.#socket.path;
  }

  /** How many calls are waiting for a human right now. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * Gives the gateway the engine it resets breakers on.
   *
   * Late because the engine takes its gateway as a constructor port: the socket
   * has to be listening before the engine exists. A `--reset` arriving in the
   * microseconds between is answered "not ready" rather than dropped.
   */
  bindHost(host: ApprovalHost): void {
    this.#host = host;
  }

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalVerdict> {
    writeNotice(
      this.#stderr,
      'note',
      approvalPrompt(request, { socketPath: this.path, atDefaultPath: this.#atDefaultPath }),
    );
    this.#diagnostics.emit('approval_pending', {
      approvalId: request.approvalId,
      sessionId: request.sessionId,
      server: request.serverName,
      tool: request.toolName,
      timeoutMs: request.timeoutMs,
      socket: this.path,
    });

    // The tidying up lives after the `await`, not inside the handlers: a
    // promise settles once, so everything below runs exactly once however many
    // of the three routes — a verdict, the clock, an abort — got there first,
    // and none of them needs a guard against the others.
    let onAbort!: () => void;
    let timer: NodeJS.Timeout | undefined;
    const answer = await new Promise<Answer>((resolve) => {
      onAbort = (): void => {
        // See the module doc: an abandoned prompt is a denial, never a timeout.
        resolve({
          verdict: 'denied',
          reason: 'the session ended or the breaker was reset',
          source: 'abort',
        });
      };

      timer = setTimeout(() => {
        resolve({ verdict: 'timeout', reason: '', source: 'timeout' });
      }, request.timeoutMs);
      // The wrap is held open by the agent's pipe, not by a prompt nobody is
      // going to answer.
      timer.unref?.();

      signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(request.approvalId, { request, settle: resolve });

      // The engine aborts on `endSession` before it ever calls this, but a
      // signal that is *already* aborted would otherwise never fire an event.
      if (signal.aborted) onAbort();
    });

    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    this.#pending.delete(request.approvalId);
    this.#diagnostics.emit('approval_resolved', {
      approvalId: request.approvalId,
      sessionId: request.sessionId,
      verdict: answer.verdict,
      source: answer.source,
      ...(answer.reason === '' ? undefined : { reason: answer.reason }),
    });
    return answer.verdict;
  }

  /** Stops listening. Pending prompts are the engine's to abort. */
  async close(): Promise<void> {
    await this.#socket.close();
  }

  #handle(frame: CommandFrame): ReplyFrame {
    if (frame.type === 'reset') return this.#reset(frame.sessionId, frame.reason);

    const waiting = this.#pending.get(frame.approvalId);
    if (waiting === undefined) {
      return {
        v: 1,
        ok: false,
        message:
          this.#pending.size === 0
            ? `no call is waiting for approval ${frame.approvalId}; nothing is pending here`
            : `no call is waiting for approval ${frame.approvalId}; ${this.#pending.size} other prompt(s) are`,
      };
    }

    waiting.settle({
      verdict: frame.verdict === 'approved' ? 'approved' : 'denied',
      reason: frame.reason,
      source: 'cli',
    });
    return {
      v: 1,
      ok: true,
      message: `${frame.verdict === 'approved' ? 'Approved' : 'Denied'} ${waiting.request.toolName} on ${waiting.request.serverName} (session ${waiting.request.sessionId}).`,
    };
  }

  #reset(sessionId: string, reason: string): ReplyFrame {
    const host = this.#host;
    if (host === undefined) return notReady();

    const phase = host.resetBreaker(sessionId);
    if (phase === undefined) {
      return {
        v: 1,
        ok: false,
        message: `this wrap has no session ${sessionId}`,
      };
    }
    this.#diagnostics.emit('breaker_reset', {
      sessionId,
      phase,
      ...(reason === '' ? undefined : { reason }),
    });
    return {
      v: 1,
      ok: true,
      message: `Reset the breaker for session ${sessionId}.`,
      phase,
    };
  }
}

function notReady(): ReplyFrame {
  return {
    v: 1,
    ok: false,
    message: 'this wrap is still starting up; try again in a moment',
  };
}
