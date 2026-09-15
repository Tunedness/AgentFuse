import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CounterIdGenerator, FuseEngine, parsePolicy } from '@agentfuse/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RELAYABLE_CLIENT_CAPABILITIES,
  type StdioWrapOptions,
  wrapStdioServer,
} from './stdio-wrap.js';

// These tests spawn real processes over real pipes, so their wall clock is the
// machine's, not the code's. Vitest's 5 s default is enough in isolation and
// too tight under a loaded full-suite run — which shows up as a random red
// build rather than as a bug. The assertions are about behaviour, never speed.
vi.setConfig({ testTimeout: 20_000 });

const FIXTURES = fileURLToPath(new URL('./testing/fixtures/', import.meta.url));
const WRAP_HOST = `${FIXTURES}wrap-host.mjs`;
const NOISY_SERVER = `${FIXTURES}noisy-server.mjs`;
const QUIET_SERVER = `${FIXTURES}quiet-server.mjs`;
const PROXY_DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * The bytes the fixture server writes, read from the same file it reads.
 *
 * Read rather than imported: importing the fixture module would run it — write
 * its startup noise to *this* process's stderr and attach a stdio server to
 * this process's stdin. A JSON file has no side effects to have, and one
 * definition means the expectation cannot drift from the emission.
 */
interface Noise {
  readonly startup: string[];
  readonly longLinePrefix: string;
  readonly longLineLength: number;
  readonly tail: string;
  readonly call: string;
}

const noise = JSON.parse(readFileSync(`${FIXTURES}noise.json`, 'utf8')) as Noise;
const STARTUP_NOISE = [
  ...noise.startup,
  `${noise.longLinePrefix}${'x'.repeat(noise.longLineLength)}\n`,
  noise.tail,
].join('');
const CALL_NOISE = noise.call;

/** One JSON-RPC frame, newline-delimited as the stdio binding requires. */
function frame(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

/** A spawned wrap host, with both of its streams collected as raw bytes. */
interface Wrap {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  send(message: Record<string, unknown>): void;
  /** Resolves once `count` newline-delimited frames have arrived on stdout. */
  waitForFrames(count: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

function startWrap(env: Record<string, string> = {}): Wrap {
  const child = spawn(process.execPath, [WRAP_HOST, NOISY_SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams;

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const framesSeen = (): Record<string, unknown>[] =>
    Buffer.concat(stdout)
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    child,
    stdout,
    stderr,
    send: (message) => child.stdin.write(frame(message)),
    waitForFrames: async (count) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          const frames = framesSeen();
          if (frames.length >= count) return frames;
        } catch {
          // A partial line at the tail is normal while a frame is still
          // arriving. A line that never becomes valid JSON trips the timeout
          // below, which is exactly the stdout-pollution failure.
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${count} stdout frames; got ${Buffer.concat(stdout).toString('utf8').slice(0, 500)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: async () => {
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

/** The handshake and one tool call, driven by hand over raw frames. */
async function handshakeAndCall(wrap: Wrap): Promise<Record<string, unknown>[]> {
  wrap.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: { roots: {} },
      clientInfo: { name: 'fidelity-test', version: '1.0.0' },
    },
  });
  await wrap.waitForFrames(1);
  wrap.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  wrap.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  wrap.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'echo', arguments: { a: 1 } },
  });
  return wrap.waitForFrames(3);
}

let wrap: Wrap | undefined;

afterEach(async () => {
  await wrap?.close();
  wrap = undefined;
});

beforeAll(() => {
  if (!existsSync(PROXY_DIST)) {
    throw new Error(
      `${PROXY_DIST} is missing. The stream-fidelity tests spawn a real wrap under bare node, which loads the built package — run \`npm run build\` first (the gate does).`,
    );
  }
});

describe('the wrapped server’s stderr', () => {
  it('arrives byte-for-byte, with nothing added, dropped or reordered', async () => {
    wrap = startWrap({ AGENTFUSE_QUIET: '1' });

    await handshakeAndCall(wrap);
    // Give the child's last stderr write time to land.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const received = Buffer.concat(wrap.stderr);

    // Quiet, so AgentFuse contributes nothing and the comparison can be exact.
    // The payload contains a bare CR, an ANSI escape, a NUL byte, UTF-8 beyond
    // the BMP, a 9 kB line and a final chunk with no newline — a line-oriented
    // forwarder mangles at least four of those.
    expect(received.equals(Buffer.from(STARTUP_NOISE + CALL_NOISE, 'utf8'))).toBe(true);
  });

  it('keeps flowing once AgentFuse is also writing to stderr', async () => {
    wrap = startWrap();

    await handshakeAndCall(wrap);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const received = Buffer.concat(wrap.stderr).toString('utf8');

    // Not byte-equal any more — AgentFuse's own prefixed lines are in there —
    // but every byte the server wrote is still present, in order.
    expect(received).toContain('utf-8: über · 日本語 · 🜛 · ﷽');
    expect(received).toContain('no trailing newline on this last chunk');
    expect(received).toContain('[agentfuse] {"event":"session_start"');
    expect(received.indexOf('noisy-server: starting up')).toBeLessThan(
      received.indexOf('noisy-server: handling a call'),
    );
  });
});

describe('the wrap’s stdout', () => {
  it('carries nothing but JSON-RPC frames', async () => {
    wrap = startWrap();

    const frames = await handshakeAndCall(wrap);
    const raw = Buffer.concat(wrap.stdout).toString('utf8');

    // Every line parses, and every line is JSON-RPC. One stray console.log
    // would leave a line that does not, and the client on the other end would
    // report a parse error from a server that was working a moment ago.
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const message of frames) expect(message.jsonrpc).toBe('2.0');
    expect(raw.endsWith('\n')).toBe(true);
    // Nothing prefixed: the diagnostics never reach this stream.
    expect(raw).not.toContain('[agentfuse]');
  });

  it('answers the handshake with the wrapped server’s own identity', async () => {
    wrap = startWrap({ AGENTFUSE_QUIET: '1' });

    const frames = await handshakeAndCall(wrap);
    const initialize = frames.find((message) => message.id === 1);
    const result = initialize?.result as
      | { serverInfo?: { name?: string }; instructions?: string; capabilities?: unknown }
      | undefined;

    // Mirrored from upstream, not invented: the agent negotiates against the
    // real server.
    expect(result?.serverInfo).toEqual({ name: 'noisy-server', version: '4.5.6' });
    expect(result?.instructions).toBe('Loud on stderr, quiet on stdout.');
    expect(result?.capabilities).toMatchObject({ tools: {} });
  });

  it('forwards tools/list and tools/call to the child', async () => {
    wrap = startWrap({ AGENTFUSE_QUIET: '1' });

    const frames = await handshakeAndCall(wrap);
    const list = frames.find((message) => message.id === 2)?.result as
      | { tools?: { name?: string }[] }
      | undefined;
    const call = frames.find((message) => message.id === 3)?.result as
      | { content?: { text?: string }[] }
      | undefined;

    expect(list?.tools?.map((tool) => tool.name)).toEqual(['echo']);
    expect(call?.content?.[0]?.text).toBe('{"a":1}');
  });

  it('answers a blocked call with an isError result rather than a JSON-RPC error', async () => {
    wrap = startWrap({ AGENTFUSE_QUIET: '1', AGENTFUSE_MODE: 'enforce' });

    await handshakeAndCall(wrap);
    wrap.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo', arguments: { a: 1 } },
    });
    const frames = await wrap.waitForFrames(4);
    const blocked = frames.find((message) => message.id === 4);

    // End to end, through two real pipes and a real child process.
    expect(blocked?.error).toBeUndefined();
    const result = blocked?.result as
      | { isError?: boolean; content?: { text?: string }[] }
      | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain('will be blocked too');
  });
});

describe('the wrap’s lifecycle', () => {
  it('spawns no child until an agent opens the connection', async () => {
    const engine = new FuseEngine(parsePolicy({ version: 1 }), {
      ids: new CounterIdGenerator('s'),
    });
    const [downstream] = InMemoryTransport.createLinkedPair();

    const handle = wrapStdioServer({
      command: process.execPath,
      args: [NOISY_SERVER],
      engine,
      serverName: 'noisy',
      quiet: true,
      transport: downstream,
    });

    // A wrap nobody talks to costs nothing.
    expect(handle.sessionId).toBeUndefined();
    expect(handle.bridge).toBeUndefined();

    await handle.close();
  });

  it('reports a child that will not start instead of hanging', async () => {
    const reported: Error[] = [];
    const engine = new FuseEngine(parsePolicy({ version: 1 }), {
      ids: new CounterIdGenerator('s'),
    });
    const [downstreamA, downstreamB] = InMemoryTransport.createLinkedPair();

    const handle = wrapStdioServer({
      command: `${FIXTURES}there-is-no-such-file.mjs`,
      engine,
      serverName: 'missing',
      quiet: true,
      transport: downstreamB,
      onError: (error) => reported.push(error),
    });

    const client = new Client({ name: 'agent', version: '1' }, { capabilities: {} });
    await expect(client.connect(downstreamA)).rejects.toThrow();
    // A wrap whose child cannot be spawned has to say so on stderr, not leave
    // the agent waiting on a handshake that will never be answered.
    expect(reported.length).toBeGreaterThan(0);

    await handle.close();
  });

  it('declares the capabilities it can relay upstream', () => {
    // Documented over-declaration: the proxy must answer the downstream
    // handshake with the upstream's capabilities, so the upstream connection is
    // established before the real client has said what it supports.
    expect(RELAYABLE_CLIENT_CAPABILITIES).toEqual({
      sampling: {},
      elicitation: {},
      roots: {},
    });
  });
});

describe('the wrap driven in process', () => {
  /**
   * The same entry point, with the downstream transport supplied by the caller
   * instead of taken from this process's stdio — which is how the CLI will use
   * it for anything other than plain wrap mode, and the only way to observe the
   * session id and the bridge from the inside.
   *
   * The child here is the quiet fixture: a spawned child's stderr is inherited
   * and lands on the test runner's own stderr, where it cannot be captured and
   * would bury every other line.
   */
  async function inProcessWrap(mode: 'warn' | 'enforce', extra: Partial<StdioWrapOptions> = {}) {
    const engine = new FuseEngine(
      parsePolicy({ version: 1, mode, loop_detection: { exact_repeat: { count: 2 } } }),
      { ids: new CounterIdGenerator('session') },
    );
    const [downstreamA, downstreamB] = InMemoryTransport.createLinkedPair();
    const handle = wrapStdioServer({
      command: process.execPath,
      args: [QUIET_SERVER],
      engine,
      serverName: 'quiet',
      quiet: true,
      transport: downstreamB,
      ...extra,
    });
    const client = new Client({ name: 'in-process-agent', version: '1.0.0' }, { capabilities: {} });
    await client.connect(downstreamA);
    return { engine, handle, client };
  }

  it('mints one session per connection and mirrors the child’s identity', async () => {
    const { handle, client } = await inProcessWrap('warn');

    // ADR-006's exact regime: one child process, one connection, one ULID from
    // the engine's own IdGenerator.
    expect(handle.sessionId).toBe('session0000000000000000001');
    expect(handle.bridge).toBeDefined();
    expect(client.getServerVersion()).toEqual({ name: 'quiet-server', version: '7.8.9' });
    expect(client.getInstructions()).toBe('Says nothing.');
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });

    await client.close();
    await handle.close();
  });

  it('forwards tools and passes everything else through', async () => {
    const { handle, client } = await inProcessWrap('warn');

    const tools = await client.listTools();
    const call = await client.callTool({ name: 'echo', arguments: { a: 1 } });
    const resources = await client.listResources();

    expect(tools.tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(call.content).toEqual([{ type: 'text', text: '{"a":1}' }]);
    expect(resources.resources).toEqual([{ uri: 'file:///quiet', name: 'quiet' }]);
    expect(handle.bridge?.remap.size).toBe(0);

    await client.close();
    await handle.close();
  });

  it('breaks the circuit on the repeat and answers with a refusal', async () => {
    const { handle, client } = await inProcessWrap('enforce');

    await client.callTool({ name: 'echo', arguments: { a: 1 } });
    const blocked = await client.callTool({ name: 'echo', arguments: { a: 1 } });

    expect(blocked.isError).toBe(true);
    expect((blocked.content?.[0] as { text?: string } | undefined)?.text).toContain(
      'will be blocked too',
    );

    await client.close();
    await handle.close();
  });

  it('ends the session when the connection closes', async () => {
    const { engine, handle, client } = await inProcessWrap('warn');
    const sessionId = handle.sessionId;
    await client.callTool({ name: 'echo', arguments: {} });

    await client.close();
    // The transport closing is what ends a wrap session; give the close
    // callback a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sessionId).toBeDefined();
    // Already ended, so the engine has nothing left under that id and returns
    // the zeroed summary rather than throwing.
    expect(engine.endSession(sessionId ?? '').calls).toBe(0);
    expect(handle.sessionId).toBeUndefined();

    await handle.close();
  });

  it('hands the traceparent hook down to the guarded path', async () => {
    const asked: string[] = [];
    const { handle, client } = await inProcessWrap('warn', {
      traceparentFor: (call, decision) => {
        asked.push(`${String(call.request.params.name)}:${decision.callId}`);
        return undefined;
      },
    });

    await client.callTool({ name: 'echo', arguments: { a: 1 } });

    // The seam is the serving entry's to pass through; what it does with the
    // answer is `tools-call.ts`'s business and is tested there.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^echo:/);

    await client.close();
    await handle.close();
  });

  it('is safe to close twice', async () => {
    const { handle, client } = await inProcessWrap('warn');

    await client.close();
    await handle.close();
    await handle.close();

    expect(handle.bridge).toBeUndefined();
  });
});
