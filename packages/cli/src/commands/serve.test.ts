import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FuseEngine, parsePolicy } from '@agentfuse/core';
import { SESSION_BAGGAGE_KEY, SessionKeyResolver } from '@agentfuse/proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import type { EventSource, ForwardedSignal, ProcessHost } from '../host.js';
import { type HttpEndpoint, startHttpEndpoint } from '../http.js';
import { type CliContext, StringWriter } from '../io.js';
import { DEFAULT_CLOSE_TIMEOUT_MS } from '../runtime.js';
import {
  asPort,
  createServeHandler,
  DEFAULT_HOST,
  DEFAULT_PATH,
  DEFAULT_PORT,
  runServe,
  SERVE_FLAGS,
  type ServeInfo,
  serveHelp,
  serveWiring,
  unsupportedMethod,
} from './serve.js';

/**
 * Two halves, tested differently.
 *
 * The handler is a pure `Request → Response` function, so the ADR-006 ladder is
 * driven by constructing requests — one per rung, in order, which is the only
 * way to show that the order is the ADR's order. The command around it is
 * driven over a real socket, because "binds a port and answers" is not a claim
 * a fake can make.
 */

let root: string;
let policyPath: string;
let stdout: StringWriter;
let stderr: StringWriter;

/** A policy with the semantic layer off, so no embedding backend is wanted. */
function writePolicy(extra: readonly string[] = []): string {
  const path = join(root, 'fusepolicy.yaml');
  writeFileSync(
    path,
    ['version: 1', 'mode: warn', 'loop_detection:', '  semantic:', '    enabled: false', ...extra]
      .join('\n')
      .concat('\n'),
    'utf8',
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-serve-'));
  policyPath = writePolicy();
  stdout = new StringWriter();
  stderr = new StringWriter();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(argv: readonly string[] = []): CliContext {
  return { argv, stdout, stderr, env: {}, cwd: root };
}

/** An event source a test can fire by hand. */
class FakeEvents implements EventSource {
  readonly #listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void): void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
  }

  off(event: string, listener: () => void): void {
    this.#listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener();
  }

  count(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

class FakeHost implements ProcessHost {
  readonly stdin = new FakeEvents();
  readonly signals = new FakeEvents();

  onSignal(signal: ForwardedSignal, listener: () => void): void {
    this.signals.on(signal, listener);
  }

  offSignal(signal: ForwardedSignal, listener: () => void): void {
    this.signals.off(signal, listener);
  }

  kill(): boolean {
    return false;
  }
}

/** A resolver with the same ports the command gives the real one. */
function resolverFor(key = 'auto', idleTimeoutMs = 600_000): SessionKeyResolver {
  const engine = new FuseEngine(parsePolicy({ version: 1 }));
  return new SessionKeyResolver({
    key: key as never,
    idleTimeoutMs,
    clock: engine.ports.clock,
    ids: engine.ports.ids,
  });
}

const INFO: ServeInfo = {
  path: '/mcp',
  serverName: 'files',
  target: ['npx', 'server-filesystem'],
  mode: 'warn',
  policyPath: '/tmp/fusepolicy.yaml',
  policySha256: 'abc123',
  sessionKey: 'auto',
  reportDir: '/tmp/reports',
};

/** Posts one JSON-RPC message at the handler. */
async function post(
  handler: ReturnType<typeof createServeHandler>,
  body: unknown,
  options: { headers?: Record<string, string>; remoteAddress?: string; path?: string } = {},
): Promise<Response> {
  return await handler(
    new Request(`http://localhost${options.path ?? '/mcp'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    }),
    { remoteAddress: options.remoteAddress ?? '198.51.100.7' },
  );
}

/** The `error.data` of a JSON-RPC error response. */
async function errorData(answer: Response): Promise<{
  era: string;
  session: { id: string; source: string; exact: boolean } | null;
  regime: string;
}> {
  const body = (await answer.json()) as {
    error: { data: { era: string; session: never; regime: string } };
  };
  return body.error.data;
}

/** A request carrying `_meta`, the only place the ladder's trace rungs live. */
function withMeta(meta: Record<string, unknown>, method = 'tools/call'): unknown {
  return { jsonrpc: '2.0', id: 1, method, params: { name: 'echo', _meta: meta } };
}

const MODERN = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('the flag surface', () => {
  it('declares a port, a host and a path', () => {
    expect(SERVE_FLAGS.values).toContain('port');
    expect(SERVE_FLAGS.values).toContain('host');
    expect(SERVE_FLAGS.values).toContain('path');
  });

  it('binds loopback and 8765 by default', () => {
    // Not 0.0.0.0: an endpoint that meters somebody's agent budget is not a
    // thing to put on the network without being asked.
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(8765);
    expect(DEFAULT_PATH).toBe('/mcp');
  });

  it('prints help to stdout', async () => {
    expect(await runServe(context(), ['--help'])).toBe(0);

    expect(stdout.text).toContain('Usage: agentfuse serve');
    expect(stderr.text).toBe('');
  });

  it('says plainly in help what it does not do', () => {
    const help = serveHelp().join('\n');

    // "Gateway mode is P1 and a serve that pretends otherwise is worse than one
    // that admits its limits."
    expect(help).toContain('WHAT THIS BUILD DOES NOT DO');
    expect(help).toContain('does not forward tool calls');
    expect(help).toContain('agentfuse wrap');
  });

  it('refuses a run with no target', async () => {
    const failure = (await runServe(context(), ['--port', '0']).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure).toBeInstanceOf(CliError);
    expect(failure.message).toContain('after a bare --');
    expect(failure.hints.join('\n')).toContain('agentfuse wrap');
  });

  it.each(['-1', '65536', '1.5', 'http', ''])('refuses --port %j', (value) => {
    expect(() => asPort(value)).toThrow(CliError);
  });

  it('accepts 0, which asks the OS for a port', () => {
    expect(asPort('0')).toBe(0);
    expect(asPort('8080')).toBe(8080);
    expect(asPort(undefined)).toBeUndefined();
  });

  it('suggests the flag a typo was meant to be', async () => {
    const failure = (await runServe(context(), ['--prot', '80', '--', 'node']).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure.hints).toContain('Did you mean --port?');
  });
});

describe('the production wiring', () => {
  it('defaults to the real process and the real endpoint', () => {
    const wiring = serveWiring({});

    expect(wiring.listen).toBe(startHttpEndpoint);
    expect(wiring.host.stdin).toBe(process.stdin);
    expect(wiring.closeTimeoutMs).toBe(DEFAULT_CLOSE_TIMEOUT_MS);
  });

  it('prefers whatever it was given', () => {
    const host = new FakeHost();
    const listen = async (): Promise<HttpEndpoint> => ({
      port: 1,
      host: 'x',
      close: async () => undefined,
    });
    const wiring = serveWiring({ host, listen, closeTimeoutMs: 7 });

    expect(wiring.host).toBe(host);
    expect(wiring.listen).toBe(listen);
    expect(wiring.closeTimeoutMs).toBe(7);
  });
});

describe('the ADR-006 ladder, rung by rung', () => {
  const handler = (key?: string): ReturnType<typeof createServeHandler> =>
    createServeHandler({
      info: INFO,
      resolver: resolverFor(key),
      onEvent: () => undefined,
    });

  it('takes the traceparent trace id first, and calls it exact', async () => {
    const data = await errorData(
      await post(
        handler(),
        withMeta({
          traceparent: TRACEPARENT,
          baggage: `${SESSION_BAGGAGE_KEY}=from-baggage`,
        }),
        { headers: { 'mcp-session-id': 'from-header' } },
      ),
    );

    expect(data.session).toEqual({
      id: '4bf92f3577b34da6a3ce929d0e0e4736',
      source: 'traceparent',
      exact: true,
    });
    expect(data.regime).toContain('traceparent');
    expect(data.regime).toContain('exact');
  });

  it('takes the chained baggage member second', async () => {
    const data = await errorData(
      await post(handler(), withMeta({ baggage: `${SESSION_BAGGAGE_KEY}=from-baggage` }), {
        headers: { 'mcp-session-id': 'from-header' },
      }),
    );

    // Above Mcp-Session-Id on purpose: the baggage member is the chaining
    // contract with McpGuard and defines one session for the whole chain,
    // where a transport id describes one hop of it.
    expect(data.session?.source).toBe('baggage');
    expect(data.session?.id).toBe('from-baggage');
    expect(data.regime).toContain('chained from an outer proxy');
  });

  it('takes Mcp-Session-Id third, on a legacy-era request', async () => {
    const data = await errorData(
      await post(handler(), withMeta({}), { headers: { 'mcp-session-id': 'from-header' } }),
    );

    expect(data.era).toBe('legacy');
    expect(data.session).toEqual({ id: 'from-header', source: 'mcp-session-id', exact: true });
  });

  it('ignores Mcp-Session-Id on a modern-era request', async () => {
    const data = await errorData(
      await post(handler(), withMeta(MODERN), { headers: { 'mcp-session-id': 'from-header' } }),
    );

    // The 2026-07-28 revision removed the header outright; honouring it there
    // would invent a session the protocol says does not exist.
    expect(data.era).toBe('modern');
    expect(data.session?.source).toBe('client-address');
  });

  it('falls back to the caller and its address last, and says it is a guess', async () => {
    const data = await errorData(await post(handler(), withMeta({})));

    expect(data.session?.source).toBe('client-address');
    expect(data.session?.exact).toBe(false);
    expect(data.regime).toContain('best effort, not a guarantee');
  });

  it('gives the same caller the same session across requests', async () => {
    const one = handler();
    const first = await errorData(await post(one, withMeta({}), { remoteAddress: '203.0.113.9' }));
    const second = await errorData(await post(one, withMeta({}), { remoteAddress: '203.0.113.9' }));
    const other = await errorData(await post(one, withMeta({}), { remoteAddress: '203.0.113.10' }));

    expect(second.session?.id).toBe(first.session?.id);
    expect(other.session?.id).not.toBe(first.session?.id);
  });

  it('reports nothing resolved when a strict session.key cannot be met', async () => {
    const data = await errorData(await post(handler('traceparent'), withMeta({})));

    // Not papered over with a fresh id: metering a call against a session that
    // exists only for that call turns every budget into no budget.
    expect(data.session).toBeNull();
    expect(data.regime).toContain('session unresolved');
  });

  it('honours a configured baggage key other than the default', async () => {
    const data = await errorData(
      await post(handler('baggage:my.task-id'), withMeta({ baggage: 'my.task-id=task-7' })),
    );

    expect(data.session).toEqual({ id: 'task-7', source: 'baggage', exact: true });
  });

  it('reads _meta from the top level as well as from params', async () => {
    const data = await errorData(
      await post(handler(), {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        _meta: { traceparent: TRACEPARENT },
      }),
    );

    expect(data.session?.source).toBe('traceparent');
  });

  it('does not read a traceparent HTTP header', async () => {
    // ADR-006 places the rung in `_meta` (SEP-414), and the chaining contract
    // is that an outer proxy injects it there. A second source would mean two
    // answers to "which session is this" and no rule for which wins.
    const data = await errorData(
      await post(handler(), withMeta({}), { headers: { traceparent: TRACEPARENT } }),
    );

    expect(data.session?.source).toBe('client-address');
  });

  it('reports what it resolved as a diagnostic too', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const one = createServeHandler({
      info: INFO,
      resolver: resolverFor(),
      onEvent: (event, fields) => events.push([event, fields]),
    });

    await post(one, withMeta({ traceparent: TRACEPARENT }));

    expect(events[0]?.[0]).toBe('http_request');
    expect(events[0]?.[1]).toMatchObject({
      method: 'tools/call',
      era: 'legacy',
      source: 'traceparent',
      exact: true,
    });
  });

  it('reports a null session in the diagnostic when nothing resolved', async () => {
    const events: Array<Record<string, unknown>> = [];
    const one = createServeHandler({
      info: INFO,
      resolver: resolverFor('traceparent'),
      onEvent: (_event, fields) => events.push(fields),
    });

    await post(one, withMeta({}));

    expect(events[0]).toMatchObject({ sessionId: null });
  });
});

describe('what the endpoint answers', () => {
  const handler = createServeHandler({
    info: INFO,
    resolver: resolverFor(),
    onEvent: () => undefined,
  });

  it('refuses every MCP method, naming the guarded path', async () => {
    const answer = await post(handler, withMeta({}, 'tools/call'));
    const body = (await answer.clone().json()) as { error: { code: number; message: string } };

    expect(answer.status).toBe(200);
    // A JSON-RPC error, not an HTTP failure: the endpoint is working, the
    // method is the thing it does not carry.
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain('does not forward tools/call');
    expect(body.error.message).toContain('agentfuse wrap');
    expect((await errorData(answer)).regime).toBeDefined();
  });

  it('names the server it would have guarded', () => {
    expect(unsupportedMethod('tools/call', 'files')).toContain('to files');
  });

  it('acknowledges a notification and drops it', async () => {
    const answer = await post(handler, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(answer.status).toBe(202);
    expect(await answer.text()).toBe('');
  });

  it('treats an unaddressable id as a notification', async () => {
    const answer = await post(handler, { jsonrpc: '2.0', id: { odd: true }, method: 'ping' });

    expect(answer.status).toBe(202);
  });

  it('answers a body that is not JSON with a parse error', async () => {
    const answer = await handler(
      new Request('http://localhost/mcp', { method: 'POST', body: 'not json' }),
      { remoteAddress: '::1' },
    );

    expect(answer.status).toBe(400);
    expect(JSON.stringify(await answer.json())).toContain('-32700');
  });

  it.each([['[]'], ['"a string"'], ['{"jsonrpc":"2.0","id":1}'], ['null']])(
    'answers %s with an invalid-request error',
    async (body) => {
      const answer = await handler(new Request('http://localhost/mcp', { method: 'POST', body }), {
        remoteAddress: '::1',
      });

      expect(answer.status).toBe(400);
      expect(JSON.stringify(await answer.json())).toContain('-32600');
    },
  );

  it('answers GET on the endpoint with 405, which the spec allows', async () => {
    const answer = await handler(new Request('http://localhost/mcp'), { remoteAddress: '::1' });

    expect(answer.status).toBe(405);
    expect(answer.headers.get('allow')).toBe('POST');
    expect(await answer.text()).toContain('opens no server-initiated stream');
  });

  it('answers another route with 404, naming the one it serves', async () => {
    const answer = await handler(new Request('http://localhost/elsewhere'), {
      remoteAddress: '::1',
    });

    expect(answer.status).toBe(404);
    expect(JSON.stringify(await answer.json())).toContain('/mcp');
  });

  it('reports the policy in force on /healthz', async () => {
    const answer = await handler(new Request('http://localhost/healthz'), {
      remoteAddress: '::1',
    });
    const body = (await answer.json()) as Record<string, unknown>;

    expect(answer.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      mode: 'warn',
      sessionKey: 'auto',
      serverName: 'files',
      target: ['npx', 'server-filesystem'],
    });
  });

  it('answers a POST to /healthz with 405', async () => {
    const answer = await handler(
      new Request('http://localhost/healthz', { method: 'POST', body: '{}' }),
      { remoteAddress: '::1' },
    );

    expect(answer.status).toBe(405);
    expect(answer.headers.get('allow')).toBe('GET');
  });
});

describe('the command, over a real socket', () => {
  it('binds, answers, reports the ladder, and stops on a signal', async () => {
    const host = new FakeHost();
    let base = '';

    const finished = runServe(
      context(),
      ['--port', '0', '--name', 'files', '--', 'node', 'srv.mjs'],
      {
        host,
        closeTimeoutMs: 50,
        onListening: (endpoint) => {
          base = `http://127.0.0.1:${endpoint.port}`;
        },
      },
    );

    // The endpoint is up by the time `onListening` has run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(base).not.toBe('');

    const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: 'ok', serverName: 'files', path: '/mcp' });
    expect(health['policyPath']).toBe(policyPath);

    const answer = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withMeta({ traceparent: TRACEPARENT }, 'tools/call')),
    });
    const body = (await answer.json()) as { error: { data: { session: { id: string } } } };
    expect(body.error.data.session.id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');

    host.signals.emit('SIGTERM');

    expect(await finished).toBe(0);
    // And the socket is really gone, not merely unreferenced.
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    expect(host.signals.count('SIGINT')).toBe(0);
    expect(host.signals.count('SIGTERM')).toBe(0);
  });

  it('says in prose as well as in JSON that it forwards nothing', async () => {
    const host = new FakeHost();
    const finished = runServe(context(), ['--port', '0', '--', 'npx', 'srv'], {
      host,
      closeTimeoutMs: 50,
      onListening: () => host.signals.emit('SIGINT'),
    });

    expect(await finished).toBe(0);
    expect(stderr.text).toContain('"event":"http_listening"');
    expect(stderr.text).toContain('"forwards":false');
    expect(stderr.text).toContain('session identity only');
    expect(stderr.text).toContain('agentfuse wrap -- npx srv');
    expect(stderr.text).toContain('"event":"http_closing"');
  });

  it('says nothing at all under --quiet', async () => {
    const host = new FakeHost();
    const finished = runServe(context(), ['--quiet', '--port', '0', '--', 'npx', 'srv'], {
      host,
      closeTimeoutMs: 50,
      onListening: () => host.signals.emit('SIGTERM'),
    });

    expect(await finished).toBe(0);
    expect(stderr.text).toBe('');
  });

  it('honours --path and --host', async () => {
    const host = new FakeHost();
    let base = '';
    const finished = runServe(
      context(),
      ['--port', '0', '--host', '127.0.0.1', '--path', '/rpc', '--', 'npx', 'srv'],
      {
        host,
        closeTimeoutMs: 50,
        onListening: (endpoint) => {
          base = `http://127.0.0.1:${endpoint.port}`;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/rpc`, { method: 'POST', body: '{}' })).status).toBe(400);

    host.signals.emit('SIGINT');
    expect(await finished).toBe(0);
  });

  it('applies --mode to the policy it reports', async () => {
    const host = new FakeHost();
    let base = '';
    const finished = runServe(context(), ['--port', '0', '--mode', 'enforce', '--', 'npx', 'srv'], {
      host,
      closeTimeoutMs: 50,
      onListening: (endpoint) => {
        base = `http://127.0.0.1:${endpoint.port}`;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const health = (await (await fetch(`${base}/healthz`)).json()) as { mode: string };
    expect(health.mode).toBe('enforce');

    host.signals.emit('SIGINT');
    expect(await finished).toBe(0);
  });

  it('reports an endpoint that fails to close rather than replacing the reason', async () => {
    const host = new FakeHost();
    const finished = runServe(context(), ['--port', '0', '--', 'npx', 'srv'], {
      host,
      closeTimeoutMs: 50,
      listen: async () => ({
        port: 1,
        host: '127.0.0.1',
        close: () => Promise.reject(new Error('the socket would not let go')),
      }),
      onListening: () => host.signals.emit('SIGTERM'),
    });

    expect(await finished).toBe(0);
    expect(stderr.text).toContain('"event":"close_failed"');
    expect(stderr.text).toContain('the socket would not let go');
  });

  it('reports a transport error out of band', async () => {
    const host = new FakeHost();
    let reported: ((error: Error) => void) | undefined;
    const finished = runServe(context(), ['--port', '0', '--', 'npx', 'srv'], {
      host,
      closeTimeoutMs: 50,
      listen: async (options) => {
        reported = options.onError;
        return { port: 1, host: '127.0.0.1', close: async () => undefined };
      },
      onListening: () => {
        reported?.(new Error('a socket hung up'));
        host.signals.emit('SIGTERM');
      },
    });

    expect(await finished).toBe(0);
    expect(stderr.text).toContain('"event":"http_error"');
    expect(stderr.text).toContain('a socket hung up');
  });

  it('takes the policy from --policy and the hook from --hook', async () => {
    const named = join(root, 'elsewhere.yaml');
    writeFileSync(
      named,
      'version: 1\nmode: enforce\nloop_detection:\n  semantic:\n    enabled: false\n',
      'utf8',
    );
    const hookPath = join(root, 'hook.mjs');
    writeFileSync(hookPath, 'export function onDecision(d) { return d; }\n', 'utf8');

    const host = new FakeHost();
    const finished = runServe(
      context(),
      ['--port', '0', '--policy', named, '--hook', hookPath, '--', 'npx', 'srv'],
      { host, closeTimeoutMs: 50, onListening: () => host.signals.emit('SIGTERM') },
    );

    expect(await finished).toBe(0);
    // The named file, not the one in the working directory: a policy chosen by
    // name must never fall back to another.
    expect(stderr.text).toContain(named);
    expect(stderr.text).toContain('"event":"hook_loaded"');
  });

  it('stops once, however many signals arrive', async () => {
    const host = new FakeHost();
    const finished = runServe(context(), ['--port', '0', '--', 'npx', 'srv'], {
      host,
      closeTimeoutMs: 50,
      onListening: () => {
        host.signals.emit('SIGINT');
        host.signals.emit('SIGTERM');
      },
    });

    expect(await finished).toBe(0);
    // One closing line, not two: a second shutdown of the same endpoint is
    // either a no-op or a double free, and neither is worth finding out.
    expect(stderr.text.match(/"event":"http_closing"/g)).toHaveLength(1);
    expect(stderr.text).toContain('"signal":"SIGINT"');
  });

  it('uses session.key and session.idle_timeout from the policy', async () => {
    policyPath = writePolicy(['session:', '  key: traceparent', '  idle_timeout: 30s']);
    const host = new FakeHost();
    let base = '';
    const finished = runServe(context(), ['--port', '0', '--', 'npx', 'srv'], {
      host,
      closeTimeoutMs: 50,
      onListening: (endpoint) => {
        base = `http://127.0.0.1:${endpoint.port}`;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const health = (await (await fetch(`${base}/healthz`)).json()) as { sessionKey: string };
    expect(health.sessionKey).toBe('traceparent');
    const answer = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: JSON.stringify(withMeta({})),
    });
    expect(JSON.stringify(await answer.json())).toContain('session unresolved');

    host.signals.emit('SIGINT');
    expect(await finished).toBe(0);
  });
});
