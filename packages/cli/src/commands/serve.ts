/**
 * `agentfuse serve` — the HTTP endpoint, and an honest account of what it is.
 *
 * ## What it does
 *
 * Binds a real Streamable-HTTP-shaped endpoint and runs the **ADR-006 session
 * identity ladder** on every request that arrives: `traceparent` in `_meta`,
 * then the `tunedness.session-id` baggage member, then `Mcp-Session-Id` in the
 * legacy era only, then the best-effort hash of `clientInfo` and the peer's
 * address bounded by `session.idle_timeout`. It reports which rung answered, in
 * the response and in a diagnostic, using the proxy's own
 * `describeSessionRegime` — ADR-006's consequence clause is that a budget which
 * is exact in one mode and heuristic in another must never look the same.
 *
 * It also loads and reports the policy exactly as `wrap` does, so a policy
 * error, a missing embedding backend or an unimplemented approval gateway is
 * discovered here rather than on the first tool call.
 *
 * ## What it does not do, and why that is not a shortcut
 *
 * **It does not forward tool calls.** Guarding traffic needs an upstream MCP
 * connection per downstream connection — that topology is
 * `bridge.ts`'s opening paragraph, and multiplexing several downstream
 * connections onto one upstream breaks sampling, elicitation, roots and
 * multi-round-trip requests, because in the legacy era the server pushes those
 * without naming the caller.
 *
 * Over HTTP the SDK's entry (`createMcpHandler`) builds a server instance **per
 * HTTP request**, so a correct gateway needs a pool of upstream connections
 * keyed by the session this ladder resolves. Phase 5 recorded that as P1 with
 * its own ADR, for a structural reason rather than a matter of effort: the
 * factory context carries the HTTP `Request` but not the parsed `_meta`, so the
 * rungs that live in `_meta` can only be read while a request is being handled,
 * not when its instance is built. A handler that quietly opened one upstream
 * connection per HTTP request would look like it worked and cost a process
 * spawn per tool call.
 *
 * So every MCP method is answered with a JSON-RPC error that says so and names
 * `agentfuse wrap`, which *is* the guarded path and is exact. The alternative —
 * refusing to start — would throw away the parts that are finished and useful:
 * the endpoint proves reachability through whatever proxy or load balancer sits
 * in front of it, and it shows an operator exactly which session key their
 * agent's requests resolve to before they depend on it.
 *
 * ## What P1 replaces
 *
 * One line. `http.ts` is written to the Fetch contract `createMcpHandler`
 * answers, so the gateway lands as a different {@link FetchHandler} behind the
 * same endpoint, with the same flags, the same policy loading and the same
 * ladder.
 */

import { describeSessionRegime, detectRequestEra, SessionKeyResolver } from '@agentfuse/proxy';
import { parseArgs } from '../args.js';
import { loadPolicy } from '../config.js';
import { CliError, EXIT, messageOf } from '../errors.js';
import {
  FORWARDED_SIGNALS,
  type ForwardedSignal,
  nodeProcessHost,
  type ProcessHost,
} from '../host.js';
import {
  type FetchHandler,
  type HttpEndpoint,
  type HttpEndpointOptions,
  startHttpEndpoint,
} from '../http.js';
import { type CliContext, writeNotice } from '../io.js';
import { createRuntime, DEFAULT_CLOSE_TIMEOUT_MS } from '../runtime.js';
import { asMode } from './shared.js';

/** Flags `serve` accepts. The upstream target comes after a bare `--`. */
export const SERVE_FLAGS = {
  booleans: ['quiet', 'help'],
  values: ['policy', 'mode', 'hook', 'name', 'port', 'host', 'path'],
  aliases: {
    '-p': '--policy',
    '-h': '--help',
    '-q': '--quiet',
    '-m': '--mode',
    '-n': '--name',
  },
} as const;

/** Where the endpoint listens when `--port` is not given. */
export const DEFAULT_PORT = 8765;

/**
 * What the endpoint binds when `--host` is not given.
 *
 * Loopback, not `0.0.0.0`. An endpoint that meters somebody's agent budget is
 * not a thing to expose to the network by default, and an operator who wants it
 * reachable is in a better position to say so than this default is.
 */
export const DEFAULT_HOST = '127.0.0.1';

/** The route the MCP endpoint answers on. */
export const DEFAULT_PATH = '/mcp';

/** JSON-RPC's "this endpoint does not implement that". */
const METHOD_NOT_FOUND = -32601;

/** JSON-RPC's "the request was not a request". */
const INVALID_REQUEST = -32600;

/** JSON-RPC's "that was not JSON". */
const PARSE_ERROR = -32700;

/**
 * Validates `--port`.
 *
 * `0` is accepted and means "ask the operating system", which is what the tests
 * use and what a supervisor injecting a port sometimes wants.
 *
 * @throws {CliError} for anything outside 0…65535.
 */
export function asPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // `Number('')` is 0, and 0 is a meaningful port here: `--port=` would
  // otherwise quietly mean "ask the operating system".
  const port = value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CliError(`--port must be a whole number between 0 and 65535, not ${value}`, {
      hints: [
        `Omit the flag to use ${DEFAULT_PORT}.`,
        'Use --port 0 to let the operating system pick a free one.',
      ],
    });
  }
  return port;
}

/** `agentfuse serve --help`. */
export function serveHelp(): string[] {
  return [
    'Usage: agentfuse serve [options] -- <command> [args...]',
    '',
    'Binds an HTTP endpoint and resolves session identity for every request it',
    'receives, following the ladder AgentFuse meters budgets against: the',
    'traceparent in _meta, then the tunedness.session-id baggage member, then',
    'Mcp-Session-Id on a legacy-era request, then a best-effort hash of the',
    'caller and its address bounded by session.idle_timeout.',
    '',
    '  --port <n>        Port to bind. Default 8765; 0 asks the OS for one.',
    '  --host <addr>     Address to bind. Default 127.0.0.1, i.e. loopback only.',
    '  --path <route>    Route for the MCP endpoint. Default /mcp.',
    '  --name, -n <n>    What to call the server this endpoint will guard.',
    '  --policy, -p <p>  The policy file. Searched for otherwise.',
    '  --mode, -m <m>    warn or enforce, overriding the policy.',
    '  --hook <path>     An ES module exporting onDecision.',
    '  --quiet, -q       Silence AgentFuse’s own stderr output.',
    '',
    'WHAT THIS BUILD DOES NOT DO: it does not forward tool calls. Guarding',
    'traffic needs one upstream connection per downstream connection, and over',
    'HTTP that means a connection pool keyed by the resolved session — which is',
    'the P1 gateway and has its own design to settle. Multiplexing callers onto',
    'one upstream instead would break sampling, elicitation and roots, quietly.',
    'So every MCP method here is answered with a JSON-RPC error naming the',
    'session it resolved and pointing at `agentfuse wrap`, which is the guarded',
    'path and is exact: one child process is one session.',
    '',
    'What it is good for today: proving the endpoint is reachable through your',
    'proxy or load balancer, and seeing which session key your agent’s requests',
    'resolve to before you depend on it. GET /healthz reports the policy in',
    'force. The command line is already the one the gateway will take.',
  ];
}

/** Seams `serve.test.ts` replaces. */
export interface ServeDeps {
  readonly host?: ProcessHost | undefined;
  /** Injected so a test can listen on an ephemeral port it controls. */
  readonly listen?: ((options: HttpEndpointOptions) => Promise<HttpEndpoint>) | undefined;
  readonly closeTimeoutMs?: number | undefined;
  /** Called once the endpoint is up, so a test can drive it and then stop it. */
  readonly onListening?: ((endpoint: HttpEndpoint) => void) | undefined;
}

/** Everything {@link ServeDeps} leaves to production, resolved in one place. */
export interface ServeWiring {
  readonly host: ProcessHost;
  readonly listen: (options: HttpEndpointOptions) => Promise<HttpEndpoint>;
  readonly closeTimeoutMs: number;
}

/** Applies the production defaults. See `wrapWiring` for why this is a function. */
export function serveWiring(deps: ServeDeps): ServeWiring {
  return {
    host: deps.host ?? nodeProcessHost(),
    listen: deps.listen ?? startHttpEndpoint,
    closeTimeoutMs: deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
  };
}

/** An untyped view of one inbound JSON-RPC message. */
interface WireRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly _meta?: unknown } | undefined;
  readonly _meta?: unknown;
}

/** A JSON-RPC id, as far as an error response needs it. */
type WireId = string | number | null;

/** The id to answer with: anything else is not addressable. */
function idOf(message: WireRequest): WireId {
  const { id } = message;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * The `_meta` bag the ladder reads.
 *
 * On the wire nothing has lifted the reserved `io.modelcontextprotocol/*` keys
 * out yet — that is something the SDK's dispatch does — so `params._meta` holds
 * both the trace keys and the envelope. A top-level `_meta`, which some callers
 * send, is merged underneath it.
 *
 * HTTP `traceparent` and `baggage` *headers* are deliberately not read.
 * ADR-006 places those rungs in `_meta` (SEP-414), and the chaining contract
 * with McpGuard is that an outer proxy injects the baggage member there. A
 * second source would mean two answers to "which session is this" and no rule
 * for which wins.
 */
function metaOf(message: WireRequest): Record<string, unknown> | undefined {
  const top = asBag(message._meta);
  const inner = asBag(message.params?._meta);
  if (top === undefined && inner === undefined) return undefined;
  return { ...top, ...inner };
}

function asBag(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A JSON response, which is every response this endpoint gives. */
function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

/** What the endpoint reports about itself. */
export interface ServeInfo {
  readonly path: string;
  readonly serverName: string;
  readonly target: readonly string[];
  readonly mode: string;
  readonly policyPath: string;
  readonly policySha256: string;
  readonly sessionKey: string;
  readonly reportDir: string;
}

/** The refusal every MCP method gets, and the reason it is a refusal. */
export function unsupportedMethod(method: string, serverName: string): string {
  return [
    `agentfuse serve resolves session identity but does not forward ${method}.`,
    `Guarding tool calls needs one upstream connection to ${serverName} per downstream`,
    'connection; over HTTP that is a connection pool keyed by the resolved session, which',
    'is the P1 gateway. Use `agentfuse wrap -- <command>` for the guarded path.',
  ].join(' ');
}

/**
 * Builds the endpoint's Fetch handler.
 *
 * Exported so it can be tested against `Request` objects directly, with no
 * socket in the way, as well as through one.
 */
export function createServeHandler(options: {
  readonly info: ServeInfo;
  readonly resolver: SessionKeyResolver;
  readonly onEvent: (event: string, fields: Record<string, unknown>) => void;
}): FetchHandler {
  const { info, resolver, onEvent } = options;

  return async (request, context) => {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return request.method === 'GET'
        ? json(200, { status: 'ok', ...info })
        : json(405, { error: 'healthz is a GET' }, { allow: 'GET' });
    }

    if (url.pathname !== info.path) {
      return json(404, {
        error: `nothing is served at ${url.pathname}`,
        endpoint: info.path,
      });
    }

    if (request.method !== 'POST') {
      // Spec-legal: a server that offers no server-initiated stream answers
      // GET with 405, and this endpoint has nothing to stream.
      return json(
        405,
        { error: `${info.path} takes POST; this endpoint opens no server-initiated stream` },
        { allow: 'POST' },
      );
    }

    let message: WireRequest;
    try {
      message = (await request.json()) as WireRequest;
    } catch {
      return json(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: PARSE_ERROR, message: 'the request body was not JSON' },
      });
    }

    if (asBag(message) === undefined || typeof message.method !== 'string') {
      return json(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: INVALID_REQUEST, message: 'the body was not a JSON-RPC request' },
      });
    }

    const meta = metaOf(message);
    const era = detectRequestEra({ meta });
    const resolution = resolver.resolve({
      meta,
      // The legacy-era rung only. The modern revision removed the header, and
      // honouring it there would invent a session the protocol says is gone.
      ...(era === 'legacy'
        ? { mcpSessionId: request.headers.get('mcp-session-id') ?? undefined }
        : undefined),
      remoteAddress: context.remoteAddress,
    });
    const regime = describeSessionRegime(resolution);

    onEvent('http_request', {
      method: message.method,
      era,
      ...(resolution !== undefined
        ? { sessionId: resolution.sessionId, source: resolution.source, exact: resolution.exact }
        : { sessionId: null }),
    });

    const id = idOf(message);
    if (id === null) {
      // A notification. Acknowledged and dropped, which is what a stateless
      // endpoint that cannot act on it is allowed to do.
      return new Response(null, { status: 202 });
    }

    return json(200, {
      jsonrpc: '2.0',
      id,
      error: {
        code: METHOD_NOT_FOUND,
        message: unsupportedMethod(message.method, info.serverName),
        // The useful half: what the ladder made of this request. An operator
        // pointing their agent at this endpoint learns which rung answers and
        // whether the answer is exact, before any budget depends on it.
        data: {
          era,
          session:
            resolution === undefined
              ? null
              : {
                  id: resolution.sessionId,
                  source: resolution.source,
                  exact: resolution.exact,
                },
          regime,
          guardedPath: 'agentfuse wrap -- <command>',
        },
      },
    });
  };
}

/** Runs `agentfuse serve`. */
export async function runServe(
  context: CliContext,
  argv: readonly string[],
  deps: ServeDeps = {},
): Promise<number> {
  const args = parseArgs(argv, SERVE_FLAGS);
  if (args.bool('help')) {
    // Straight to stdout, and the only thing this command ever puts there:
    // unlike `wrap`, nothing else is using the stream, but keeping the habit
    // is cheaper than remembering which command is which.
    context.stdout.write(`${serveHelp().join('\n')}\n`);
    return EXIT.ok;
  }

  const [command, ...targetArgs] = args.rest;
  if (command === undefined) {
    throw new CliError('serve needs the command of the server it will guard, after a bare --', {
      hints: [
        'For example: agentfuse serve --port 8765 -- npx -y @modelcontextprotocol/server-filesystem /srv',
        'The command line is the one the P1 gateway will take, so a configuration written now keeps working.',
        'This build resolves session identity and does not forward calls; `agentfuse wrap` is the guarded path.',
      ],
    });
  }

  const port = asPort(args.value('port')) ?? DEFAULT_PORT;
  const bindHost = args.value('host') ?? DEFAULT_HOST;
  const path = args.value('path') ?? DEFAULT_PATH;
  const serverName = args.value('name') ?? command;
  const policyFlag = args.value('policy');
  const hookFlag = args.value('hook');
  const quiet = args.bool('quiet');

  const loaded = loadPolicy({
    ...(policyFlag !== undefined ? { flag: policyFlag } : undefined),
    env: context.env,
    cwd: context.cwd,
  });
  const runtime = await createRuntime({
    loaded,
    context,
    quiet,
    mode: asMode(args.value('mode')),
    ...(hookFlag !== undefined ? { hook: hookFlag } : undefined),
  });

  const wiring = serveWiring(deps);
  const diagnostics = runtime.diagnostics;
  const resolver = new SessionKeyResolver({
    key: runtime.policy.session.key,
    idleTimeoutMs: runtime.policy.session.idle_timeout,
    clock: runtime.engine.ports.clock,
    ids: runtime.engine.ports.ids,
  });

  const info: ServeInfo = {
    path,
    serverName,
    target: [command, ...targetArgs],
    mode: runtime.policy.mode,
    policyPath: loaded.path,
    policySha256: runtime.engine.policy.sha256,
    sessionKey: runtime.policy.session.key,
    reportDir: runtime.reports.dir,
  };

  const endpoint = await wiring.listen({
    handler: createServeHandler({
      info,
      resolver,
      onEvent: (event, fields) => diagnostics.emit(event, fields),
    }),
    host: bindHost,
    port,
    onError: (error) => diagnostics.emit('http_error', { message: error.message }),
  });

  diagnostics.emit('http_listening', {
    url: `http://${endpoint.host}:${endpoint.port}${path}`,
    sessionKey: info.sessionKey,
    forwards: false,
  });

  // Said in prose as well as in the event, because an operator who starts a
  // server and gets no traffic guarded should not have to read a JSON line to
  // find out why.
  if (!quiet) {
    writeNotice(context.stderr, 'note', [
      `Listening on http://${endpoint.host}:${endpoint.port}${path} — session identity only.`,
      'This endpoint resolves which session each request belongs to and answers every MCP',
      'method with an error saying so. It does not forward tool calls: that needs one',
      'upstream connection per downstream connection, which is the P1 gateway.',
      `The guarded path is: agentfuse wrap -- ${info.target.join(' ')}`,
    ]);
  }

  // An endpoint runs until somebody stops it. Both listeners come off
  // whichever one fires, so a finished command leaves none behind.
  const listeners = new Map<ForwardedSignal, () => void>();
  const stopped = new Promise<ForwardedSignal>((resolve) => {
    let settled = false;
    for (const signal of FORWARDED_SIGNALS) {
      const listener = (): void => {
        if (settled) return;
        settled = true;
        resolve(signal);
      };
      listeners.set(signal, listener);
      wiring.host.onSignal(signal, listener);
    }
  });

  deps.onListening?.(endpoint);
  const signal = await stopped;
  for (const [name, listener] of listeners) wiring.host.offSignal(name, listener);
  diagnostics.emit('http_closing', { signal });

  try {
    await endpoint.close();
  } catch (error) {
    diagnostics.emit('close_failed', { message: messageOf(error) });
  }
  resolver.clear();
  await runtime.close({ timeoutMs: wiring.closeTimeoutMs });

  return EXIT.ok;
}
