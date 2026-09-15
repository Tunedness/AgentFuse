import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalAnswer } from '@agentfuse/core';
import { Diagnostics } from '@agentfuse/proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliApprovalGateway } from '../approvals/cli-gateway.js';
import { SOCKET_ENV_VAR } from '../approvals/protocol.js';
import { EXIT } from '../errors.js';
import { type CliContext, StringWriter } from '../io.js';
import { approveHelp, denyHelp, runApprove, runDeny } from './approve.js';

/**
 * The client half, driven against a real gateway listening on a real socket.
 *
 * What is being tested is the command surface: which flags are insisted on,
 * what the exit code says, and that the answer the wrap sends is what gets
 * printed. The socket mechanics belong to `approvals/socket.test.ts` and the
 * genuinely-two-process version to `approve-process.test.ts`.
 */

let root: string;
let stdout: StringWriter;
let stderr: StringWriter;
let socketPath: string;
const open: CliApprovalGateway[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-approve-'));
  socketPath = join(root, 'a.sock');
  stdout = new StringWriter();
  stderr = new StringWriter();
});

afterEach(async () => {
  for (const gateway of open.splice(0)) await gateway.close();
  rmSync(root, { recursive: true, force: true });
});

function context(env: Readonly<Record<string, string>> = {}): CliContext {
  return { argv: [], stdout, stderr, env, cwd: root };
}

/** A waiting wrap: one pending approval, one bound host. */
async function waitingWrap(): Promise<{
  readonly gateway: CliApprovalGateway;
  readonly verdict: Promise<ApprovalAnswer>;
  readonly resets: string[];
}> {
  const gateway = await CliApprovalGateway.open({
    path: socketPath,
    stderr: new StringWriter(),
    diagnostics: new Diagnostics({ quiet: true }),
  });
  open.push(gateway);
  const resets: string[] = [];
  gateway.bindHost({
    resetBreaker: (sessionId) => {
      resets.push(sessionId);
      return sessionId === '01SESSION' ? 'closed' : undefined;
    },
  });
  const verdict = gateway.requestApproval(
    {
      approvalId: '01APPROVAL',
      sessionId: '01SESSION',
      toolName: 'write_file',
      serverName: 'fs',
      argsPreview: '{}',
      reasons: [{ code: 'POLICY_APPROVAL', message: 'needs a human' }],
      timeoutMs: 10_000,
    },
    new AbortController().signal,
  );
  return { gateway, verdict, resets };
}

describe('the help', () => {
  it.each([
    ['approve', approveHelp()],
    ['deny', denyHelp()],
  ])('%s explains itself in one screen', (name, lines) => {
    expect(lines[0]).toContain(`agentfuse ${name}`);
    expect(lines.join('\n')).toContain('--reason');
    expect(lines.length).toBeLessThan(30);
  });

  it('says on approve that an unanswered approval is denied, and that allow fails open', () => {
    // The one setting in the policy file that makes AgentFuse fail open has to
    // say so where somebody configuring approvals will read it.
    const text = approveHelp().join('\n');

    expect(text).toContain('on_timeout: allow');
    expect(text).toContain('fail OPEN');
    expect(text).toContain('not recommended');
  });

  it.each([
    ['approve', runApprove],
    ['deny', runDeny],
  ])('%s --help is a success and writes to stdout', async (_name, run) => {
    expect(await run(context(), ['--help'])).toBe(EXIT.ok);
    expect(stdout.lines.length).toBeGreaterThan(5);
  });
});

describe('what the commands insist on', () => {
  it.each([
    ['approve', runApprove, ['01APPROVAL']],
    ['deny', runDeny, ['01APPROVAL']],
  ])('%s refuses to run without --reason', async (name, run, argv) => {
    await expect(run(context(), argv)).rejects.toThrow(`${name} needs --reason`);
  });

  it.each([
    ['approve', runApprove],
    ['deny', runDeny],
  ])('%s refuses a blank --reason', async (_name, run) => {
    await expect(run(context(), ['01A', '--reason', '   '])).rejects.toThrow('needs --reason');
  });

  it.each([
    ['approve', runApprove],
    ['deny', runDeny],
  ])('%s needs an approval id', async (name, run) => {
    await expect(run(context(), ['--reason', 'why'])).rejects.toThrow(
      `${name} needs an approval id`,
    );
  });

  it('approve --reset needs a session', async () => {
    await expect(runApprove(context(), ['--reset', '--reason', 'why'])).rejects.toThrow(
      'needs --session',
    );
  });

  it('does not let deny reset a breaker', async () => {
    // Resetting is an act of permission. `deny --reset` must not quietly mean
    // something, so the flag is simply not there.
    await expect(runDeny(context(), ['--reset', '--reason', 'why'])).rejects.toThrow(
      'unknown flag --reset',
    );
  });
});

describe('a verdict delivered over the socket', () => {
  it('approves, prints what happened and exits 0', async () => {
    const wrap = await waitingWrap();

    const code = await runApprove(context(), [
      '01APPROVAL',
      '--reason',
      'checked it',
      '--socket',
      socketPath,
    ]);

    expect(code).toBe(EXIT.ok);
    expect(stdout.text).toContain('Approved write_file on fs');
    // ADR-009: the words go back to the engine with the verdict, so the trip
    // report can say why the call was allowed.
    await expect(wrap.verdict).resolves.toEqual({ verdict: 'approved', reason: 'checked it' });
  });

  it('denies the same way', async () => {
    const wrap = await waitingWrap();

    const code = await runDeny(context(), [
      '01APPROVAL',
      '-r',
      'wrong path',
      '--socket',
      socketPath,
    ]);

    expect(code).toBe(EXIT.ok);
    expect(stdout.text).toContain('Denied write_file on fs');
    await expect(wrap.verdict).resolves.toEqual({ verdict: 'denied', reason: 'wrong path' });
  });

  it('finds the socket through the environment, which is how it usually works', async () => {
    const wrap = await waitingWrap();

    const code = await runApprove(context({ [SOCKET_ENV_VAR]: socketPath }), [
      '01APPROVAL',
      '--reason',
      'why',
    ]);

    expect(code).toBe(EXIT.ok);
    await expect(wrap.verdict).resolves.toMatchObject({ verdict: 'approved' });
  });

  it('exits 2 and says so when the wrap does not know that id', async () => {
    const wrap = await waitingWrap();

    const code = await runApprove(context(), ['01NOPE', '--reason', 'why', '--socket', socketPath]);

    expect(code).toBe(EXIT.usage);
    expect(stdout.text).toContain('no call is waiting for approval 01NOPE');

    await runDeny(context(), ['01APPROVAL', '--reason', 'tidy up', '--socket', socketPath]);
    await wrap.verdict;
  });

  it('says nothing is waiting when there is no socket at all', async () => {
    await expect(
      runApprove(context(), ['01A', '--reason', 'why', '--socket', join(root, 'nothing.sock')]),
    ).rejects.toThrow('nothing is waiting for an approval');
  });

  it('refuses a relative socket from the environment rather than guessing', async () => {
    await expect(
      runApprove(context({ [SOCKET_ENV_VAR]: 'relative.sock' }), ['01A', '--reason', 'why']),
    ).rejects.toThrow('must be an absolute path');
  });
});

describe('approve --reset', () => {
  it('closes the breaker and says which phase it is in now', async () => {
    const wrap = await waitingWrap();

    const code = await runApprove(context(), [
      '--reset',
      '--session',
      '01SESSION',
      '--reason',
      'read the report',
      '--socket',
      socketPath,
    ]);

    expect(code).toBe(EXIT.ok);
    expect(stdout.text).toContain('Reset the breaker for session 01SESSION.');
    expect(stdout.text).toContain('The breaker is now closed.');
    expect(wrap.resets).toEqual(['01SESSION']);

    await runDeny(context(), ['01APPROVAL', '--reason', 'tidy up', '--socket', socketPath]);
    await wrap.verdict;
  });

  it('exits 2 for a session the wrap has never had', async () => {
    const wrap = await waitingWrap();

    const code = await runApprove(context(), [
      '--reset',
      '-s',
      '01OTHER',
      '-r',
      'why',
      '--socket',
      socketPath,
    ]);

    expect(code).toBe(EXIT.usage);
    expect(stdout.text).toContain('no session 01OTHER');

    await runDeny(context(), ['01APPROVAL', '--reason', 'tidy up', '--socket', socketPath]);
    await wrap.verdict;
  });
});
