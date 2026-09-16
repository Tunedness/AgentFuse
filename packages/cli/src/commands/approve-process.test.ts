import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonProtocolLines, WireClient } from '../testing/wire.js';

// These tests spawn real processes over real pipes, so their wall clock is the
// machine's, not the code's. Vitest's 5 s default is enough in isolation and
// too tight under a loaded full-suite run — which shows up as a random red
// build rather than as a bug. The assertions are about behaviour, never speed.
vi.setConfig({ testTimeout: 20_000 });

/**
 * The approval flow as two real processes.
 *
 * This is the test the whole phase exists to pass: a wrapped proxy blocks on a
 * `require_approval` decision, a **second `agentfuse` process** delivers the
 * verdict over the unix socket, and the suspended `tools/call` completes. None
 * of that can be shown in-process — the point of the design is that the person
 * answering is somewhere else, and the socket, the file modes and the two
 * process lifetimes are the substance of it.
 *
 * `dist/main.js` is what runs, on both sides, because that is what `npx
 * agentfuse` executes. The gate runs `npm run build` before `npm test`, so this
 * always runs in CI; locally it is skipped with a pointed message when `dist`
 * is missing, the way `wrap-process.test.ts` does it.
 *
 * Every run gets its own socket through `AGENTFUSE_APPROVAL_SOCKET`. Nothing
 * here may touch the developer's real `~/.agentfuse`.
 */

const MAIN = fileURLToPath(new URL('../../dist/main.js', import.meta.url));
const SERVER = fileURLToPath(new URL('../testing/fixtures/raw-server.mjs', import.meta.url));
const built = existsSync(MAIN);

let root: string;
let socketPath: string;

/** Enforce, semantic layer off, and `echo` gated behind a human. */
function approvalPolicy(extra: readonly string[] = []): string[] {
  return [
    'version: 1',
    'mode: enforce',
    'report:',
    '  dir: reports',
    'budgets:',
    '  on_exceeded: halt',
    'loop_detection:',
    '  on_trip: halt',
    '  semantic:',
    '    enabled: false',
    'approvals:',
    '  gateways: [cli]',
    ...extra,
    'tools:',
    '  - match: "raw-server__echo"',
    '    action: require_approval',
    '    note: "writes to prod"',
  ];
}

function writePolicy(lines: readonly string[], name = 'fusepolicy.yaml'): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

interface StartOptions {
  readonly policyPath?: string;
  readonly socket?: string;
  readonly env?: Readonly<Record<string, string>>;
}

function startWrap(options: StartOptions = {}): WireClient {
  return WireClient.spawn({
    command: process.execPath,
    args: [
      MAIN,
      'wrap',
      '--policy',
      options.policyPath ?? join(root, 'fusepolicy.yaml'),
      '--',
      process.execPath,
      SERVER,
    ],
    env: {
      PATH: process.env['PATH'] ?? '',
      AGENTFUSE_APPROVAL_SOCKET: options.socket ?? socketPath,
      ...options.env,
    },
    cwd: root,
  });
}

/** Runs a second `agentfuse` process to its exit. */
async function agentfuse(
  args: readonly string[],
  socket = socketPath,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [MAIN, ...args],
      { env: { PATH: process.env['PATH'] ?? '', AGENTFUSE_APPROVAL_SOCKET: socket } },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : Number(error.code ?? 1);
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Waits for something to show up on a wrap's stderr. */
async function waitForStderr(agent: WireClient, needle: string, label = needle): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const text = agent.stderr.toString('utf8');
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}; stderr was:\n${agent.stderr.toString('utf8')}`);
}

/**
 * The approval id out of the pending prompt's machine line.
 *
 * The **last** one in the buffer: a wrap that has asked more than once has
 * written more than one, and the interesting prompt is always the newest.
 */
function pendingId(stderr: string): string {
  const ids = [...stderr.matchAll(/"event":"approval_pending","approvalId":"([^"]+)"/g)];
  const last = ids.at(-1)?.[1];
  if (last === undefined) throw new Error(`no pending approval in:\n${stderr}`);
  return last;
}

/** The session id the wrap minted when the agent connected. */
function sessionId(stderr: string): string {
  const match = /"event":"session_start","sessionId":"([^"]+)"/.exec(stderr);
  if (match?.[1] === undefined) throw new Error(`no session_start in:\n${stderr}`);
  return match[1];
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
  // Short prefix: a unix socket path has about a hundred bytes to live in, and
  // macOS spends half of that on `tmpdir()` alone.
  root = mkdtempSync(join(tmpdir(), 'af-e2e-'));
  socketPath = join(root, 'a.sock');
  writePolicy(approvalPolicy(['  timeout: 30s']));
});

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(built)('a real approval, two processes', () => {
  it('blocks the call, prompts on stderr, and releases it when a human approves', async () => {
    const agent = startWrap();
    try {
      await agent.initialize();

      // Deliberately not awaited: the call is suspended inside the wrap until
      // somebody answers, which is the whole mechanism under test.
      const call = agent.request('tools/call', {
        name: 'echo',
        arguments: { path: '/etc/hosts' },
      });

      const prompt = await waitForStderr(agent, '"event":"approval_pending"', 'the pending prompt');

      // The prompt has to be answerable without going to look anything up.
      expect(prompt).toContain('approval needed — echo on raw-server');
      expect(prompt).toContain('writes to prod');
      expect(prompt).toContain('{"path":"/etc/hosts"}');
      expect(prompt).toContain('agentfuse approve');
      expect(prompt).toContain('--reason');

      // And the socket it named is real, 0600, in a 0700 directory.
      expect((statSync(socketPath).mode & 0o777).toString(8)).toBe('600');
      expect((statSync(root).mode & 0o777).toString(8)).toBe('700');

      const approval = await agentfuse([
        'approve',
        pendingId(prompt),
        '--reason',
        'checked the path by hand',
      ]);
      expect(approval.code).toBe(0);
      expect(approval.stdout).toContain('Approved echo on raw-server');

      // The suspended call completes with the wrapped server's real answer.
      const answered = await call;
      expect(answered.error).toBeUndefined();
      expect(textOf(answered.result)).toBe('{"path":"/etc/hosts"}');

      // And the verdict, with the human's reason, is in the wrap's log.
      const after = agent.stderr.toString('utf8');
      expect(after).toContain('"verdict":"approved"');
      expect(after).toContain('checked the path by hand');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);

      // And through all of that, stdout carried protocol frames and nothing
      // else. The prompt is on stderr because in this mode stdout *is* the
      // agent's JSON-RPC stream — one line of it and every later frame is
      // corrupt, with the wrapped server getting the blame.
      expect(nonProtocolLines(agent.stdout)).toEqual([]);
    } finally {
      await agent.dispose();
    }

    // The wrap took its socket with it.
    expect(existsSync(socketPath)).toBe(false);
  });

  it('refuses the call, readably, when a human denies', async () => {
    const agent = startWrap();
    try {
      await agent.initialize();
      const call = agent.request('tools/call', { name: 'echo', arguments: { rm: '-rf' } });
      const prompt = await waitForStderr(agent, '"event":"approval_pending"', 'the pending prompt');

      const denial = await agentfuse(['deny', pendingId(prompt), '--reason', 'not on prod']);
      expect(denial.code).toBe(0);
      expect(denial.stdout).toContain('Denied echo on raw-server');

      const answered = await call;
      // A refusal, not a protocol error: the agent has to be able to read it.
      expect(answered.error).toBeUndefined();
      const result = answered.result as { isError?: boolean; structuredContent?: unknown };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('a human explicitly denied this call');
      expect(textOf(result)).toContain('Retrying this call unchanged');
      expect(JSON.stringify(result.structuredContent)).toContain('APPROVAL_DENIED');
      // ADR-009: the human's own words reach the agent for a denial, attributed
      // so the model reads them as a person's statement rather than as another
      // instruction. This is the whole trip: `--reason` on a second process, in
      // over a unix socket, out through the refusal the first process renders.
      expect(textOf(result)).toContain('A human denied this call. Reason given: not on prod');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });
});

describe.runIf(built)('when nobody answers', () => {
  it('denies with APPROVAL_TIMEOUT and tells the agent what to do instead', async () => {
    writePolicy(approvalPolicy(['  timeout: 400ms', '  on_timeout: deny']));
    const agent = startWrap();
    try {
      await agent.initialize();

      const answered = await agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });

      const result = answered.result as { isError?: boolean; structuredContent?: unknown };
      expect(result.isError).toBe(true);
      const text = textOf(result);
      // The same product-surface bar as every other refusal: what happened,
      // that a retry will not help, and two or three concrete alternatives.
      expect(text).toContain('nobody answered the approval request');
      expect(text).toContain('400ms');
      expect(text).toContain('Retrying this call unchanged');
      expect(text).toContain('ask them to answer it');
      expect(JSON.stringify(result.structuredContent)).toContain('APPROVAL_TIMEOUT');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });

  it('forwards the call under on_timeout: allow, and says it is failing open', async () => {
    writePolicy(approvalPolicy(['  timeout: 400ms', '  on_timeout: allow']));
    const agent = startWrap();
    try {
      await agent.initialize();

      // The warning is written at startup, before any call: an operator should
      // not have to blow a budget to discover the tool is failing open.
      const startup = agent.stderr.toString('utf8');
      expect(startup).toContain('fail OPEN');
      expect(startup).toContain('not recommended');

      const answered = await agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });

      expect((answered.result as { isError?: boolean }).isError).toBeUndefined();
      expect(textOf(answered.result)).toBe('{"a":1}');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });
});

describe.runIf(built)('the breaker, answered by hand', () => {
  it('re-opens when a human says no while it is half-open', async () => {
    // `on_trip: require_approval` puts the breaker in `half_open` on the first
    // trip, where the human *is* the probe. Phase 2 recorded that a refusal
    // there is at least as strong a signal as a re-trip, so it goes to `open`.
    writePolicy([
      'version: 1',
      'mode: enforce',
      'report:',
      '  dir: reports',
      'budgets:',
      '  on_exceeded: halt',
      'loop_detection:',
      '  on_trip: require_approval',
      '  exact_repeat:',
      '    count: 2',
      '  semantic:',
      '    enabled: false',
      'approvals:',
      '  timeout: 30s',
      '  gateways: [cli]',
    ]);
    const agent = startWrap();
    try {
      await agent.initialize();
      await agent.call('tools/call', { name: 'echo', arguments: { loop: 1 } });

      // The second identical call trips the rule, which asks for a human.
      const second = agent.request('tools/call', { name: 'echo', arguments: { loop: 1 } });
      const prompt = await waitForStderr(agent, '"event":"approval_pending"', 'the pending prompt');
      // The prompt explains the *rule* that asked, not merely that something did.
      expect(prompt).toContain('identical arguments');

      await agentfuse(['deny', pendingId(prompt), '--reason', 'it really is looping']);
      const denied = (await second).result as { isError?: boolean };
      expect(denied.isError).toBe(true);

      // The breaker is open now, so the next call is refused without anybody
      // being asked — no second prompt.
      const third = await agent.request('tools/call', { name: 'echo', arguments: { fresh: true } });
      const result = third.result as { isError?: boolean; structuredContent?: unknown };
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain('BREAKER_OPEN');
      expect(textOf(result)).toContain('the breaker is already open');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });

  it('is closed again by approve --session <id> --reset, and the next call goes through', async () => {
    // NOTE: `--reset` closes the breaker outright rather than leaving it
    // half-open. That is core's frozen `resetBreaker`, whose own TSDoc names
    // this very command; see the phase 7 section of
    // `docs/implementation-status.md` for the divergence from the plan.
    writePolicy([
      'version: 1',
      'mode: enforce',
      'report:',
      '  dir: reports',
      'budgets:',
      '  on_exceeded: halt',
      'loop_detection:',
      '  on_trip: halt',
      '  exact_repeat:',
      '    count: 2',
      '  semantic:',
      '    enabled: false',
      'approvals:',
      '  timeout: 30s',
      '  gateways: [cli]',
      'tools:',
      '  - match: "raw-server__echo"',
      '    action: require_approval',
    ]);
    const agent = startWrap();
    try {
      await agent.initialize();

      // One approved call, then the identical one trips exact-repeat with
      // `on_trip: halt`, which opens the circuit without asking anybody.
      const first = agent.request('tools/call', { name: 'echo', arguments: { loop: 1 } });
      await agentfuse([
        'approve',
        pendingId(await waitForStderr(agent, '"event":"approval_pending"', 'the first prompt')),
        '--reason',
        'fine',
      ]);
      expect(textOf((await first).result)).toBe('{"loop":1}');

      const tripped = await agent.request('tools/call', { name: 'echo', arguments: { loop: 1 } });
      expect(
        JSON.stringify((tripped.result as { structuredContent?: unknown }).structuredContent),
      ).toContain('LOOP_EXACT_REPEAT');

      // Every later call is refused by the open breaker, with nobody asked.
      const whileOpen = await agent.request('tools/call', { name: 'echo', arguments: { x: 1 } });
      expect(textOf(whileOpen.result)).toContain('the breaker is already open');

      const session = sessionId(agent.stderr.toString('utf8'));
      const reset = await agentfuse([
        'approve',
        '--session',
        session,
        '--reset',
        '--reason',
        'read the report, it was a false positive',
      ]);
      expect(reset.code).toBe(0);
      expect(reset.stdout).toContain(`Reset the breaker for session ${session}`);
      expect(reset.stdout).toContain('The breaker is now closed.');

      // A closed breaker puts the tool rule back in charge, so the next call
      // asks a human again instead of being refused outright.
      const after = agent.request('tools/call', { name: 'echo', arguments: { fresh: true } });
      const prompt = await waitForStderr(agent, '"fresh"', 'a fresh prompt');
      await agentfuse(['approve', pendingId(prompt), '--reason', 'fine']);
      expect(textOf((await after).result)).toBe('{"fresh":true}');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });
});

describe.runIf(built)('socket hygiene, with real processes', () => {
  it('does not let a second wrap take the first one’s socket', async () => {
    const first = startWrap();
    // Sequenced deliberately: both wraps bind at startup, so starting them
    // together would leave which one gets the well-known path to a race. The
    // rule under test is what the *newcomer* does.
    await waitForStderr(first, '"event":"approval_socket_open"', 'the first socket');
    const second = startWrap();
    try {
      await first.initialize();
      await second.initialize();
      const secondStderr = await waitForStderr(
        second,
        '"event":"approval_socket_open"',
        'the second socket',
      );

      // The newcomer reports the fallback path and prints it in its prompts;
      // the first wrap is still the one listening on the well-known path.
      expect(secondStderr).toContain('"fallback":true');
      const bound = /"event":"approval_socket_open","path":"([^"]+)"/.exec(secondStderr)?.[1];
      expect(bound).toBeDefined();
      expect(bound).not.toBe(socketPath);
      expect(secondStderr).toContain('"why":"live"');

      // A verdict sent to the default path reaches the FIRST wrap, and the
      // second wrap's prompt says which socket to use instead.
      const call = second.request('tools/call', { name: 'echo', arguments: { which: 2 } });
      const prompt = await waitForStderr(second, '"event":"approval_pending"', 'the second prompt');
      expect(prompt).toContain(`--socket ${bound}`);

      const misdirected = await agentfuse(['approve', pendingId(prompt), '--reason', 'oops']);
      expect(misdirected.code).toBe(2);
      expect(misdirected.stdout).toContain('no call is waiting');

      const delivered = await agentfuse(
        ['approve', pendingId(prompt), '--reason', 'right socket'],
        bound as string,
      );
      expect(delivered.code).toBe(0);
      expect(textOf((await call).result)).toBe('{"which":2}');

      first.endInput();
      second.endInput();
      expect((await first.exit()).code).toBe(0);
      expect((await second.exit()).code).toBe(0);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('survives a malformed frame and still answers the next real one', async () => {
    const agent = startWrap();
    try {
      await agent.initialize();
      const call = agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });
      const prompt = await waitForStderr(agent, '"event":"approval_pending"', 'the pending prompt');

      // Not through the client: the point is bytes no `agentfuse` would send.
      const answer = await new Promise<string>((resolve) => {
        const socket = createConnection(socketPath);
        let out = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write('{"v":1,"type":"verdict"\n'));
        socket.on('data', (chunk: string) => {
          out += chunk;
        });
        socket.on('close', () => resolve(out));
        socket.on('error', () => resolve(out));
      });
      expect(answer).toContain('could not read that command');

      // Still serving, and the pending call is still pending.
      const approval = await agentfuse(['approve', pendingId(prompt), '--reason', 'fine']);
      expect(approval.code).toBe(0);
      expect(textOf((await call).result)).toBe('{"a":1}');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });
});

describe.runIf(built)('the webhook channel, against a real endpoint', () => {
  /** A receiver that verifies the HMAC with its own crypto and then approves. */
  async function endpoint(secret: string): Promise<{ url: string; verified: boolean[] }> {
    const verified: boolean[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const expected = `v1=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
        const ok = req.headers['x-agentfuse-signature'] === expected;
        verified.push(ok);
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(
          ok
            ? '{"verdict":"approved","reason":"on-call approved it"}'
            : '{"error":"bad signature"}',
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/approvals`, verified };
  }

  it('signs a request a receiver can verify, and forwards the call it approves', async () => {
    const receiver = await endpoint('the-shared-secret');
    writePolicy([
      'version: 1',
      'mode: enforce',
      'report:',
      '  dir: reports',
      'budgets:',
      '  on_exceeded: halt',
      'loop_detection:',
      '  on_trip: halt',
      '  semantic:',
      '    enabled: false',
      'approvals:',
      '  timeout: 30s',
      '  gateways: [webhook]',
      '  webhook:',
      `    url: ${receiver.url}`,
      '    secret_env: AF_WEBHOOK_SECRET',
      'tools:',
      '  - match: "raw-server__echo"',
      '    action: require_approval',
    ]);

    const agent = startWrap({ env: { AF_WEBHOOK_SECRET: 'the-shared-secret' } });
    try {
      await agent.initialize();
      const answered = await agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });

      expect(receiver.verified).toEqual([true]);
      expect(textOf(answered.result)).toBe('{"a":1}');

      const stderr = agent.stderr.toString('utf8');
      expect(stderr).toContain('"source":"webhook"');
      expect(stderr).toContain('on-call approved it');
      // No socket for this policy: it named one channel and it was not the
      // terminal one.
      expect(existsSync(socketPath)).toBe(false);
      // And the secret is nowhere in the wrap's own output.
      expect(stderr).not.toContain('the-shared-secret');
      expect(stderr).toContain('AF_WEBHOOK_SECRET');

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });
});

/**
 * ADR-009's second half: the words a person typed reach the audit artifact.
 *
 * The rule-level `require_approval` used by the tests above never trips the
 * breaker, so it builds no report. The breaker's own `on_trip:
 * require_approval` does, and that is the path a trip report — and therefore
 * `agentfuse report` — is written from.
 */
describe.runIf(built)('the reason in the report', () => {
  /** `ESC`, spelled out so the source stays readable. */
  const ESC = '\u001B';

  /** Enforce mode where the second identical call goes to a human. */
  function trippingPolicy(): string[] {
    return [
      'version: 1',
      'mode: enforce',
      'report:',
      '  dir: reports',
      'loop_detection:',
      '  exact_repeat:',
      '    count: 2',
      '  on_trip: require_approval',
      '  semantic:',
      '    enabled: false',
      'approvals:',
      '  timeout: 30s',
      '  gateways: [cli]',
    ];
  }

  /** Drives one wrap to a human-gated repeat and answers it. */
  async function answered(
    verdict: 'approve' | 'deny',
    reason: string,
  ): Promise<{ stderr: string }> {
    writePolicy(trippingPolicy());
    const agent = startWrap();
    try {
      await agent.initialize();
      await agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });
      const call = agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });
      const prompt = await waitForStderr(agent, '"event":"approval_pending"', 'the prompt');

      const reply = await agentfuse([verdict, pendingId(prompt), '--reason', reason]);
      expect(reply.code).toBe(0);
      await call;

      agent.endInput();
      await agent.exit();
      return { stderr: agent.stderr.toString('utf8') };
    } finally {
      await agent.dispose();
    }
  }

  /** `agentfuse report` run against this root's report directory. */
  async function report(...flags: readonly string[]) {
    return await agentfuse(['report', 'last', '--dir', join(root, 'reports'), ...flags]);
  }

  it('renders an approval’s reason in `agentfuse report`', async () => {
    await answered('approve', 'the retry is intentional, I asked for it');

    const rendered = await report();
    expect(rendered.code).toBe(0);
    expect(rendered.stdout).toContain('human: approved');
    expect(rendered.stdout).toContain('the retry is intentional, I asked for it');

    const json = JSON.parse((await report('--json')).stdout) as {
      approval?: { verdict?: string; reason?: string };
    };
    expect(json.approval).toEqual({
      verdict: 'approved',
      reason: 'the retry is intentional, I asked for it',
    });
  });

  it('renders a denial’s reason the same way', async () => {
    await answered('deny', 'that path is production');

    const rendered = await report();
    expect(rendered.stdout).toContain('human: denied');
    expect(rendered.stdout).toContain('that path is production');
  });

  it('cannot be broken by a hostile reason', async () => {
    // Free text typed by a person, and the report is a file somebody else
    // reads on their terminal. Escapes, controls, newlines and length all have
    // to be neutralised before it is stored — see `core/src/util/text.ts`.
    // Under the socket protocol's own 1 KiB cap on `--reason`, so what is
    // being tested here is the engine's sanitising rather than that refusal.
    const hostile = `${ESC}[31mred${ESC}[0m\nSECOND LINE\r\n${'very '.repeat(150)}`;

    await answered('approve', hostile);

    const rendered = await report();
    const json = JSON.parse((await report('--json')).stdout) as {
      approval?: { reason?: string };
    };
    const reason = json.approval?.reason ?? '';

    expect(rendered.code).toBe(0);
    // Stored: no escapes, no controls, no newlines, and bounded.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(reason)).toBe(false);
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).toContain('red');
    // Rendered: the ruled report is still one block of our own lines, and
    // "SECOND LINE" is inside a wrapped paragraph rather than starting one.
    expect(rendered.stdout).not.toContain(ESC);
    expect(rendered.stdout.split('\n').some((line) => line.startsWith('SECOND LINE'))).toBe(false);
    expect(rendered.stdout).toContain('recent calls');
  });

  it('keeps the webhook secret out of the reason it records', async () => {
    // The webhook's `reason` is written by a remote endpoint, so it is the one
    // field an attacker could aim at the audit record. It still cannot carry
    // the secret: nothing but the HMAC ever reads it.
    const secret = 'the-shared-secret';
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const expected = `v1=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
        const ok = req.headers['x-agentfuse-signature'] === expected;
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(ok ? '{"verdict":"approved","reason":"on-call approved it"}' : '{}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    writePolicy([
      ...trippingPolicy().filter((line) => line !== '  gateways: [cli]'),
      '  gateways: [webhook]',
      '  webhook:',
      `    url: http://127.0.0.1:${port}/approvals`,
      '    secret_env: AF_WEBHOOK_SECRET',
    ]);

    const agent = startWrap({ env: { AF_WEBHOOK_SECRET: secret } });
    try {
      await agent.initialize();
      await agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });
      await agent.request('tools/call', { name: 'echo', arguments: { a: 1 } });
      agent.endInput();
      await agent.exit();
    } finally {
      await agent.dispose();
    }

    const stored = (await report('--json')).stdout;
    expect(JSON.parse(stored).approval).toEqual({
      verdict: 'approved',
      reason: 'on-call approved it',
    });
    expect(stored).not.toContain(secret);
  });
});
