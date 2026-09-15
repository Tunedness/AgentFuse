/**
 * Both ends of the approval socket.
 *
 * ## This socket unblocks tool calls, so it is treated as a privilege
 *
 * Whoever can write a frame here can release a call a policy decided needed a
 * human. That makes three properties load-bearing, and each one is a test:
 *
 * 1. **The socket is mode `0600` inside a mode `0700` directory.** The
 *    directory is the real gate: on Linux and macOS the permissions on a unix
 *    socket *file* are honoured for `connect`, but a socket is created with the
 *    process umask, so there is a window between `bind` and `chmod`. A parent
 *    directory nobody else may traverse closes that window, and it is checked
 *    (and corrected) on every open rather than assumed from the `mkdir` mode,
 *    which the umask also modifies.
 * 2. **AgentFuse adopts nothing it did not create.** A path that is not a
 *    socket, or is a socket owned by another user, is never unlinked and never
 *    bound — the safe reading of "there is something in my way" is *somebody
 *    else's*, not "clean it up". A stale socket left by a process that died is
 *    detected by connecting to it and removed, because that is the ordinary
 *    case after a crash and refusing to work until the user runs `rm` would be
 *    the wrong answer to it.
 * 3. **A second wrap does not steal the first one's socket.** When the
 *    well-known path answers a connection, it belongs to a live process that is
 *    waiting for verdicts on it. The newcomer binds
 *    {@link SocketPathChoice.fallback} instead and prints that path in its
 *    prompts, so both wraps are answerable and neither is silently
 *    disconnected from the human it is waiting for.
 *
 * ## Both ends here, deliberately
 *
 * The listener and the client are the same three shapes read in opposite
 * directions, and splitting them across files is how the two drift. The
 * listener runs inside a wrap; the client is a second `agentfuse` process that
 * lives for a few milliseconds.
 */

import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { CliError, EXIT, messageOf } from '../errors.js';
import {
  type CommandFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
  parseCommandFrame,
  parseReplyFrame,
  type ReplyFrame,
  SOCKET_ENV_VAR,
} from './protocol.js';

/** How long the listener lets an idle connection sit before dropping it. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

/** How long a liveness probe waits before deciding it cannot tell. */
export const DEFAULT_PROBE_TIMEOUT_MS = 250;

/** How long the client waits for a wrap to answer. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 5_000;

/** A structured line, the same shape `Diagnostics.emit` takes. */
export type EventSink = (event: string, fields: Record<string, unknown>) => void;

/** Why a path could not be used. */
export type PathRefusal = 'live' | 'foreign' | 'not-a-socket' | 'unreadable';

/** What {@link prepareSocketPath} found. */
export type PathDisposition =
  | { readonly kind: 'ready'; readonly removedStale: boolean }
  | { readonly kind: 'refused'; readonly why: PathRefusal; readonly detail: string };

/**
 * Whether something is listening on a socket path.
 *
 * `connect` rather than a pid file or a lock: the question is precisely "will a
 * verdict written here reach anybody", and connecting is the only thing that
 * answers it. A probe that cannot decide — it neither connects nor is refused
 * within the timeout — reports `true`, because "I could not prove this socket
 * is dead" must not licence deleting it.
 */
export async function probeSocket(
  path: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Makes the directory the socket goes in, at mode 0700, and proves it is ours.
 *
 * @throws {CliError} when the directory exists and belongs to somebody else.
 */
export function ensureSocketDir(path: string, uid: number | undefined): string {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode is masked by the umask and does nothing at all when the
    // directory already existed, so the mode is set rather than requested.
    chmodSync(dir, 0o700);
  } catch (error) {
    throw new CliError(`cannot prepare the approval socket directory ${dir}`, {
      exitCode: EXIT.runtime,
      hints: [messageOf(error), `Set ${SOCKET_ENV_VAR} to a directory this user owns.`],
      cause: error,
    });
  }

  if (uid !== undefined && uid >= 0) {
    const owner = statSync(dir).uid;
    if (owner !== uid) {
      throw new CliError(`the approval socket directory ${dir} belongs to uid ${owner}`, {
        exitCode: EXIT.usage,
        hints: [
          'AgentFuse will not put a socket that releases tool calls inside a directory it does not own.',
          `Set ${SOCKET_ENV_VAR} to a path under a directory this user owns.`,
        ],
      });
    }
  }
  return dir;
}

/**
 * Decides whether a path can be bound, removing a stale socket if it finds one.
 *
 * See the module doc: the only thing this is allowed to delete is a socket that
 * belongs to this user and answers nobody.
 */
export async function prepareSocketPath(
  path: string,
  uid: number | undefined,
  probe: (path: string) => Promise<boolean> = probeSocket,
): Promise<PathDisposition> {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return { kind: 'ready', removedStale: false };
    return { kind: 'refused', why: 'unreadable', detail: messageOf(error) };
  }

  if (!info.isSocket()) {
    return {
      kind: 'refused',
      why: 'not-a-socket',
      detail: 'the path exists and is not a socket',
    };
  }
  if (uid !== undefined && uid >= 0 && info.uid !== uid) {
    return { kind: 'refused', why: 'foreign', detail: `owned by uid ${info.uid}` };
  }
  if (await probe(path)) {
    return { kind: 'refused', why: 'live', detail: 'another AgentFuse is listening on it' };
  }

  try {
    unlinkSync(path);
  } catch (error) {
    return { kind: 'refused', why: 'unreadable', detail: messageOf(error) };
  }
  return { kind: 'ready', removedStale: true };
}

/** A bound listener. */
export interface ApprovalSocket {
  /** The path actually bound, which may be the fallback. */
  readonly path: string;
  close(): Promise<void>;
}

/** How to open one. */
export interface ListenOptions {
  /** The preferred path. */
  readonly path: string;
  /** Used when {@link path} is taken. See the module doc. */
  readonly fallback?: string | undefined;
  /** Answers one command. Must not throw; a throw is answered as a failure. */
  readonly handle: (frame: CommandFrame) => ReplyFrame;
  readonly onEvent?: EventSink | undefined;
  /** This user's uid, or `undefined` where the platform has no such idea. */
  readonly uid?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly probe?: ((path: string) => Promise<boolean>) | undefined;
}

/** The listener signature, so tests can hand a fake to the gateway. */
export type SocketListener = (options: ListenOptions) => Promise<ApprovalSocket>;

function replyTo(socket: Socket, frame: ReplyFrame): void {
  socket.end(encodeFrame(frame));
}

function failure(message: string): ReplyFrame {
  return { v: 1, ok: false, message };
}

/**
 * Serves one connection: read one frame, answer it, hang up.
 *
 * Every failure mode ends in a reply and a closed socket, never in a throw. The
 * process this runs in is proxying an agent's tool calls, and a malformed frame
 * from a local client must cost that agent nothing.
 */
function serveConnection(socket: Socket, options: ListenOptions, onEvent: EventSink): void {
  socket.setEncoding('utf8');
  socket.setTimeout(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, () => {
    onEvent('approval_socket_idle', {});
    socket.destroy();
  });
  // A client that hangs up mid-write, or a reply into a closed socket, is an
  // ordinary event on this channel. An unhandled 'error' on a socket is a
  // process-level throw.
  socket.on('error', (error) => {
    onEvent('approval_socket_error', { message: messageOf(error) });
  });

  let buffered = '';
  let answered = false;
  socket.on('data', (chunk: string) => {
    if (answered) return;
    buffered += chunk;
    if (Buffer.byteLength(buffered, 'utf8') > MAX_FRAME_BYTES) {
      answered = true;
      onEvent('approval_socket_rejected', { why: 'frame too large' });
      replyTo(socket, failure(`a command frame may be at most ${MAX_FRAME_BYTES} bytes`));
      return;
    }
    const newline = buffered.indexOf('\n');
    if (newline === -1) return;
    answered = true;

    const parsed = parseCommandFrame(buffered.slice(0, newline));
    if (!parsed.ok) {
      onEvent('approval_socket_rejected', { why: parsed.error });
      replyTo(socket, failure(`AgentFuse could not read that command: ${parsed.error}`));
      return;
    }

    let reply: ReplyFrame;
    try {
      reply = options.handle(parsed.frame);
    } catch (error) {
      // A handler that throws is a bug in AgentFuse, not in the client. The
      // client still gets an answer, and the wrap still serves the agent.
      onEvent('approval_socket_handler_failed', { message: messageOf(error) });
      reply = failure('AgentFuse failed while recording that answer');
    }
    replyTo(socket, reply);
  });
}

async function bind(
  path: string,
  options: ListenOptions,
  onEvent: EventSink,
): Promise<ApprovalSocket> {
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    serveConnection(socket, options, onEvent);
  });
  server.on('error', (error) => {
    onEvent('approval_socket_error', { message: messageOf(error) });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Narrow the file as soon as it exists. The 0700 directory is what covers the
  // window between `bind` and here; see the module doc.
  chmodSync(path, 0o600);
  // The wrap's lifetime is the agent's pipe, never this. A referenced listener
  // would keep a finished wrap alive waiting for a verdict nobody will send.
  server.unref();

  return {
    path,
    close: async () => {
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        unlinkSync(path);
      } catch {
        // Node removes the path on a clean close, so this is the belt to that
        // braces — and a path already gone is the success case, not an error.
      }
    },
  };
}

/**
 * Binds the approval socket, preferring the well-known path.
 *
 * @throws {CliError} when neither path can be bound. Failing loudly at startup
 * is the point: the alternative is an operator discovering it from a tool call
 * that hung for two minutes and was then denied.
 */
export const listenApprovalSocket: SocketListener = async (options) => {
  const onEvent: EventSink = options.onEvent ?? (() => undefined);
  const candidates =
    options.fallback === undefined ? [options.path] : [options.path, options.fallback];
  const refusals: string[] = [];

  for (const candidate of candidates) {
    ensureSocketDir(candidate, options.uid);
    const disposition = await prepareSocketPath(
      candidate,
      options.uid,
      options.probe ?? probeSocket,
    );
    if (disposition.kind === 'refused') {
      refusals.push(`${candidate}: ${disposition.detail}`);
      onEvent('approval_socket_unavailable', { path: candidate, why: disposition.why });
      continue;
    }
    if (disposition.removedStale) {
      onEvent('approval_socket_stale_removed', { path: candidate });
    }
    try {
      return await bind(candidate, options, onEvent);
    } catch (error) {
      refusals.push(`${candidate}: ${messageOf(error)}`);
      onEvent('approval_socket_bind_failed', { path: candidate, message: messageOf(error) });
    }
  }

  throw new CliError('cannot open the approval socket', {
    exitCode: EXIT.runtime,
    hints: [
      ...refusals,
      'This policy asks for human approval, and without the socket there is no way to ask.',
      `Set ${SOCKET_ENV_VAR} to a free path, or remove the approval rules from the policy.`,
    ],
  });
};

/** What a client got back. */
export interface SendResult {
  readonly reply: ReplyFrame;
}

/**
 * Sends one command and reads the answer.
 *
 * @throws {CliError} when nothing is listening, the wrap does not answer in
 * time, or the answer is not a frame this version understands.
 */
export async function sendCommand(
  path: string,
  frame: CommandFrame,
  timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
): Promise<ReplyFrame> {
  return await new Promise<ReplyFrame>((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    let buffered = '';
    let settled = false;

    const finish = (outcome: { reply: ReplyFrame } | { error: CliError }): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if ('reply' in outcome) resolve(outcome.reply);
      else reject(outcome.error);
    };

    socket.setTimeout(timeoutMs, () => {
      finish({
        error: new CliError(`the wrap listening on ${path} did not answer`, {
          exitCode: EXIT.runtime,
          hints: [
            `Waited ${timeoutMs}ms.`,
            'The process may be wedged; its own stderr says what it is doing.',
          ],
        }),
      });
    });

    socket.once('connect', () => {
      socket.write(encodeFrame(frame));
    });

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        if (Buffer.byteLength(buffered, 'utf8') <= MAX_FRAME_BYTES) return;
        finish({
          error: new CliError(`the wrap listening on ${path} answered with an oversized frame`, {
            exitCode: EXIT.runtime,
          }),
        });
        return;
      }
      const parsed = parseReplyFrame(buffered.slice(0, newline));
      if (!parsed.ok) {
        finish({
          error: new CliError(`cannot read the answer from ${path}: ${parsed.error}`, {
            exitCode: EXIT.runtime,
            hints: [
              'The socket may belong to a different version of AgentFuse than the one you just ran.',
            ],
          }),
        });
        return;
      }
      finish({ reply: parsed.frame });
    });

    socket.once('error', (error) => {
      const code = (error as { code?: unknown }).code;
      const missing = code === 'ENOENT' || code === 'ECONNREFUSED';
      finish({
        error: new CliError(
          missing
            ? `nothing is waiting for an approval on ${path}`
            : `cannot reach the approval socket ${path}`,
          {
            exitCode: EXIT.usage,
            hints: missing
              ? [
                  'A wrap opens that socket only while a policy in `mode: enforce` can ask for approval.',
                  'The pending prompt on the wrap’s stderr names the exact command to run, including --socket when it is not at the default path.',
                ]
              : [messageOf(error)],
            cause: error,
          },
        ),
      });
    });
  });
}
