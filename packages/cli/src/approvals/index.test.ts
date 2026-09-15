import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FusePolicy, parsePolicy } from '@agentfuse/core';
import { DIAGNOSTIC_PREFIX, Diagnostics } from '@agentfuse/proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { StringWriter, writeNotice } from '../io.js';
import { CompositeApprovalGateway } from './compose.js';
import { type ApprovalResolution, resolveApprovalGateway, wantsApproval } from './index.js';
import { SOCKET_ENV_VAR } from './protocol.js';

/**
 * The decision table, row by row. The rows are the whole point: each one is a
 * different answer to "the thing you configured is not usable", and the one
 * that matters most is the one where a broken channel warns rather than
 * refusing to start — because a missing approval channel makes AgentFuse
 * stricter, while a wrap that will not start makes it absent.
 */

let root: string;
let stderr: StringWriter;
let sink: StringWriter;
const opened: ApprovalResolution[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-gw-'));
  stderr = new StringWriter();
  sink = new StringWriter();
});

afterEach(async () => {
  for (const resolution of opened.splice(0)) {
    if (resolution.kind === 'ready') await resolution.close();
  }
  rmSync(root, { recursive: true, force: true });
});

function policy(yaml: string): FusePolicy {
  return parsePolicy(parseYaml(yaml));
}

type Extras = Pick<Parameters<typeof resolveApprovalGateway>[0], 'listen' | 'fetch' | 'now'>;

async function resolve(
  yaml: string,
  env: Readonly<Record<string, string>> = {},
  extras: Partial<Extras> = {},
): Promise<ApprovalResolution> {
  const resolution = await resolveApprovalGateway({
    policy: policy(yaml),
    env,
    diagnostics: new Diagnostics({ sink }),
    stderr,
    warn: (lines) => writeNotice(stderr, 'warning', lines),
    ...extras,
  });
  opened.push(resolution);
  return resolution;
}

/** Every diagnostic event name written so far. */
function events(): string[] {
  return sink.lines.flatMap((line) => {
    try {
      const payload = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length).trim()) as {
        event?: unknown;
      };
      return typeof payload.event === 'string' ? [payload.event] : [];
    } catch {
      return [];
    }
  });
}

const ASKS = 'version: 1\nmode: enforce\ntools:\n  - match: "*"\n    action: require_approval\n';

describe('wantsApproval', () => {
  it.each([
    ['a budget', 'version: 1\nbudgets:\n  on_exceeded: require_approval\n'],
    ['a loop trip', 'version: 1\nloop_detection:\n  on_trip: require_approval\n'],
    ['a tool rule', 'version: 1\ntools:\n  - match: "shell__*"\n    action: require_approval\n'],
    [
      'a per-rule loop override',
      'version: 1\ntools:\n  - match: "shell__*"\n    action: allow\n    loop_detection:\n      on_trip: require_approval\n',
    ],
  ])('finds it asked for by %s', (_label, yaml) => {
    expect(wantsApproval(policy(yaml))).toBe(true);
  });

  it('is false for a policy that never asks', () => {
    expect(
      wantsApproval(
        policy('version: 1\nbudgets:\n  on_exceeded: halt\nloop_detection:\n  on_trip: halt\n'),
      ),
    ).toBe(false);
  });
});

describe('the rows that open nothing', () => {
  it('is off in warn mode, silently', async () => {
    const resolution = await resolve(
      'version: 1\nmode: warn\ntools:\n  - match: "*"\n    action: require_approval\n',
      { [SOCKET_ENV_VAR]: join(root, 'a.sock') },
    );

    expect(resolution).toEqual({ kind: 'off', reason: 'warn mode never asks a human' });
    expect(stderr.text).toBe('');
    expect(existsSync(join(root, 'a.sock'))).toBe(false);
  });

  it('is off for a policy that never asks, silently', async () => {
    const resolution = await resolve(
      'version: 1\nmode: enforce\nbudgets:\n  on_exceeded: halt\nloop_detection:\n  on_trip: halt\n',
      { [SOCKET_ENV_VAR]: join(root, 'a.sock') },
    );

    expect(resolution.kind).toBe('off');
    expect(stderr.text).toBe('');
  });

  it('warns when the policy asks and lists no channel at all', async () => {
    const resolution = await resolve(`${ASKS}approvals:\n  gateways: []\n`, {
      [SOCKET_ENV_VAR]: join(root, 'a.sock'),
    });

    expect(resolution).toMatchObject({ kind: 'off', reason: 'approvals.gateways is empty' });
    expect(stderr.text).toContain('approvals.gateways is empty');
    expect(stderr.text).toContain('fail closed');
  });
});

describe('the cli channel', () => {
  it('binds the socket and reports where', async () => {
    const socket = join(root, 'a.sock');

    const resolution = await resolve(ASKS, { [SOCKET_ENV_VAR]: socket });

    expect(resolution.kind).toBe('ready');
    expect(resolution.kind === 'ready' && resolution.sources).toEqual(['cli']);
    expect(resolution.kind === 'ready' && resolution.socketPath).toBe(socket);
    expect(existsSync(socket)).toBe(true);
    expect(events()).toContain('approval_gateway');
  });

  it('is the default channel, so a policy that says nothing gets a prompt', async () => {
    const resolution = await resolve(ASKS, { [SOCKET_ENV_VAR]: join(root, 'a.sock') });

    expect(resolution.kind === 'ready' && resolution.sources).toEqual(['cli']);
  });

  it('warns and goes quiet when there is nowhere to put the socket', async () => {
    // Not a hard error. With no channel, `require_approval` resolves to a
    // denial — stricter than what was asked for — while refusing to start takes
    // the user's MCP server down and leaves the agent with no fuse at all.
    const resolution = await resolve(ASKS, {});

    expect(resolution).toMatchObject({
      kind: 'off',
      reason: 'no approval channel could be opened',
    });
    expect(stderr.text).toContain('cli approval channel could not be opened');
    expect(stderr.text).toContain('fail closed');
    // The hints from the underlying failure come with it, so the warning says
    // what to do and not merely what happened.
    expect(stderr.text).toContain(SOCKET_ENV_VAR);
    expect(events()).toContain('approval_gateway_unavailable');
  });

  it('collapses a duplicated channel rather than opening two listeners', async () => {
    const resolution = await resolve(`${ASKS}approvals:\n  gateways: [cli, cli]\n`, {
      [SOCKET_ENV_VAR]: join(root, 'a.sock'),
    });

    expect(resolution.kind === 'ready' && resolution.sources).toEqual(['cli']);
  });

  it('takes an injected listener, which is how a test avoids the filesystem', async () => {
    let seen: string | undefined;
    const resolution = await resolve(
      ASKS,
      { [SOCKET_ENV_VAR]: '/tmp/never-bound.sock' },
      {
        listen: async (listenOptions) => {
          seen = listenOptions.path;
          return { path: listenOptions.path, close: async () => undefined };
        },
      },
    );

    expect(seen).toBe('/tmp/never-bound.sock');
    expect(resolution.kind === 'ready' && resolution.socketPath).toBe('/tmp/never-bound.sock');
    expect(existsSync('/tmp/never-bound.sock')).toBe(false);
  });

  it('reports a channel that fails with something that is not a CliError', async () => {
    const resolution = await resolve(
      ASKS,
      { [SOCKET_ENV_VAR]: join(root, 'a.sock') },
      {
        listen: async () => {
          throw new Error('the kernel said no');
        },
      },
    );

    expect(resolution.kind).toBe('off');
    expect(stderr.text).toContain('the kernel said no');
  });

  it('hands the engine over through bindHost', async () => {
    const resolution = await resolve(ASKS, { [SOCKET_ENV_VAR]: join(root, 'a.sock') });
    if (resolution.kind !== 'ready') throw new Error('expected a channel');

    // The engine does not exist yet when the socket is bound, so the host
    // arrives late; this is the seam `createRuntime` uses.
    expect(() => resolution.bindHost({ resetBreaker: () => 'closed' })).not.toThrow();
  });
});

describe('the webhook channel', () => {
  const WEBHOOK = `${ASKS}approvals:\n  gateways: [webhook]\n  webhook:\n    url: https://example.internal/approvals\n    secret_env: AF_SECRET\n`;

  it('reads the secret from the environment the policy names', async () => {
    const resolution = await resolve(WEBHOOK, { AF_SECRET: 'shhh' });

    expect(resolution.kind === 'ready' && resolution.sources).toEqual(['webhook']);
    expect(resolution.kind === 'ready' && resolution.socketPath).toBeUndefined();
    // The policy file names the variable, never the value: it is meant to be
    // committed and diffed.
    expect(WEBHOOK).not.toContain('shhh');
  });

  it('takes an injected fetch and clock, which is how the webhook is tested', async () => {
    const calls: string[] = [];
    const resolution = await resolve(
      WEBHOOK,
      { AF_SECRET: 'shhh' },
      {
        fetch: async (input) => {
          calls.push(input);
          return new Response('{"verdict":"approved"}', { status: 200 });
        },
        now: () => 1_758_000_000_000,
      },
    );
    if (resolution.kind !== 'ready') throw new Error('expected a channel');

    await resolution.gateway.requestApproval(
      {
        approvalId: '01A',
        sessionId: '01S',
        toolName: 'write_file',
        serverName: 'fs',
        argsPreview: '{}',
        reasons: [],
        timeoutMs: 1_000,
      },
      new AbortController().signal,
    );

    expect(calls).toEqual(['https://example.internal/approvals']);
  });

  it('never writes the secret to a diagnostic line', async () => {
    await resolve(WEBHOOK, { AF_SECRET: 'shhh' });

    expect(sink.text).toContain('AF_SECRET');
    expect(sink.text).not.toContain('shhh');
    expect(stderr.text).not.toContain('shhh');
  });

  it('warns and goes quiet when the named variable is not set', async () => {
    const resolution = await resolve(WEBHOOK, {});

    expect(resolution.kind).toBe('off');
    expect(stderr.text).toContain('webhook approval channel could not be opened');
    expect(stderr.text).toContain('AF_SECRET');
    expect(stderr.text).toContain('meant to be committed');
  });

  it('warns and goes quiet when the variable is set to nothing', async () => {
    expect((await resolve(WEBHOOK, { AF_SECRET: '' })).kind).toBe('off');
  });

  it('warns and goes quiet when the block itself is missing', async () => {
    const resolution = await resolve(`${ASKS}approvals:\n  gateways: [webhook]\n`, {});

    expect(resolution.kind).toBe('off');
    expect(stderr.text).toContain('there is no approvals.webhook block');
    expect(stderr.text).toContain('secret_env');
  });

  it('warns about an endpoint that is not https, and uses it anyway', async () => {
    const resolution = await resolve(
      `${ASKS}approvals:\n  gateways: [webhook]\n  webhook:\n    url: http://example.internal/approvals\n    secret_env: AF_SECRET\n`,
      { AF_SECRET: 'shhh' },
    );

    expect(resolution.kind).toBe('ready');
    expect(stderr.text).toContain('is not https');
    expect(stderr.text).toContain('anybody on the path can approve a call');
  });

  it('says nothing about a loopback endpoint, where there is no path to be on', async () => {
    const resolution = await resolve(
      `${ASKS}approvals:\n  gateways: [webhook]\n  webhook:\n    url: http://127.0.0.1:9000/approvals\n    secret_env: AF_SECRET\n`,
      { AF_SECRET: 'shhh' },
    );

    expect(resolution.kind).toBe('ready');
    expect(stderr.text).not.toContain('is not https');
  });
});

describe('both channels', () => {
  const BOTH = `${ASKS}approvals:\n  gateways: [cli, webhook]\n  webhook:\n    url: https://example.internal/approvals\n    secret_env: AF_SECRET\n`;

  it('composes them, in the order the policy listed them', async () => {
    const resolution = await resolve(BOTH, {
      AF_SECRET: 'shhh',
      [SOCKET_ENV_VAR]: join(root, 'a.sock'),
    });

    expect(resolution.kind === 'ready' && resolution.sources).toEqual(['cli', 'webhook']);
    expect(resolution.kind === 'ready' && resolution.gateway).toBeInstanceOf(
      CompositeApprovalGateway,
    );
  });

  it('keeps the working one when the other cannot be opened', async () => {
    // A broken webhook must not take the terminal prompt down with it.
    const resolution = await resolve(BOTH, { [SOCKET_ENV_VAR]: join(root, 'a.sock') });

    expect(resolution.kind === 'ready' && resolution.sources).toEqual(['cli']);
    expect(stderr.text).toContain('webhook approval channel could not be opened');
  });

  it('closes the socket when the whole resolution is closed', async () => {
    const socket = join(root, 'a.sock');
    const resolution = await resolve(BOTH, { AF_SECRET: 'shhh', [SOCKET_ENV_VAR]: socket });
    expect(existsSync(socket)).toBe(true);

    if (resolution.kind === 'ready') await resolution.close();

    expect(existsSync(socket)).toBe(false);
  });
});

describe('the fail-open warning', () => {
  it('is written whenever on_timeout is allow', async () => {
    await resolve(`${ASKS}approvals:\n  on_timeout: allow\n  timeout: 30s\n`, {
      [SOCKET_ENV_VAR]: join(root, 'a.sock'),
    });

    expect(stderr.text).toContain('fail OPEN');
    expect(stderr.text).toContain('30000ms');
    expect(stderr.text).toContain('not recommended');
  });

  it('is not written for the default, which denies', async () => {
    await resolve(ASKS, { [SOCKET_ENV_VAR]: join(root, 'a.sock') });

    expect(stderr.text).not.toContain('fail OPEN');
  });

  it('is not written when nobody would ever be asked', async () => {
    await resolve(
      'version: 1\nmode: warn\napprovals:\n  on_timeout: allow\ntools:\n  - match: "*"\n    action: require_approval\n',
      { [SOCKET_ENV_VAR]: join(root, 'a.sock') },
    );

    expect(stderr.text).toBe('');
  });
});
