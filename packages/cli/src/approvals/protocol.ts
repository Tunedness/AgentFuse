/**
 * The wire between a blocked tool call and the human who answers it.
 *
 * A `require_approval` decision suspends a `tools/call` inside the wrap process.
 * The person who has to answer is somewhere else entirely — another terminal,
 * usually — so there has to be a channel, and the channel has to be one a
 * second `agentfuse` invocation can open with no configuration.
 *
 * ## Why a unix socket and not a file, a port or a signal
 *
 * A file would need polling and would leave the verdict lying about on disk. A
 * TCP port is reachable by anything on the machine — and by anything that can
 * make a browser issue a request — for a channel whose whole purpose is to
 * *unblock a tool call*. A signal carries no payload. A unix socket is
 * filesystem-permissioned, needs no port allocation, and cannot be reached from
 * a page the user happens to have open.
 *
 * ## The frames
 *
 * Newline-delimited JSON, one command per connection, one reply, close. There
 * is no session, no handshake and no streaming, because there is nothing to
 * stream: the client has exactly one thing to say.
 *
 * Every frame carries `v`. A future AgentFuse that changes the shape must be
 * able to tell an old client "your `agentfuse` is older than the wrap you are
 * talking to" rather than mis-read its fields, and the two processes are
 * genuinely allowed to be different versions — one of them was launched by an
 * MCP client months ago and the other was just typed.
 *
 * Nothing here does I/O. `socket.ts` owns both ends of the pipe; this file is
 * paths, shapes and validation, so the validation can be tested against
 * malformed input without a socket in the picture.
 */

import { isAbsolute, join } from 'node:path';
import { CliError, EXIT } from '../errors.js';

/** The frame version both ends of the socket speak. */
export const APPROVAL_PROTOCOL_VERSION = 1;

/**
 * The biggest command frame the listener will buffer, in bytes.
 *
 * The socket unblocks tool calls, so the reachability argument above is the
 * main defence — but a local process that can connect must not be able to make
 * the wrap grow without bound by sending a gigabyte with no newline in it. A
 * verdict is a few hundred bytes; 8 KiB is room for a long `--reason` and
 * nothing else.
 */
export const MAX_FRAME_BYTES = 8 * 1024;

/** The longest `--reason` the listener accepts. Longer is a mistake, not a reason. */
export const MAX_REASON_LENGTH = 1024;

/** The longest id the listener accepts. A ULID is 26 characters. */
export const MAX_ID_LENGTH = 128;

/** The environment variable that overrides the socket location. */
export const SOCKET_ENV_VAR = 'AGENTFUSE_APPROVAL_SOCKET';

/** The socket's filename under the resolved directory. */
export const SOCKET_BASENAME = 'approvals.sock';

/** The directory AgentFuse keeps its own per-user state in, under `$HOME`. */
export const HOME_DIRNAME = '.agentfuse';

/**
 * How long a socket path may be.
 *
 * `sun_path` is 104 bytes on macOS and 108 on Linux, including the terminator,
 * and the kernel does not truncate — it refuses. A `$HOME` deep enough to cross
 * that line produces an `EINVAL` from `bind` that says nothing about paths, so
 * the length is checked here and reported with the variable that fixes it.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/** A human's answer to one pending approval. */
export interface VerdictFrame {
  readonly v: typeof APPROVAL_PROTOCOL_VERSION;
  readonly type: 'verdict';
  readonly approvalId: string;
  readonly verdict: 'approved' | 'denied';
  /** Why. Recorded in the diagnostic line; see the module doc in `cli-gateway.ts`. */
  readonly reason: string;
}

/** An operator closing a broken circuit by hand. */
export interface ResetFrame {
  readonly v: typeof APPROVAL_PROTOCOL_VERSION;
  readonly type: 'reset';
  readonly sessionId: string;
  readonly reason: string;
}

/** Anything a client may send. */
export type CommandFrame = VerdictFrame | ResetFrame;

/** What the listener sends back. Exactly one per command. */
export interface ReplyFrame {
  readonly v: typeof APPROVAL_PROTOCOL_VERSION;
  readonly ok: boolean;
  /** One line written for the person who typed the command. */
  readonly message: string;
  /** The breaker phase after a reset, so the answer states what actually happened. */
  readonly phase?: string;
}

/** The result of reading a frame off the wire. */
export type FrameParse<T> =
  | { readonly ok: true; readonly frame: T }
  | { readonly ok: false; readonly error: string };

/** Serialises one frame, newline included. */
export function encodeFrame(frame: CommandFrame | ReplyFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asId(value: unknown, field: string): FrameParse<string> {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, error: `${field} must be a non-empty string` };
  }
  if (value.length > MAX_ID_LENGTH) return { ok: false, error: `${field} is implausibly long` };
  return { ok: true, frame: value };
}

function asReason(value: unknown): FrameParse<string> {
  if (typeof value !== 'string') return { ok: false, error: 'reason must be a string' };
  if (value.length > MAX_REASON_LENGTH) return { ok: false, error: 'reason is too long' };
  return { ok: true, frame: value };
}

/**
 * Reads one command frame.
 *
 * Total validation rather than a cast. The bytes come from a socket, and the
 * only thing on the other end of that socket that AgentFuse knows anything
 * about is a version of itself it has never met. A frame that does not validate
 * is answered and the connection closed — never thrown, because the process
 * this runs in is proxying an agent's tool calls and must survive anything a
 * local client says to it.
 */
export function parseCommandFrame(line: string): FrameParse<CommandFrame> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: 'not JSON' };
  }

  const record = asRecord(parsed);
  if (record === undefined) return { ok: false, error: 'not a JSON object' };
  if (record['v'] !== APPROVAL_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `unsupported frame version ${JSON.stringify(record['v'])}; this AgentFuse speaks ${APPROVAL_PROTOCOL_VERSION}`,
    };
  }

  const reason = asReason(record['reason']);
  if (!reason.ok) return reason;

  if (record['type'] === 'verdict') {
    const approvalId = asId(record['approvalId'], 'approvalId');
    if (!approvalId.ok) return approvalId;
    const verdict = record['verdict'];
    if (verdict !== 'approved' && verdict !== 'denied') {
      return { ok: false, error: 'verdict must be "approved" or "denied"' };
    }
    return {
      ok: true,
      frame: {
        v: APPROVAL_PROTOCOL_VERSION,
        type: 'verdict',
        approvalId: approvalId.frame,
        verdict,
        reason: reason.frame,
      },
    };
  }

  if (record['type'] === 'reset') {
    const sessionId = asId(record['sessionId'], 'sessionId');
    if (!sessionId.ok) return sessionId;
    return {
      ok: true,
      frame: {
        v: APPROVAL_PROTOCOL_VERSION,
        type: 'reset',
        sessionId: sessionId.frame,
        reason: reason.frame,
      },
    };
  }

  return { ok: false, error: `unknown command ${JSON.stringify(record['type'])}` };
}

/** Reads the listener's answer. Same totality, for the same reason, inverted. */
export function parseReplyFrame(line: string): FrameParse<ReplyFrame> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  const record = asRecord(parsed);
  if (record === undefined) return { ok: false, error: 'not a JSON object' };
  if (record['v'] !== APPROVAL_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `the wrap answered with frame version ${JSON.stringify(record['v'])}, and this AgentFuse speaks ${APPROVAL_PROTOCOL_VERSION}`,
    };
  }
  if (typeof record['ok'] !== 'boolean') return { ok: false, error: 'ok must be a boolean' };
  const message = record['message'];
  const phase = record['phase'];
  return {
    ok: true,
    frame: {
      v: APPROVAL_PROTOCOL_VERSION,
      ok: record['ok'],
      message: typeof message === 'string' ? message : '',
      ...(typeof phase === 'string' ? { phase } : undefined),
    },
  };
}

/** Where the socket goes, and why there. */
export interface SocketPathChoice {
  readonly path: string;
  /** Which rule picked it, for the diagnostic line. */
  readonly origin: 'env' | 'xdg' | 'home';
  /**
   * The path to use when {@link path} is held by a live process.
   *
   * A second wrap **never** takes the first one's socket. It takes this one
   * instead and prints it in its prompts, so both are answerable — see
   * `socket.ts`.
   */
  readonly fallback: string;
}

/** `/x/approvals.sock` → `/x/approvals-4242.sock`. */
function siblingFor(path: string, suffix: string): string {
  return path.endsWith('.sock')
    ? `${path.slice(0, -'.sock'.length)}-${suffix}.sock`
    : `${path}.${suffix}`;
}

function checkLength(path: string): string {
  if (Buffer.byteLength(path, 'utf8') <= MAX_SOCKET_PATH_BYTES) return path;
  throw new CliError(`the approval socket path is too long: ${path}`, {
    exitCode: EXIT.usage,
    hints: [
      `A unix socket path may be about ${MAX_SOCKET_PATH_BYTES} bytes; this one is ${Buffer.byteLength(path, 'utf8')}.`,
      `Set ${SOCKET_ENV_VAR} to something shorter, for example /tmp/agentfuse.sock.`,
    ],
  });
}

/**
 * Works out where the approval socket lives.
 *
 * Three rules, in order:
 *
 * 1. **`AGENTFUSE_APPROVAL_SOCKET`** — an absolute path, taken as an
 *    instruction. It exists because an MCP client's server configuration can
 *    set `env` but usually cannot choose `$HOME` or the working directory, so
 *    for some setups this is the only channel — the same argument that put
 *    `AGENTFUSE_POLICY` in `config.ts`.
 * 2. **`$XDG_RUNTIME_DIR/agentfuse/approvals.sock`** — the correct location on
 *    Linux and the reason this rule exists at all. That directory is a
 *    per-user tmpfs, mode 0700, owned by the user and *removed at logout*, so a
 *    socket left behind by a killed process cannot outlive the session. `$HOME`
 *    offers none of that and may be NFS, where unix sockets range from
 *    unreliable to unsupported.
 * 3. **`$HOME/.agentfuse/approvals.sock`** — everywhere else, macOS included,
 *    where `XDG_RUNTIME_DIR` is conventionally unset. The directory is created
 *    mode 0700 and checked, which is what recovers the guarantee rule 2 gets
 *    from the operating system.
 */
export function resolveApprovalSocketPath(
  env: Readonly<Record<string, string | undefined>>,
  suffix: string,
): SocketPathChoice {
  const override = env[SOCKET_ENV_VAR];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new CliError(`${SOCKET_ENV_VAR} must be an absolute path, not ${override}`, {
        exitCode: EXIT.usage,
        hints: [
          'A relative socket path would resolve against whatever directory the MCP client happened to launch AgentFuse in.',
        ],
      });
    }
    return {
      path: checkLength(override),
      origin: 'env',
      fallback: checkLength(siblingFor(override, suffix)),
    };
  }

  const runtimeDir = env['XDG_RUNTIME_DIR'];
  if (runtimeDir !== undefined && isAbsolute(runtimeDir)) {
    const path = join(runtimeDir, 'agentfuse', SOCKET_BASENAME);
    return {
      path: checkLength(path),
      origin: 'xdg',
      fallback: checkLength(siblingFor(path, suffix)),
    };
  }

  const home = env['HOME'] ?? env['USERPROFILE'];
  if (home !== undefined && home !== '' && isAbsolute(home)) {
    const path = join(home, HOME_DIRNAME, SOCKET_BASENAME);
    return {
      path: checkLength(path),
      origin: 'home',
      fallback: checkLength(siblingFor(path, suffix)),
    };
  }

  throw new CliError('cannot work out where to put the approval socket', {
    exitCode: EXIT.usage,
    hints: [
      'Neither HOME nor XDG_RUNTIME_DIR is set to an absolute path in this environment.',
      `Set ${SOCKET_ENV_VAR} to the path the socket should live at.`,
    ],
  });
}
