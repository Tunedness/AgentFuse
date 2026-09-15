import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nonProtocolLines, WireClient } from '../testing/wire.js';

/**
 * `agentfuse wrap` as a real process, driven over a real pipe.
 *
 * Everything in `wrap.test.ts` runs in-process with fakes, which is how the
 * branches get covered. Three of wrap mode's promises cannot be tested that
 * way at all, because they are properties of file descriptors:
 *
 * 1. **stdout carries protocol frames and nothing else.** Asserted on the raw
 *    bytes, not on parsed messages: a diagnostic that happened to be valid JSON
 *    would still corrupt the stream.
 * 2. **The wrapped server's stderr arrives byte-for-byte.** The child is
 *    spawned with `stderr: 'inherit'`, so its bytes never enter the AgentFuse
 *    process; the fixture writes a non-UTF-8 sequence and an unterminated line
 *    precisely because those are what a careless forwarder destroys.
 * 3. **The exit code says what happened**, which needs an actual exit.
 *
 * The built entry point is what runs, because `bin` is `dist/main.js` and that
 * is what `npx agentfuse` executes: the shebang, the top-level `await` and
 * `process.exitCode` are only real there. The gate runs `npm run build` before
 * `npm test`, so this always runs in CI; locally it is skipped with a pointed
 * message if `dist` is missing, the same way `cli.test.ts` does it.
 */

const MAIN = fileURLToPath(new URL('../../dist/main.js', import.meta.url));
const SERVER = fileURLToPath(new URL('../testing/fixtures/raw-server.mjs', import.meta.url));
const built = existsSync(MAIN);

/**
 * Bytes the fixture writes to stderr at startup, chosen to break a forwarder.
 *
 * - a plain line, so the ordinary case is covered too;
 * - `0xff 0xfe 0x80`, which is not valid UTF-8 anywhere: a proxy that decoded
 *   and re-encoded would turn these into U+FFFD;
 * - a line with **no trailing newline**, which a line-buffering forwarder
 *   either holds forever or flushes with a newline it invented.
 */
const STARTUP_NOISE = Buffer.concat([
  Buffer.from('raw-server: listening\n', 'utf8'),
  Buffer.from([0xff, 0xfe, 0x80]),
  Buffer.from('\nraw-server: no newline after this', 'utf8'),
]);

/** Bytes it writes on every `tools/call`. */
const CALL_NOISE = Buffer.from([0x2e, 0x00, 0x2e]);

let root: string;
let policyPath: string;

function writePolicy(body: readonly string[]): string {
  const path = join(root, 'fusepolicy.yaml');
  writeFileSync(path, `${body.join('\n')}\n`, 'utf8');
  return path;
}

/** Warn mode, semantic layer off, an exact-repeat threshold of two. */
const WARN_POLICY = [
  'version: 1',
  'mode: warn',
  'report:',
  '  dir: reports',
  'loop_detection:',
  '  exact_repeat:',
  '    count: 2',
  '  semantic:',
  '    enabled: false',
];

/** The same, enforcing. */
const ENFORCE_POLICY = WARN_POLICY.map((line) => (line === 'mode: warn' ? 'mode: enforce' : line));

interface StartOptions {
  readonly flags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

function startWrap(options: StartOptions = {}): WireClient {
  return WireClient.spawn({
    command: process.execPath,
    args: [
      MAIN,
      'wrap',
      '--policy',
      policyPath,
      '--quiet',
      ...(options.flags ?? []),
      '--',
      process.execPath,
      SERVER,
    ],
    // `--quiet` plus a clean environment is what makes the byte comparison
    // possible: the only thing on stderr is then the child's own output.
    env: {
      PATH: process.env['PATH'] ?? '',
      FIXTURE_NOISE: STARTUP_NOISE.toString('hex'),
      FIXTURE_CALL_NOISE: CALL_NOISE.toString('hex'),
      ...options.env,
    },
    cwd: root,
  });
}

/** The text blocks of a `tools/call` result. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-wrap-e2e-'));
  policyPath = writePolicy(WARN_POLICY);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(built)('a real wrap, end to end', () => {
  it('serves the handshake, the tool list and a call, and counts the call', async () => {
    const agent = startWrap();
    try {
      const initialized = (await agent.initialize()) as {
        serverInfo?: { name?: string };
        instructions?: string;
        capabilities?: Record<string, unknown>;
      };

      // Mirrored, not invented: the agent negotiates against the real server's
      // identity, so only the `tools/call` answers differ from talking to it.
      expect(initialized.serverInfo?.name).toBe('raw-server');
      expect(initialized.instructions).toBe('Raw on the wire.');
      expect(initialized.capabilities).toHaveProperty('resources');

      const listed = (await agent.call('tools/list')) as { tools: Array<{ name: string }> };
      expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'boom']);

      const called = await agent.call('tools/call', {
        name: 'echo',
        arguments: { greeting: 'hello' },
      });
      expect(textOf(called)).toBe('{"greeting":"hello"}');

      agent.endInput();
      const { code } = await agent.exit();
      expect(code).toBe(0);
    } finally {
      await agent.dispose();
    }

    // The session summary is the proof the call was metered rather than merely
    // forwarded. It is only written when AgentFuse is not quiet, so the count
    // is checked through a second run below.
  });

  it('reports one call in the session summary', async () => {
    const agent = WireClient.spawn({
      command: process.execPath,
      args: [MAIN, 'wrap', '--policy', policyPath, '--', process.execPath, SERVER],
      env: { PATH: process.env['PATH'] ?? '' },
      cwd: root,
    });
    try {
      await agent.initialize();
      await agent.call('tools/call', { name: 'echo', arguments: { n: 1 } });
      await agent.call('tools/call', { name: 'echo', arguments: { n: 2 } });

      agent.endInput();
      await agent.exit();

      const diagnostics = agent.stderr.toString('utf8');
      expect(diagnostics).toContain('"event":"session_start"');
      expect(diagnostics).toContain('"event":"session_end"');
      expect(diagnostics).toMatch(/"calls":2\b/);
      // ADR-007: every estimate carries its caveat in its name.
      expect(diagnostics).toContain('tokensEstimated');
      expect(diagnostics).toContain('usdEstimated');
      // The alias is guessed from the command, and reported so the guess is
      // visible rather than silent.
      expect(diagnostics).toContain('"server":"raw-server"');
    } finally {
      await agent.dispose();
    }
  });

  it('writes nothing but protocol frames to stdout', async () => {
    const agent = startWrap();
    try {
      await agent.initialize();
      await agent.call('tools/list');
      await agent.call('tools/call', { name: 'echo', arguments: {} });
      await agent.call('resources/list').catch(() => undefined);
      agent.endInput();
      await agent.exit();

      expect(nonProtocolLines(agent.stdout)).toEqual([]);
      // And the frames really are there, so an empty stream cannot pass.
      expect(agent.stdout.toString('utf8').split('\n').filter(Boolean).length).toBeGreaterThan(3);
    } finally {
      await agent.dispose();
    }
  });

  it('passes the wrapped server’s stderr through byte for byte', async () => {
    const agent = startWrap();
    try {
      await agent.initialize();
      await agent.call('tools/call', { name: 'echo', arguments: {} });
      agent.endInput();
      await agent.exit();

      // Exactly the bytes the child wrote, in order, with nothing added: no
      // prefix, no invented newline, no replacement character for the invalid
      // UTF-8, and no line held back for want of a terminator.
      expect(agent.stderr.equals(Buffer.concat([STARTUP_NOISE, CALL_NOISE]))).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('is silent on stderr itself under --quiet, even when a rule fires', async () => {
    const agent = startWrap();
    try {
      await agent.initialize();
      await agent.call('tools/call', { name: 'echo', arguments: { same: true } });
      await agent.call('tools/call', { name: 'echo', arguments: { same: true } });
      agent.endInput();
      await agent.exit();

      expect(agent.stderr.toString('utf8')).not.toContain('[agentfuse]');
    } finally {
      await agent.dispose();
    }
  });
});

describe.runIf(built)('warn mode forwards what it would have blocked', () => {
  it('reports wouldTrip and still returns the server’s answer', async () => {
    const agent = WireClient.spawn({
      command: process.execPath,
      args: [MAIN, 'wrap', '--policy', policyPath, '--', process.execPath, SERVER],
      env: { PATH: process.env['PATH'] ?? '' },
      cwd: root,
    });
    try {
      await agent.initialize();
      const first = await agent.call('tools/call', { name: 'echo', arguments: { loop: 1 } });
      const second = await agent.call('tools/call', { name: 'echo', arguments: { loop: 1 } });

      // The same call twice, with exact_repeat.count at two: the rule fires.
      expect(agent.stderr.toString('utf8')).toContain('"event":"would_trip"');
      expect(agent.stderr.toString('utf8')).toContain('LOOP_EXACT_REPEAT');

      // And the call went through anyway. This is the mechanism that lets an
      // operator measure the false-positive rate before enforcing — PRD risk #1.
      expect(textOf(first)).toBe('{"loop":1}');
      expect(textOf(second)).toBe('{"loop":1}');
      expect((second as { isError?: boolean }).isError).toBeUndefined();

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });
});

describe.runIf(built)('enforce mode refuses the call the agent can read', () => {
  beforeEach(() => {
    policyPath = writePolicy(ENFORCE_POLICY);
  });

  it('answers with isError, writes a report, and `report last` renders it', async () => {
    const agent = startWrap();
    let blocked: unknown;
    try {
      await agent.initialize();
      await agent.call('tools/call', { name: 'echo', arguments: { loop: 2 } });
      blocked = await agent.call('tools/call', { name: 'echo', arguments: { loop: 2 } });

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }

    // A refusal, not a protocol error: `call` would have thrown on an error
    // response, and an agent that receives a JSON-RPC error learns nothing it
    // can act on.
    const result = blocked as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).toBe(true);
    // The agent-facing text is advice, not an error code: what to do instead,
    // plus the warning that retrying unchanged will be blocked too.
    expect(textOf(result)).toContain('circuit breaker OPEN');
    expect(textOf(result)).toContain('Retrying this call unchanged');
    // The machine-readable half carries the code.
    expect(JSON.stringify(result.structuredContent)).toContain('LOOP_EXACT_REPEAT');

    // The report landed under report.dir, resolved relative to the policy file
    // rather than to whatever directory the agent was launched in.
    const reports = readdirSync(join(root, 'reports'));
    expect(reports).toHaveLength(1);
    expect(textOf(result)).toContain(join(root, 'reports'));

    // And the command a human runs afterwards renders it.
    const reader = WireClient.spawn({
      command: process.execPath,
      args: [MAIN, 'report', 'last', '--dir', join(root, 'reports')],
      env: { PATH: process.env['PATH'] ?? '' },
      cwd: root,
    });
    try {
      reader.endInput();
      expect((await reader.exit()).code).toBe(0);
      const rendered = reader.stdout.toString('utf8');
      expect(rendered).toContain('LOOP_EXACT_REPEAT');
      expect(rendered).toContain('stored at');
    } finally {
      await reader.dispose();
    }
  });
});

describe.runIf(built)('the unglamorous endings', () => {
  it('reports a command that does not exist instead of a stack trace', async () => {
    const agent = WireClient.spawn({
      command: process.execPath,
      args: [
        MAIN,
        'wrap',
        '--policy',
        policyPath,
        '--',
        join(root, 'definitely-not-an-executable'),
      ],
      env: { PATH: process.env['PATH'] ?? '' },
      cwd: root,
    });
    try {
      // The child is spawned when the agent connects, so the failure surfaces
      // while the opening request is in flight. Deliberately not awaited: a
      // handshake that never gets a reply is exactly the symptom, and the wrap
      // must still come down by itself rather than hang holding the pipe.
      void agent.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'wire-test-client', version: '0.0.0' },
      });

      const { code } = await agent.exit();
      expect(code).toBe(70);

      const diagnostics = agent.stderr.toString('utf8');
      expect(diagnostics).toContain('"event":"child_spawn_failed"');
      expect(diagnostics).toContain('ENOENT');
      expect(diagnostics).not.toContain('at Object.');
      expect(diagnostics).not.toContain('node:internal');
    } finally {
      await agent.dispose();
    }
  });

  it('exits 70 when the wrapped server dies under it', async () => {
    const agent = startWrap({ env: { FIXTURE_DIE_AFTER_MS: '20', FIXTURE_EXIT_CODE: '9' } });
    try {
      await agent.initialize();

      // Without this the wrap would linger and answer every later call with an
      // error, so an MCP client would see a working server that always fails
      // rather than a dead one it could restart.
      const { code } = await agent.exit();
      expect(code).toBe(70);
    } finally {
      await agent.dispose();
    }
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('shuts down on %s', async (signal) => {
    const agent = startWrap();
    try {
      await agent.initialize();
      await agent.call('tools/call', { name: 'echo', arguments: {} });

      agent.signal(signal);

      const { code } = await agent.exit();
      expect(code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });
});
