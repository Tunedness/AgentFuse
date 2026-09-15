/**
 * `agentfuse wrap -- <command>` — the MVP's primary mode.
 *
 * One child process, one downstream connection, one session. ADR-006 calls
 * this the exact case and it is: the session id is a ULID minted when the agent
 * connects and retired when the pipe closes, with no heuristic anywhere.
 *
 * Almost all of the machinery is already built. `createRuntime` assembles the
 * engine, the ports, the report directory, the decision hook and the semantic
 * layer; `wrapStdioServer` owns the transports, the era decision and the
 * guarded `tools/call` path. What is left — and what this file is — is the
 * lifecycle: what the flags mean, when the wrap is over, and what exit code
 * that produces.
 *
 * ## The stream rules, which are the ones that break users
 *
 * - **stdout carries protocol frames and nothing else.** In this mode the
 *   process's stdout *is* the agent's JSON-RPC stream. The only writer is the
 *   SDK's `StdioServerTransport`; this file never touches
 *   {@link CliContext.stdout} after the argument parsing is done, and
 *   `discipline.test.ts` plus the raw-byte assertions in `wrap.test.ts` keep it
 *   that way. One stray line and the client reports a parse error from a server
 *   that was working a moment ago.
 * - **The wrapped server's stderr is never touched.** The SDK spawns the child
 *   with `stderr: 'inherit'`, so those bytes go straight to this process's
 *   stderr fd without entering the process. Not "forwarded carefully" —
 *   never handled at all, which is the only implementation that cannot mangle
 *   a partial line or a non-UTF-8 byte.
 * - **AgentFuse's own output is prefixed, rate-limited and on stderr**, through
 *   the single `Diagnostics` the runtime built. `--quiet` silences it.
 *
 * ## When a wrap is over
 *
 * Four ways, and each has to leave nothing behind:
 *
 * | trigger | how it is seen | exit |
 * | --- | --- | --- |
 * | the agent goes away | `stdin` emits `end` or `close` | 0 |
 * | SIGINT / SIGTERM | the signal is forwarded to the child, then we stop | 0 |
 * | the wrapped server dies | the upstream connection closes | 70 |
 * | the child never started | a spawn error before any connection | 70 |
 *
 * The third row is the one that needs saying out loud. When the child dies the
 * downstream connection stays open, so without this the wrap would linger and
 * answer every `tools/call` with an error — an MCP client would see a working
 * server that always fails instead of a dead one it could restart.
 *
 * **What is not propagated is the child's own exit status.** The SDK's
 * `StdioClientTransport` discards it (`_process.on('close', (_code) => …)`) and
 * the proxy does not expose the `ChildProcess`, so the honest options are the
 * table above or a read of a private field that would go wrong silently on an
 * SDK upgrade. The seam that would fix it is one optional callback on
 * `StdioWrapOptions`; see the phase 6b section of `docs/implementation-status.md`.
 */

import type { StdioWrapHandle, StdioWrapOptions } from '@agentfuse/proxy';
import { wrapStdioServer } from '@agentfuse/proxy';
import { ToolCatalogue } from '../annotations.js';
import { parseArgs } from '../args.js';
import { loadPolicy } from '../config.js';
import { CliError, EXIT, messageOf } from '../errors.js';
import {
  FORWARDED_SIGNALS,
  type ForwardedSignal,
  nodeProcessHost,
  type ProcessHost,
} from '../host.js';
import { type CliContext, writeLines } from '../io.js';
import { createRuntime, DEFAULT_CLOSE_TIMEOUT_MS, type Runtime } from '../runtime.js';
import { asMode } from './shared.js';

/** Flags `wrap` accepts. Everything after the first bare `--` is the child's. */
export const WRAP_FLAGS = {
  booleans: ['quiet', 'help'],
  values: ['policy', 'mode', 'hook', 'name', 'relay', 'request-timeout'],
  aliases: {
    '-p': '--policy',
    '-h': '--help',
    '-q': '--quiet',
    '-m': '--mode',
    '-n': '--name',
  },
} as const;

/** The client capabilities `--relay` can name. */
export const RELAYABLE = ['sampling', 'elicitation', 'roots'] as const;

/**
 * Executables that are runners rather than servers, for {@link defaultServerName}.
 *
 * Only launchers whose first non-flag argument is the thing being run. A
 * general "strip the wrapper" heuristic over `sh -c`, `env` or `docker run`
 * would guess wrong more often than it helped, and a wrong alias is worse than
 * a vague one: the alias is part of every fingerprint.
 */
const RUNNERS = new Set([
  'node',
  'npx',
  'bun',
  'bunx',
  'deno',
  'python',
  'python3',
  'uv',
  'uvx',
  'tsx',
]);

/**
 * The last path segment of a command, without its extension.
 *
 * Both separators, because a Windows client configures `C:\tools\thing.exe`.
 * Written with `lastIndexOf` rather than `split().pop()` so there is no
 * unreachable fallback branch for an array that cannot be empty.
 */
function stem(token: string): string {
  const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The alias used when `--name` is not given.
 *
 * The alias is part of every fingerprint — `read_file` on two different servers
 * is not the same work — so it wants to be stable and meaningful. `node` is
 * neither, which is why a runner defers to what it is running. It is still a
 * guess, so the resolved name is reported in the `session_start` diagnostic and
 * `--name` is the way to be sure.
 */
export function defaultServerName(command: string, args: readonly string[]): string {
  const name = stem(command);
  if (!RUNNERS.has(name)) return name;
  const target = args.find((arg) => !arg.startsWith('-'));
  return target === undefined ? name : stem(target);
}

/**
 * Validates `--relay`.
 *
 * Phase 5 recorded the compromise this flag exists for: the proxy has to answer
 * the downstream `initialize` with the upstream's capabilities, so the upstream
 * connection is established before the real client has said what it supports.
 * Declaring nothing would turn sampling, elicitation and roots off permanently;
 * declaring what the proxy can relay keeps them working for the clients that
 * have them. An operator who knows their client has none can say so here, and
 * the guarded server then stops attempting pushes nobody can serve.
 *
 * @throws {CliError} for anything not in {@link RELAYABLE} or `none`.
 */
export function asRelay(value: string | undefined): StdioWrapOptions['clientCapabilities'] {
  if (value === undefined) return undefined;
  if (value === 'none') return {};

  const wanted = value.split(',').map((part) => part.trim());
  const capabilities: Record<string, Record<string, never>> = {};
  for (const name of wanted) {
    if (!(RELAYABLE as readonly string[]).includes(name)) {
      throw new CliError(`--relay does not know the capability ${name === '' ? '<empty>' : name}`, {
        hints: [
          `Accepted: ${RELAYABLE.join(', ')}, or none.`,
          'Several are comma-separated: --relay sampling,roots',
          'Omit the flag to declare all three, which is what almost every client supports.',
        ],
      });
    }
    capabilities[name] = {};
  }
  return capabilities;
}

/**
 * Validates `--request-timeout`.
 *
 * Worth a flag rather than leaving the SDK's 60 s default alone: every
 * forwarded request is sent with `resetTimeoutOnProgress`, but a tool that
 * genuinely takes ten minutes and reports no progress would be killed by a
 * timeout the agent never asked for, and AgentFuse would be the thing that
 * broke it.
 *
 * @throws {CliError} for anything that is not a positive integer.
 */
export function asMilliseconds(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive whole number of milliseconds, not ${value}`, {
      hints: ['For example: --request-timeout 600000 for ten minutes.'],
    });
  }
  return parsed;
}

/** `agentfuse wrap --help`. */
export function wrapHelp(): string[] {
  return [
    'Usage: agentfuse wrap [options] -- <command> [args...]',
    '',
    'Runs one stdio MCP server behind the breaker. The agent talks to AgentFuse,',
    'AgentFuse talks to the server, and every tools/call gets a decision first.',
    'This is the exact mode: one child process is one session, so the budgets',
    'mean precisely what they say.',
    '',
    '  --name, -n <alias>      What to call the wrapped server. Part of every',
    '                          fingerprint; guessed from the command otherwise.',
    '  --policy, -p <path>     The policy file. Searched for otherwise.',
    '  --mode, -m <mode>       warn or enforce, overriding the policy.',
    '  --hook <path>           An ES module exporting onDecision.',
    '  --relay <list>          Client capabilities to declare to the server:',
    '                          sampling, elicitation, roots, or none.',
    '  --request-timeout <ms>  Per-request timeout for forwarded calls.',
    '  --quiet, -q             Silence AgentFuse’s own stderr output.',
    '',
    'Everything after -- is the server’s own command line, untouched:',
    '',
    '  agentfuse wrap -- npx -y @modelcontextprotocol/server-filesystem /srv',
    '  agentfuse wrap --mode enforce -- node ./build/server.js --verbose',
    '',
    'stdout is the JSON-RPC stream and carries nothing else. The server’s stderr',
    'passes through untouched; AgentFuse’s own lines are prefixed [agentfuse].',
  ];
}

/** Seams `wrap.test.ts` replaces. Production uses every default. */
export interface WrapDeps {
  /** The process. See `host.ts`. */
  readonly host?: ProcessHost | undefined;
  /** The proxy's serving entry. */
  readonly serve?: ((options: StdioWrapOptions) => StdioWrapHandle) | undefined;
  /** How often to look for the opened connection. See {@link watchForConnection}. */
  readonly watchIntervalMs?: number | undefined;
  /** Bounded wait for the semantic layer at teardown. */
  readonly closeTimeoutMs?: number | undefined;
}

/**
 * How often {@link watchForConnection} looks for the opened connection.
 *
 * Small enough that the `tools/list` catalogue is in place before an agent's
 * first tool call in practice, and cheap enough not to matter: one property
 * read per tick, on an unref'd timer, only until the agent arrives.
 */
export const DEFAULT_WATCH_INTERVAL_MS = 25;

/** Everything {@link WrapDeps} leaves to production, resolved in one place. */
export interface WrapWiring {
  readonly host: ProcessHost;
  readonly serve: (options: StdioWrapOptions) => StdioWrapHandle;
  readonly watchIntervalMs: number;
  readonly closeTimeoutMs: number;
}

/**
 * Applies the production defaults.
 *
 * One function rather than four `??`s in the middle of the lifecycle: the real
 * process host and the real serving entry are precisely the two things a test
 * cannot exercise in-process, so putting the choice here lets the defaults be
 * asserted as values while the lifecycle around them is driven by fakes.
 */
export function wrapWiring(deps: WrapDeps): WrapWiring {
  return {
    host: deps.host ?? nodeProcessHost(),
    serve: deps.serve ?? wrapStdioServer,
    watchIntervalMs: deps.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
    closeTimeoutMs: deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
  };
}

/** Why a wrap finished. */
type EndReason = 'agent-closed' | 'signal' | 'server-gone' | 'startup-failed';

/** What each ending is worth to the shell. */
const EXIT_FOR: Record<EndReason, number> = {
  // The agent hung up. That is how a wrap is supposed to end.
  'agent-closed': EXIT.ok,
  // A supervisor asked us to stop and we did.
  signal: EXIT.ok,
  // The wrapped server died under us. The run failed, whatever the agent thinks.
  'server-gone': EXIT.runtime,
  // Never got off the ground: a bad command, a missing binary, a refused spawn.
  'startup-failed': EXIT.runtime,
};

/**
 * Whether an error reported before the connection opened means the wrap can
 * never work.
 *
 * The child is spawned when the agent connects, so a failure there arrives as
 * an out-of-band error with no bridge behind it. Matching on the message is
 * unlovely but it is what `spawn` gives us, and the alternative — treating
 * *every* pre-connection error as fatal — would kill a wrap over a malformed
 * opening frame that the SDK was about to answer and carry on from.
 */
export function isStartupFailure(error: Error): boolean {
  return /\b(?:ENOENT|EACCES|EPERM|ENOTDIR|EAGAIN)\b|^spawn /.test(error.message);
}

/**
 * The wrapped server's pid, if it can be seen.
 *
 * Read structurally rather than imported: `Bridge.client.transport` is typed as
 * the SDK's `Transport`, which does not declare `pid` — `StdioClientTransport`
 * adds it as a public getter. A guarded read of a documented public member is
 * the honest version of this; `undefined` simply means no signal gets forwarded
 * and teardown falls back to closing the transport, which the SDK escalates to
 * SIGTERM and then SIGKILL by itself.
 */
function childPid(handle: StdioWrapHandle): number | undefined {
  const transport: unknown = handle.bridge?.client.transport;
  const pid = (transport as { readonly pid?: unknown } | undefined)?.pid;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

/**
 * Notices the moment the agent connects, and reacts to it once.
 *
 * `wrapStdioServer` spawns the child when the connection opens and exposes the
 * resulting bridge as a getter — with no callback alongside it. Two things the
 * CLI owns need that moment: the `tools/list` catalogue, and learning that the
 * upstream has gone away. Re-implementing the proxy's factory here to get a
 * callback would mean constructing the MCP client in this package, which is a
 * layer this package deliberately does not have.
 *
 * So: one unref'd interval that stops at the first connection. It holds nothing
 * open, it costs one property read per tick until the agent shows up, and it is
 * the seam an `onConnect` on `StdioWrapHandle` would replace outright.
 */
function watchForConnection(
  handle: StdioWrapHandle,
  intervalMs: number,
  onOpen: (bridge: NonNullable<StdioWrapHandle['bridge']>) => void,
): () => void {
  const timer = setInterval(() => {
    const bridge = handle.bridge;
    if (bridge === undefined) return;
    clearInterval(timer);
    onOpen(bridge);
  }, intervalMs);
  // Unref'd: the wrap is held open by the agent's pipe, not by this.
  timer.unref();
  return () => clearInterval(timer);
}

/** Runs `agentfuse wrap`. */
export async function runWrap(
  context: CliContext,
  argv: readonly string[],
  deps: WrapDeps = {},
): Promise<number> {
  const args = parseArgs(argv, WRAP_FLAGS);
  if (args.bool('help')) {
    writeLines(context.stdout, wrapHelp());
    return EXIT.ok;
  }

  const [command, ...childArgs] = args.rest;
  if (command === undefined) {
    throw new CliError('wrap needs a command to run, after a bare --', {
      hints: [
        'For example: agentfuse wrap -- npx -y @modelcontextprotocol/server-filesystem /srv',
        ...(args.positionals.length > 0
          ? [
              `The -- matters: without it, ${args.positionals[0]}’s own flags would be read as AgentFuse’s.`,
            ]
          : []),
      ],
    });
  }

  const clientCapabilities = asRelay(args.value('relay'));
  const requestTimeoutMs = asMilliseconds('--request-timeout', args.value('request-timeout'));
  const serverName = args.value('name') ?? defaultServerName(command, childArgs);
  const policyFlag = args.value('policy');
  const hook = args.value('hook');

  const loaded = loadPolicy({
    ...(policyFlag !== undefined ? { flag: policyFlag } : undefined),
    env: context.env,
    cwd: context.cwd,
  });
  const runtime = await createRuntime({
    loaded,
    context,
    quiet: args.bool('quiet'),
    mode: asMode(args.value('mode')),
    ...(hook !== undefined ? { hook } : undefined),
  });

  return await serveWrap({
    command,
    childArgs,
    serverName,
    runtime,
    deps,
    ...(clientCapabilities !== undefined ? { clientCapabilities } : undefined),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : undefined),
  });
}

/** Everything {@link serveWrap} needs, once the arguments have been read. */
interface ServeWrapOptions {
  readonly command: string;
  readonly childArgs: readonly string[];
  readonly serverName: string;
  readonly runtime: Runtime;
  readonly deps: WrapDeps;
  readonly clientCapabilities?: StdioWrapOptions['clientCapabilities'];
  readonly requestTimeoutMs?: number;
}

/**
 * Runs the wrap to its end and returns the exit code.
 *
 * Split from {@link runWrap} so the lifecycle is one function with no argument
 * parsing in it: the four endings, the teardown and nothing else.
 */
async function serveWrap(options: ServeWrapOptions): Promise<number> {
  const { runtime } = options;
  const { host, serve, watchIntervalMs, closeTimeoutMs } = wrapWiring(options.deps);
  const diagnostics = runtime.diagnostics;

  const catalogue = new ToolCatalogue({
    trustHints: runtime.policy.annotations.trust_hints,
    onEvent: (event, fields) => diagnostics.emit(event, fields),
  });

  // Declared without an initialiser rather than with a no-op one: the executor
  // runs synchronously, so the assertion is true, and a placeholder that can
  // never be called is a line nobody can test.
  let finish!: (reason: EndReason) => void;
  const ended = new Promise<EndReason>((resolve) => {
    let settled = false;
    // Once-only, because every ending races with every other: a signal during
    // teardown, or a child dying because we just closed its pipe.
    finish = (reason) => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };
  });

  // Bound after `serve` returns, but `onError` closes over it: a spawn failure
  // is reported from inside the connection factory, which runs when the agent
  // arrives — long after this. The holder keeps that read out of the temporal
  // dead zone even so, because a serving entry is free to report synchronously.
  let live: StdioWrapHandle | undefined;

  const handle = serve({
    command: options.command,
    args: options.childArgs,
    engine: runtime.engine,
    serverName: options.serverName,
    // The runtime's instance, not a second one: two `Diagnostics` would mean
    // two rate-limit windows, and the startup warnings would be counted apart
    // from the trips.
    diagnostics,
    writeReport: runtime.writeReport,
    onSessionEnd: runtime.onSessionEnd,
    annotationsFor: catalogue.annotationsFor,
    // Absent unless telemetry is on, and then it re-parents the guarded
    // server's work onto AgentFuse's span. See `runtime.traceparentFor`.
    ...(runtime.traceparentFor !== undefined
      ? { traceparentFor: runtime.traceparentFor }
      : undefined),
    ...(options.clientCapabilities !== undefined
      ? { clientCapabilities: options.clientCapabilities }
      : undefined),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : undefined),
    onError: (error) => {
      if (live?.bridge === undefined && isStartupFailure(error)) {
        diagnostics.emit('child_spawn_failed', {
          command: options.command,
          message: error.message,
        });
        finish('startup-failed');
      }
    },
  });

  live = handle;

  const stopWatching = watchForConnection(handle, watchIntervalMs, (bridge) => {
    // `client.onclose` is unclaimed: the bridge takes the fallback handlers and
    // `wrapStdioServer` takes `onerror`, so this is free to use and fires both
    // when the child dies on its own and when teardown closes the transport.
    // `finish` is once-only, so the teardown case is already settled by then.
    bridge.client.onclose = () => finish('server-gone');
    void catalogue.prime(bridge.client);
  });

  const onAgentGone = (): void => finish('agent-closed');
  host.stdin.on('end', onAgentGone);
  host.stdin.on('close', onAgentGone);

  const signalHandlers = new Map<ForwardedSignal, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const listener = (): void => {
      // Forwarded by name rather than by closing the pipe: a server that
      // handles SIGINT specially — flushing, releasing a lock — should get the
      // signal the operator sent, not a SIGTERM the SDK escalates to.
      const pid = childPid(handle);
      const forwarded = pid !== undefined && host.kill(pid, signal);
      diagnostics.emit('signal', {
        signal,
        forwarded,
        ...(pid !== undefined ? { pid } : undefined),
      });
      finish('signal');
    };
    signalHandlers.set(signal, listener);
    host.onSignal(signal, listener);
  }

  const reason = await ended;

  stopWatching();
  host.stdin.off('end', onAgentGone);
  host.stdin.off('close', onAgentGone);
  for (const [signal, listener] of signalHandlers) host.offSignal(signal, listener);

  diagnostics.emit('wrap_end', { reason, server: options.serverName });

  // Both, in this order, and neither allowed to take the process down: the
  // connection and the child first, then the semantic layer with its bounded
  // wait. A shutdown that throws on the way out would replace the reason the
  // wrap ended with a stack trace about the tidying up.
  try {
    await handle.close();
  } catch (error) {
    diagnostics.emit('close_failed', { message: messageOf(error) });
  }
  await runtime.close({ timeoutMs: closeTimeoutMs });

  return EXIT_FOR[reason];
}
