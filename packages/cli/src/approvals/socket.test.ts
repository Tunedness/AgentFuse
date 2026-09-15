import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliError } from '../errors.js';
import { encodeFrame, MAX_FRAME_BYTES, SOCKET_ENV_VAR } from './protocol.js';
import {
  type ApprovalSocket,
  ensureSocketDir,
  listenApprovalSocket,
  prepareSocketPath,
  probeSocket,
  sendCommand,
} from './socket.js';

/**
 * The socket is what releases a blocked tool call, so the tests are about the
 * three properties in the module doc — mode 0600 inside 0700, nothing adopted
 * that we did not create, and a second wrap that does not steal the first
 * one's path — plus the one operational property that matters more than any of
 * them: a malformed frame must cost the agent nothing.
 *
 * Real sockets, in a real temporary directory. There is nothing to learn from a
 * mock of `bind`: every claim here is a claim about what the kernel did.
 */

let root: string;
const open: ApprovalSocket[] = [];
const events: Array<[string, Record<string, unknown>]> = [];

beforeEach(() => {
  // Short prefix on purpose: a socket path has about a hundred bytes to live in
  // and macOS's tmpdir already spends fifty.
  root = mkdtempSync(join(tmpdir(), 'af-sock-'));
  events.length = 0;
});

afterEach(async () => {
  for (const socket of open.splice(0)) await socket.close();
  rmSync(root, { recursive: true, force: true });
});

/** A listener that answers every command with `ok`, remembering what it saw. */
async function listen(
  path: string,
  extra: { readonly fallback?: string } = {},
): Promise<{ socket: ApprovalSocket; seen: unknown[] }> {
  const seen: unknown[] = [];
  const socket = await listenApprovalSocket({
    path,
    ...extra,
    handle: (frame) => {
      seen.push(frame);
      return { v: 1, ok: true, message: 'noted' };
    },
    onEvent: (event, fields) => events.push([event, fields]),
  });
  open.push(socket);
  return { socket, seen };
}

/**
 * A plain listener, standing in for another wrap or a rude one.
 *
 * `stop()` destroys the accepted sockets before closing: `server.close()` waits
 * for every connection to end, so a test that closes while one is still open
 * hangs rather than failing.
 */
async function squat(
  path: string,
  onConnection: (socket: Socket) => void = () => undefined,
): Promise<() => Promise<void>> {
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => accepted.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return async () => {
    for (const socket of accepted) socket.destroy();
    accepted.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

/**
 * Leaves a socket file behind with nothing listening on it.
 *
 * A killed child process, because that is the only way to produce one: Node
 * unlinks the path on a clean `close()`, so a stale socket is by definition
 * what a process that never got to close leaves — which is exactly the case
 * `prepareSocketPath` has to recognise.
 */
async function staleSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("up"))',
      path,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', () => reject(new Error('the stale-socket helper exited')));
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe('the directory the socket lives in', () => {
  it('is created at mode 0700', () => {
    const dir = ensureSocketDir(join(root, 'nested', 'a.sock'), undefined);

    expect(dir).toBe(join(root, 'nested'));
    expect(mode(dir)).toBe('700');
  });

  it('is narrowed when it already exists too wide', () => {
    // The real case: `~/.agentfuse` created by an older version, or by a
    // `mkdir` whose mode the umask widened. The 0700 directory is what covers
    // the window between `bind` and `chmod`, so it is set every time rather
    // than hoped for.
    const dir = join(root, 'wide');
    mkdirSync(dir);
    chmodSync(dir, 0o777);

    ensureSocketDir(join(dir, 'a.sock'), undefined);

    expect(mode(dir)).toBe('700');
  });

  it('reports a directory it cannot create at all', () => {
    // A regular file where a directory has to go: `mkdir` fails with ENOTDIR,
    // and the operator gets the path and the variable that moves it rather than
    // a bare errno.
    writeFileSync(join(root, 'file'), '', 'utf8');

    try {
      ensureSocketDir(join(root, 'file', 'nested', 'a.sock'), undefined);
      expect.unreachable('a directory under a file cannot be created');
    } catch (error) {
      const cli = error as CliError;
      expect(cli.message).toContain('cannot prepare the approval socket directory');
      expect(cli.hints.join(' ')).toContain(SOCKET_ENV_VAR);
    }
  });

  it('refuses a directory that belongs to somebody else', () => {
    // The uid is injected precisely so this is testable: a test cannot own a
    // directory as another user, and "AgentFuse will not put this socket in a
    // directory it does not own" is the rule worth pinning.
    const ours = statSync(root).uid;

    try {
      ensureSocketDir(join(root, 'a.sock'), ours + 1);
      expect.unreachable('a foreign directory must be refused');
    } catch (error) {
      const cli = error as CliError;
      expect(cli.message).toContain('belongs to uid');
      expect(cli.hints.join(' ')).toContain(SOCKET_ENV_VAR);
    }
  });
});

describe('prepareSocketPath', () => {
  it('is ready when there is nothing there', async () => {
    expect(await prepareSocketPath(join(root, 'a.sock'), undefined)).toEqual({
      kind: 'ready',
      removedStale: false,
    });
  });

  it('removes a stale socket, because that is the ordinary state after a crash', async () => {
    const path = join(root, 'a.sock');
    await staleSocket(path);
    // The file survives a process that died without closing cleanly, and
    // refusing to work until the user runs `rm` would be the wrong answer to it.
    expect(statSync(path).isSocket()).toBe(true);

    expect(await prepareSocketPath(path, undefined)).toEqual({ kind: 'ready', removedStale: true });
  });

  it('refuses a socket somebody is listening on', async () => {
    const path = join(root, 'a.sock');
    const stop = await squat(path);
    try {
      expect(await prepareSocketPath(path, undefined)).toMatchObject({
        kind: 'refused',
        why: 'live',
      });
      // And it is still there: a live socket is never unlinked.
      expect(statSync(path).isSocket()).toBe(true);
    } finally {
      await stop();
    }
  });

  it('refuses a path that is not a socket, and leaves it alone', async () => {
    const path = join(root, 'a.sock');
    writeFileSync(path, 'not a socket', 'utf8');

    expect(await prepareSocketPath(path, undefined)).toMatchObject({
      kind: 'refused',
      why: 'not-a-socket',
    });
    expect(statSync(path).isFile()).toBe(true);
  });

  it('refuses a socket owned by another user without probing it', async () => {
    const path = join(root, 'a.sock');
    await staleSocket(path);

    const disposition = await prepareSocketPath(path, statSync(path).uid + 1, async () => {
      throw new Error('a foreign socket must not be probed');
    });

    expect(disposition).toMatchObject({ kind: 'refused', why: 'foreign' });
    expect(statSync(path).isSocket()).toBe(true);
  });

  it('treats an unprovable socket as live rather than deleting it', async () => {
    // A probe that neither connects nor is refused within the timeout cannot
    // prove the socket is dead, and "I could not tell" must not licence
    // unlinking somebody's channel.
    const path = join(root, 'a.sock');
    await staleSocket(path);

    expect(await prepareSocketPath(path, undefined, async () => true)).toMatchObject({
      kind: 'refused',
      why: 'live',
    });
  });

  it('reports a stale socket it is not allowed to remove', async () => {
    // Ours, dead, and in a directory we have taken the write bit off. Unlinking
    // is the one destructive thing this code does, so failing to do it has to
    // end in a refusal rather than in a bind over the top of it.
    const path = join(root, 'a.sock');
    await staleSocket(path);
    chmodSync(root, 0o500);
    try {
      expect(await prepareSocketPath(path, undefined)).toMatchObject({
        kind: 'refused',
        why: 'unreadable',
      });
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('reports a path it cannot even read', async () => {
    // A directory in the way: `lstat` succeeds, `isSocket` is false. The
    // unreadable branch is the one where `lstat` itself fails for a reason
    // other than absence, which a path under a directory that is not one does.
    writeFileSync(join(root, 'file'), '', 'utf8');

    expect(await prepareSocketPath(join(root, 'file', 'a.sock'), undefined)).toMatchObject({
      kind: 'refused',
      why: 'unreadable',
    });
  });
});

describe('probeSocket', () => {
  it('says no when there is nothing to connect to', async () => {
    expect(await probeSocket(join(root, 'nothing.sock'))).toBe(false);
  });

  it('says yes when something answers', async () => {
    const path = join(root, 'a.sock');
    const stop = await squat(path);
    try {
      expect(await probeSocket(path)).toBe(true);
    } finally {
      await stop();
    }
  });
});

describe('listenApprovalSocket', () => {
  it('binds the socket at mode 0600 inside a 0700 directory', async () => {
    const path = join(root, 'dir', 'a.sock');

    const { socket } = await listen(path);

    expect(socket.path).toBe(path);
    expect(mode(path)).toBe('600');
    expect(mode(join(root, 'dir'))).toBe('700');
  });

  it('delivers a frame and answers it', async () => {
    const path = join(root, 'a.sock');
    const { seen } = await listen(path);

    const reply = await sendCommand(path, {
      v: 1,
      type: 'verdict',
      approvalId: '01J',
      verdict: 'approved',
      reason: 'yes',
    });

    expect(reply).toEqual({ v: 1, ok: true, message: 'noted' });
    expect(seen).toEqual([
      { v: 1, type: 'verdict', approvalId: '01J', verdict: 'approved', reason: 'yes' },
    ]);
  });

  it('removes the socket file when it closes', async () => {
    const path = join(root, 'a.sock');
    const { socket } = await listen(path);

    await socket.close();
    open.length = 0;

    expect(await prepareSocketPath(path, undefined)).toEqual({
      kind: 'ready',
      removedStale: false,
    });
  });

  it('takes the fallback path rather than stealing a live socket', async () => {
    // Two wraps, one well-known path. The newcomer must not unlink a socket a
    // running process is waiting for verdicts on — it binds its own and prints
    // that path in its prompts instead.
    const path = join(root, 'a.sock');
    const fallback = join(root, 'a-2.sock');
    const first = await listen(path);

    const second = await listen(path, { fallback });

    expect(second.socket.path).toBe(fallback);
    expect(first.socket.path).toBe(path);
    expect(events.map(([event]) => event)).toContain('approval_socket_unavailable');

    // And the first one still works, which is the point.
    await expect(
      sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' }),
    ).resolves.toMatchObject({ ok: true });
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(0);
  });

  it('gives up loudly when no candidate can be bound', async () => {
    const path = join(root, 'a.sock');
    await listen(path);

    try {
      await listen(path);
      expect.unreachable('with no fallback there is nowhere to go');
    } catch (error) {
      const cli = error as CliError;
      expect(cli.message).toContain('cannot open the approval socket');
      expect(cli.hints.join('\n')).toContain('another AgentFuse is listening');
      expect(cli.hints.join('\n')).toContain(SOCKET_ENV_VAR);
    }
  });

  it('works without an event sink at all', async () => {
    const path = join(root, 'a.sock');
    // With a stale socket in the way, so the no-op sink is used and not merely
    // created: this is the path where a caller wants a listener and no log.
    await staleSocket(path);
    const socket = await listenApprovalSocket({
      path,
      handle: () => ({ v: 1, ok: true, message: 'noted' }),
    });
    open.push(socket);

    await expect(
      sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports a path the kernel will not bind, rather than throwing an errno', async () => {
    // Longer than `sun_path`. `resolveApprovalSocketPath` catches this before it
    // gets here, but the listener is a public function and the failure has to
    // arrive as a CliError either way.
    const path = join(root, `${'x'.repeat(200)}.sock`);

    try {
      await listen(path);
      expect.unreachable('the kernel refuses a path that long');
    } catch (error) {
      expect((error as CliError).message).toContain('cannot open the approval socket');
      expect(events.map(([event]) => event)).toContain('approval_socket_bind_failed');
      expect(events.map(([event]) => event)).toContain('approval_socket_error');
    }
  });

  it('reports a stale socket it removed, so the log says what happened', async () => {
    const path = join(root, 'a.sock');
    await staleSocket(path);

    await listen(path);

    expect(events.map(([event]) => event)).toContain('approval_socket_stale_removed');
  });
});

describe('a client that misbehaves', () => {
  /** Writes raw bytes and reads whatever comes back, bypassing the client. */
  async function raw(path: string, payload: string): Promise<string> {
    return await new Promise<string>((resolve) => {
      const socket = createConnection(path);
      let out = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(payload));
      socket.on('data', (chunk: string) => {
        out += chunk;
      });
      socket.on('close', () => resolve(out));
      socket.on('error', () => resolve(out));
    });
  }

  it('gets an error frame for a malformed one, and the listener lives on', async () => {
    const path = join(root, 'a.sock');
    const { seen } = await listen(path);

    const answer = await raw(path, 'this is not a frame\n');

    expect(answer).toContain('could not read that command');
    expect(seen).toHaveLength(0);
    // Still serving. This is the property that matters: the process this runs
    // in is proxying an agent's tool calls.
    await expect(
      sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses an oversized frame instead of buffering it', async () => {
    const path = join(root, 'a.sock');
    await listen(path);

    const answer = await raw(path, 'x'.repeat(MAX_FRAME_BYTES + 1));

    expect(answer).toContain('at most');
    expect(events.map(([event]) => event)).toContain('approval_socket_rejected');
  });

  it('ignores a second frame that arrives in its own packet', async () => {
    const path = join(root, 'a.sock');
    const { seen } = await listen(path);

    const socket = createConnection(path);
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    socket.write(encodeFrame({ v: 1, type: 'reset', sessionId: '01A', reason: 'x' }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    socket.write(encodeFrame({ v: 1, type: 'reset', sessionId: '01B', reason: 'x' }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    socket.destroy();

    expect(seen).toEqual([{ v: 1, type: 'reset', sessionId: '01A', reason: 'x' }]);
  });

  it('ignores everything after the first frame on one connection', async () => {
    const path = join(root, 'a.sock');
    const { seen } = await listen(path);

    await raw(
      path,
      encodeFrame({ v: 1, type: 'reset', sessionId: '01A', reason: 'x' }) +
        encodeFrame({ v: 1, type: 'reset', sessionId: '01B', reason: 'x' }),
    );

    expect(seen).toEqual([{ v: 1, type: 'reset', sessionId: '01A', reason: 'x' }]);
  });

  it('answers rather than crashing when the handler itself throws', async () => {
    const path = join(root, 'a.sock');
    const socket = await listenApprovalSocket({
      path,
      handle: () => {
        throw new Error('bug in AgentFuse');
      },
      onEvent: (event, fields) => events.push([event, fields]),
    });
    open.push(socket);

    const reply = await sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' });

    expect(reply.ok).toBe(false);
    expect(reply.message).toContain('failed while recording');
    expect(events.map(([event]) => event)).toContain('approval_socket_handler_failed');
  });

  it('drops a connection that says nothing', async () => {
    const path = join(root, 'a.sock');
    const socket = await listenApprovalSocket({
      path,
      handle: () => ({ v: 1, ok: true, message: 'noted' }),
      idleTimeoutMs: 30,
      onEvent: (event, fields) => events.push([event, fields]),
    });
    open.push(socket);

    // A local client that connects and holds the connection open would
    // otherwise keep a finished wrap alive.
    expect(await raw(path, '')).toBe('');
    expect(events.map(([event]) => event)).toContain('approval_socket_idle');
  });
});

describe('sendCommand', () => {
  it('says nothing is waiting when the socket is not there', async () => {
    try {
      await sendCommand(join(root, 'nothing.sock'), {
        v: 1,
        type: 'verdict',
        approvalId: '01J',
        verdict: 'approved',
        reason: 'x',
      });
      expect.unreachable('there is nothing to connect to');
    } catch (error) {
      const cli = error as CliError;
      expect(cli.message).toContain('nothing is waiting for an approval');
      expect(cli.hints.join(' ')).toContain('mode: enforce');
    }
  });

  it('reports a path that is not a socket at all', async () => {
    // Neither ENOENT nor ECONNREFUSED: a different error, and a different
    // sentence — "nothing is waiting here" would be a lie.
    const path = join(root, 'regular-file');
    writeFileSync(path, 'not a socket', 'utf8');

    try {
      await sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' });
      expect.unreachable('a regular file is not a socket');
    } catch (error) {
      const cli = error as CliError;
      expect(cli.message).toContain('cannot reach the approval socket');
      expect(cli.message).not.toContain('nothing is waiting');
    }
  });

  it('gives up on a listener that never answers', async () => {
    const path = join(root, 'a.sock');
    const stop = await squat(path);
    try {
      await expect(
        sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' }, 40),
      ).rejects.toThrow('did not answer');
    } finally {
      await stop();
    }
  });

  it('refuses an answer it cannot read', async () => {
    const path = join(root, 'a.sock');
    const stop = await squat(path, (socket) => socket.end('{"v":99}\n'));
    try {
      await expect(
        sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' }),
      ).rejects.toThrow('cannot read the answer');
    } finally {
      await stop();
    }
  });

  it('refuses an oversized answer', async () => {
    const path = join(root, 'a.sock');
    const stop = await squat(path, (socket) => socket.write('x'.repeat(MAX_FRAME_BYTES + 1)));
    try {
      await expect(
        sendCommand(path, { v: 1, type: 'reset', sessionId: '01S', reason: 'x' }),
      ).rejects.toThrow('oversized frame');
    } finally {
      await stop();
    }
  });
});
