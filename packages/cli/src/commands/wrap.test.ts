import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StdioWrapHandle, StdioWrapOptions } from '@agentfuse/proxy';
import { wrapStdioServer } from '@agentfuse/proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import type { EventSource, ForwardedSignal, ProcessHost } from '../host.js';
import { type CliContext, StringWriter } from '../io.js';
import { DEFAULT_CLOSE_TIMEOUT_MS } from '../runtime.js';
import {
  asMilliseconds,
  asRelay,
  DEFAULT_WATCH_INTERVAL_MS,
  defaultServerName,
  isStartupFailure,
  runWrap,
  WRAP_FLAGS,
  wrapHelp,
  wrapWiring,
} from './wrap.js';

/**
 * The lifecycle of a wrap, with the process and the proxy's serving entry
 * replaced by fakes.
 *
 * The four ways a wrap can end each need a different external event — the agent
 * hanging up, a signal, the wrapped server dying, a spawn that never
 * succeeded — and driving all four through real processes would make this file
 * slower than the rest of the suite put together. `wrap-process.test.ts` runs
 * the real thing end to end; this one runs every branch.
 */

let root: string;
let policyPath: string;
let stdout: StringWriter;
let stderr: StringWriter;

function writePolicy(body: string): string {
  const path = join(root, 'fusepolicy.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

/** A policy with the semantic layer off, so no embedding backend is wanted. */
const PLAIN_POLICY = [
  'version: 1',
  'mode: warn',
  'loop_detection:',
  '  semantic:',
  '    enabled: false',
  '',
].join('\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-wrap-'));
  policyPath = writePolicy(PLAIN_POLICY);
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

/** A {@link ProcessHost} that fires nothing until a test says so. */
class FakeHost implements ProcessHost {
  readonly stdin = new FakeEvents();
  readonly signals = new FakeEvents();
  readonly killed: Array<{ readonly pid: number; readonly signal: string }> = [];
  /** Whether {@link kill} claims the signal landed. */
  killable = true;

  onSignal(signal: ForwardedSignal, listener: () => void): void {
    this.signals.on(signal, listener);
  }

  offSignal(signal: ForwardedSignal, listener: () => void): void {
    this.signals.off(signal, listener);
  }

  kill(pid: number, signal: ForwardedSignal): boolean {
    this.killed.push({ pid, signal });
    return this.killable;
  }
}

/** The bits of an upstream connection a fake bridge has to offer. */
interface FakeClient {
  onclose?: (() => void) | undefined;
  readonly transport?: { readonly pid?: unknown } | undefined;
  listTools(): Promise<unknown>;
}

/**
 * A stand-in for `Bridge`.
 *
 * Cast once, deliberately: a structurally complete `Bridge` would need a real
 * SDK `Server` and `Client`, and the command only ever reads `client.onclose`,
 * `client.transport.pid` and `client.listTools`.
 */
function fakeBridge(client: FakeClient): NonNullable<StdioWrapHandle['bridge']> {
  return { client } as unknown as NonNullable<StdioWrapHandle['bridge']>;
}

/** A stand-in for `StdioWrapHandle`, whose connection a test opens by hand. */
class FakeHandle implements StdioWrapHandle {
  bridge: StdioWrapHandle['bridge'];
  sessionId: string | undefined;
  closes = 0;
  closeError: Error | undefined;

  async close(): Promise<void> {
    this.closes += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

/** Waits for something the command does asynchronously. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One wrap under test, with its fakes. */
interface Harness {
  readonly host: FakeHost;
  readonly handle: FakeHandle;
  readonly exitCode: Promise<number>;
  /** The options the command handed the serving entry. */
  seen(): StdioWrapOptions;
}

function start(argv: readonly string[], onError?: (options: StdioWrapOptions) => void): Harness {
  const host = new FakeHost();
  const handle = new FakeHandle();
  let captured: StdioWrapOptions | undefined;

  const exitCode = runWrap(context(), argv, {
    host,
    watchIntervalMs: 1,
    closeTimeoutMs: 50,
    serve: (options) => {
      captured = options;
      onError?.(options);
      return handle;
    },
  });

  return {
    host,
    handle,
    exitCode,
    seen: () => {
      if (captured === undefined) throw new Error('the serving entry was not called');
      return captured;
    },
  };
}

describe('the flag surface', () => {
  it('declares -- friendly flags and no others', () => {
    expect(WRAP_FLAGS.values).toContain('name');
    expect(WRAP_FLAGS.values).toContain('relay');
    expect(WRAP_FLAGS.booleans).toEqual(['quiet', 'help']);
  });

  it('prints help to stdout and touches nothing else', async () => {
    expect(await runWrap(context(), ['--help'])).toBe(0);

    expect(stdout.text).toContain('Usage: agentfuse wrap');
    expect(stderr.text).toBe('');
  });

  it('says in help that stdout is the protocol stream', () => {
    // The one sentence a user needs before they wonder where their logs went.
    expect(wrapHelp().join('\n')).toContain('stdout is the JSON-RPC stream');
  });

  it('suggests the flag a typo was meant to be', async () => {
    const failure = (await runWrap(context(), ['--quite', '--', 'node']).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure.message).toBe('unknown flag --quite');
    expect(failure.hints).toContain('Did you mean --quiet?');
  });

  it('refuses a run with no command', async () => {
    const failure = await runWrap(context(), []).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toContain('after a bare --');
  });

  it('explains the separator when the command was given without one', async () => {
    const failure = (await runWrap(context(), ['node', 'server.mjs']).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure.hints.join('\n')).toContain('The -- matters');
    expect(failure.hints.join('\n')).toContain('node');
  });

  it('leaves the child’s own flags alone', async () => {
    const harness = start(['--quiet', '--', 'node', 'server.mjs', '--verbose', '--quiet']);
    await until(() => harness.handle.closes === 0 && hasServed(harness), 'the serving entry');

    expect(harness.seen().command).toBe('node');
    expect(harness.seen().args).toEqual(['server.mjs', '--verbose', '--quiet']);

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });
});

function hasServed(harness: Harness): boolean {
  try {
    harness.seen();
    return true;
  } catch {
    return false;
  }
}

describe('the production wiring', () => {
  it('defaults to the real process and the proxy’s own serving entry', () => {
    const wiring = wrapWiring({});

    // Asserted as values, because these two are exactly what an in-process
    // test cannot exercise: the real entry binds this process's stdio, which
    // under a test runner is the test runner's.
    expect(wiring.serve).toBe(wrapStdioServer);
    expect(wiring.host.stdin).toBe(process.stdin);
    expect(wiring.watchIntervalMs).toBe(DEFAULT_WATCH_INTERVAL_MS);
    expect(wiring.closeTimeoutMs).toBe(DEFAULT_CLOSE_TIMEOUT_MS);
  });

  it('prefers whatever it was given', () => {
    const host = new FakeHost();
    const handle = new FakeHandle();
    const serve = (): StdioWrapHandle => handle;
    const wiring = wrapWiring({ host, serve, watchIntervalMs: 1, closeTimeoutMs: 2 });

    expect(wiring.host).toBe(host);
    expect(wiring.serve).toBe(serve);
    expect(wiring.watchIntervalMs).toBe(1);
    expect(wiring.closeTimeoutMs).toBe(2);
  });
});

describe('the default server alias', () => {
  it.each([
    ['node', ['./build/server.js'], 'server'],
    ['npx', ['-y', '@modelcontextprotocol/server-filesystem', '/srv'], 'server-filesystem'],
    ['/usr/local/bin/my-mcp-server', [], 'my-mcp-server'],
    ['python3', ['-m', 'weather_mcp'], 'weather_mcp'],
    ['node', [], 'node'],
    ['C:\\tools\\mcp-thing.exe', [], 'mcp-thing'],
  ])('%s %j becomes %s', (command, args, expected) => {
    expect(defaultServerName(command, args)).toBe(expected);
  });

  it('is overridden by --name', async () => {
    const harness = start(['--name', 'files', '--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');

    expect(harness.seen().serverName).toBe('files');

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });
});

describe('--relay', () => {
  it('defaults to the proxy’s own choice by staying absent', () => {
    expect(asRelay(undefined)).toBeUndefined();
  });

  it('declares nothing for none', () => {
    expect(asRelay('none')).toEqual({});
  });

  it('declares exactly what was named', () => {
    expect(asRelay('sampling,roots')).toEqual({ sampling: {}, roots: {} });
  });

  it('tolerates spaces round the commas', () => {
    expect(asRelay('sampling, elicitation')).toEqual({ sampling: {}, elicitation: {} });
  });

  it.each(['smapling', '', 'tools', 'sampling,tools'])('refuses %j', (value) => {
    expect(() => asRelay(value)).toThrow(CliError);
  });

  it('names the accepted values in the refusal', () => {
    const failure = (() => {
      try {
        asRelay('tools');
        return undefined;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.hints.join('\n')).toContain('sampling, elicitation, roots, or none');
  });
});

describe('--request-timeout', () => {
  it('is absent when the flag is', () => {
    expect(asMilliseconds('--request-timeout', undefined)).toBeUndefined();
  });

  it('takes a positive whole number', () => {
    expect(asMilliseconds('--request-timeout', '600000')).toBe(600_000);
  });

  it.each(['0', '-1', '1.5', 'soon', ''])('refuses %j', (value) => {
    expect(() => asMilliseconds('--request-timeout', value)).toThrow(CliError);
  });
});

describe('recognising a spawn that never happened', () => {
  it.each([
    'spawn node-nope ENOENT',
    'spawn EACCES',
    'EPERM: operation not permitted',
    'spawn /tmp/dir ENOTDIR',
  ])('%s is fatal', (message) => {
    expect(isStartupFailure(new Error(message))).toBe(true);
  });

  it.each([
    'Connection closed',
    'Parse error',
    'the upstream server answered tools/call with something else',
  ])('%s is not', (message) => {
    expect(isStartupFailure(new Error(message))).toBe(false);
  });
});

describe('what the serving entry is handed', () => {
  it('gets the runtime’s own diagnostics, report writer and session hook', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    const options = harness.seen();

    // One `Diagnostics`, not two: a second instance would keep its own
    // rate-limit window and the startup warnings would be counted apart from
    // the trips.
    expect(options.diagnostics).toBeDefined();
    expect(options.writeReport).toBeInstanceOf(Function);
    expect(options.onSessionEnd).toBeInstanceOf(Function);
    expect(options.annotationsFor).toBeInstanceOf(Function);
    expect(options.engine.policy.policy.mode).toBe('warn');

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });

  it('loads a --hook onto the engine before a single call is served', async () => {
    const hookPath = join(root, 'hook.mjs');
    writeFileSync(hookPath, 'export function onDecision(decision) { return decision; }\n', 'utf8');

    const harness = start(['--hook', hookPath, '--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');

    expect(stderr.text).toContain('"event":"hook_loaded"');
    expect(stderr.text).toContain(hookPath);

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });

  it('passes --mode through to the engine it builds', async () => {
    const harness = start(['--mode', 'enforce', '--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');

    expect(harness.seen().engine.policy.policy.mode).toBe('enforce');

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });

  it('omits the optional fields it was not given', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');

    expect('clientCapabilities' in harness.seen()).toBe(false);
    expect('requestTimeoutMs' in harness.seen()).toBe(false);

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });

  it('passes the ones it was', async () => {
    const harness = start([
      '--relay',
      'none',
      '--request-timeout',
      '1234',
      '--',
      'node',
      'server.mjs',
    ]);
    await until(() => hasServed(harness), 'the serving entry');

    expect(harness.seen().clientCapabilities).toEqual({});
    expect(harness.seen().requestTimeoutMs).toBe(1234);

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });
});

describe('how a wrap ends', () => {
  it('exits 0 when the agent closes the pipe, and leaves no listeners', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    expect(harness.host.stdin.count('close')).toBe(1);

    harness.host.stdin.emit('close');

    expect(await harness.exitCode).toBe(0);
    expect(harness.handle.closes).toBe(1);
    expect(harness.host.stdin.count('close')).toBe(0);
    expect(harness.host.stdin.count('end')).toBe(0);
    expect(harness.host.signals.count('SIGINT')).toBe(0);
    expect(stderr.text).toContain('"event":"wrap_end"');
    expect(stderr.text).toContain('"reason":"agent-closed"');
  });

  it('treats end the same as close', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');

    harness.host.stdin.emit('end');

    expect(await harness.exitCode).toBe(0);
  });

  it('only ends once, however many times the pipe says so', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');

    harness.host.stdin.emit('close');
    harness.host.stdin.emit('end');

    expect(await harness.exitCode).toBe(0);
    expect(harness.handle.closes).toBe(1);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s to the child and exits 0',
    async (signal) => {
      const harness = start(['--', 'node', 'server.mjs']);
      await until(() => hasServed(harness), 'the serving entry');
      harness.handle.bridge = fakeBridge({
        transport: { pid: 4242 },
        listTools: () => Promise.resolve({ tools: [] }),
      });
      await until(
        () => harness.handle.bridge?.client.onclose !== undefined,
        'the armed connection',
      );

      harness.host.signals.emit(signal);

      expect(await harness.exitCode).toBe(0);
      // By name, not by closing the pipe: a server that flushes on SIGINT should
      // get the signal the operator sent.
      expect(harness.host.killed).toEqual([{ pid: 4242, signal }]);
      expect(stderr.text).toContain(`"signal":"${signal}"`);
      expect(stderr.text).toContain('"forwarded":true');
    },
  );

  it('still stops when there is no child to signal', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');

    harness.host.signals.emit('SIGTERM');

    expect(await harness.exitCode).toBe(0);
    expect(harness.host.killed).toEqual([]);
    expect(stderr.text).toContain('"forwarded":false');
  });

  it('reports a signal that could not be delivered', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    harness.host.killable = false;
    harness.handle.bridge = fakeBridge({
      transport: { pid: 77 },
      listTools: () => Promise.resolve({ tools: [] }),
    });
    await until(() => harness.handle.bridge?.client.onclose !== undefined, 'the armed connection');

    harness.host.signals.emit('SIGINT');

    expect(await harness.exitCode).toBe(0);
    expect(stderr.text).toContain('"forwarded":false');
  });

  it('ignores a transport that reports no usable pid', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    harness.handle.bridge = fakeBridge({
      transport: { pid: null },
      listTools: () => Promise.resolve({ tools: [] }),
    });
    await until(() => harness.handle.bridge?.client.onclose !== undefined, 'the armed connection');

    harness.host.signals.emit('SIGINT');

    expect(await harness.exitCode).toBe(0);
    expect(harness.host.killed).toEqual([]);
  });

  it('exits 70 when the wrapped server goes away under it', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    const client: FakeClient = { listTools: () => Promise.resolve({ tools: [] }) };
    harness.handle.bridge = fakeBridge(client);
    await until(() => client.onclose !== undefined, 'the armed connection');

    client.onclose?.();

    // Not 0: the agent may be perfectly happy, but the run failed.
    expect(await harness.exitCode).toBe(70);
    expect(stderr.text).toContain('"reason":"server-gone"');
  });

  it('exits 70 when the child never spawned', async () => {
    const harness = start(['--', 'node-nope', 'server.mjs'], (options) => {
      // The serving entry reports the spawn failure out of band, which is the
      // only channel it has: the factory runs when the agent connects.
      setTimeout(() => options.onError?.(new Error('spawn node-nope ENOENT')), 1);
    });

    expect(await harness.exitCode).toBe(70);
    expect(stderr.text).toContain('"event":"child_spawn_failed"');
    expect(stderr.text).toContain('node-nope');
  });

  it('does not end the wrap over an error it could recover from', async () => {
    const harness = start(['--', 'node', 'server.mjs'], (options) => {
      setTimeout(() => options.onError?.(new Error('Parse error')), 1);
    });
    await until(() => hasServed(harness), 'the serving entry');
    await new Promise((resolve) => setTimeout(resolve, 10));

    harness.host.stdin.emit('close');

    expect(await harness.exitCode).toBe(0);
  });

  it('ignores a spawn-shaped error once the connection is up', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    harness.handle.bridge = fakeBridge({ listTools: () => Promise.resolve({ tools: [] }) });
    await until(() => harness.handle.bridge?.client.onclose !== undefined, 'the armed connection');

    harness.seen().onError?.(new Error('spawn something ENOENT'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    harness.host.stdin.emit('close');

    expect(await harness.exitCode).toBe(0);
  });

  it('reports a teardown that fails instead of replacing the reason with it', async () => {
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    harness.handle.closeError = new Error('the pipe was already gone');

    harness.host.stdin.emit('close');

    expect(await harness.exitCode).toBe(0);
    expect(stderr.text).toContain('"event":"close_failed"');
    expect(stderr.text).toContain('the pipe was already gone');
  });
});

describe('the tool catalogue', () => {
  it('is not fetched when the policy does not trust server hints', async () => {
    let listed = 0;
    const harness = start(['--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    harness.handle.bridge = fakeBridge({
      listTools: () => {
        listed += 1;
        return Promise.resolve({ tools: [] });
      },
    });
    await until(() => harness.handle.bridge?.client.onclose !== undefined, 'the armed connection');

    harness.host.stdin.emit('close');
    await harness.exitCode;

    // `trust_hints` defaults to false, and an unrequested `tools/list` against
    // somebody's server is not a free action.
    expect(listed).toBe(0);
  });

  it('is fetched once when it is, and feeds annotationsFor', async () => {
    policyPath = writePolicy(`${PLAIN_POLICY}annotations:\n  trust_hints: true\n`);
    let listed = 0;
    const harness = start(['--policy', policyPath, '--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    harness.handle.bridge = fakeBridge({
      listTools: () => {
        listed += 1;
        return Promise.resolve({
          tools: [{ name: 'echo', annotations: { idempotentHint: true } }],
        });
      },
    });
    await until(
      () => harness.seen().annotationsFor?.('echo') !== undefined,
      'the filled catalogue',
    );

    expect(listed).toBe(1);
    expect(harness.seen().annotationsFor?.('echo')).toEqual({ idempotentHint: true });
    expect(harness.seen().annotationsFor?.('nothing')).toBeUndefined();
    expect(stderr.text).toContain('"event":"tool_catalogue"');

    harness.host.stdin.emit('close');
    await harness.exitCode;
  });

  it('carries on when the upstream cannot list its tools', async () => {
    policyPath = writePolicy(`${PLAIN_POLICY}annotations:\n  trust_hints: true\n`);
    const harness = start(['--policy', policyPath, '--', 'node', 'server.mjs']);
    await until(() => hasServed(harness), 'the serving entry');
    harness.handle.bridge = fakeBridge({
      listTools: () => Promise.reject(new Error('no tools capability')),
    });
    await until(() => stderr.text.includes('tool_catalogue_failed'), 'the failure report');

    harness.host.stdin.emit('close');

    expect(await harness.exitCode).toBe(0);
  });
});
