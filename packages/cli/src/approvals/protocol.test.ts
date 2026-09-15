import { describe, expect, it } from 'vitest';
import type { CliError } from '../errors.js';
import {
  APPROVAL_PROTOCOL_VERSION,
  encodeFrame,
  MAX_ID_LENGTH,
  MAX_REASON_LENGTH,
  parseCommandFrame,
  parseReplyFrame,
  resolveApprovalSocketPath,
  SOCKET_ENV_VAR,
} from './protocol.js';

/**
 * The frames arrive on a socket whose only known correspondent is a version of
 * AgentFuse this one has never met, and answering one of them releases a tool
 * call a policy stopped. So the parser is tested the way an untrusted parser
 * has to be: with the things a client actually sends wrong, and with the things
 * a hostile client would send on purpose.
 */

const ok = {
  v: APPROVAL_PROTOCOL_VERSION,
  type: 'verdict',
  approvalId: '01J',
  verdict: 'approved',
  reason: 'fine',
};

function refusal(line: string): string {
  const parsed = parseCommandFrame(line);
  if (parsed.ok) throw new Error(`expected ${line} to be refused`);
  return parsed.error;
}

describe('parseCommandFrame', () => {
  it('reads a verdict', () => {
    const parsed = parseCommandFrame(JSON.stringify(ok));

    expect(parsed).toEqual({
      ok: true,
      frame: {
        v: 1,
        type: 'verdict',
        approvalId: '01J',
        verdict: 'approved',
        reason: 'fine',
      },
    });
  });

  it('reads a reset', () => {
    const parsed = parseCommandFrame(
      JSON.stringify({ v: 1, type: 'reset', sessionId: '01S', reason: 'looked at it' }),
    );

    expect(parsed).toEqual({
      ok: true,
      frame: { v: 1, type: 'reset', sessionId: '01S', reason: 'looked at it' },
    });
  });

  it('keeps only the fields it declares, so an unknown one cannot ride along', () => {
    const parsed = parseCommandFrame(JSON.stringify({ ...ok, sudo: true, verdict: 'denied' }));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.frame).toEqual({
      v: 1,
      type: 'verdict',
      approvalId: '01J',
      verdict: 'denied',
      reason: 'fine',
    });
  });

  it.each([
    ['not JSON at all', 'hello', 'not JSON'],
    ['a JSON array', '[1,2,3]', 'not a JSON object'],
    ['a JSON string', '"verdict"', 'not a JSON object'],
    ['null', 'null', 'not a JSON object'],
    ['no version', JSON.stringify({ type: 'verdict' }), 'unsupported frame version'],
    ['a future version', JSON.stringify({ ...ok, v: 2 }), 'unsupported frame version'],
    [
      'an unknown command',
      JSON.stringify({ v: 1, type: 'shutdown', reason: '' }),
      'unknown command',
    ],
    ['no command', JSON.stringify({ v: 1, reason: '' }), 'unknown command'],
    ['a non-string reason', JSON.stringify({ ...ok, reason: 7 }), 'reason must be a string'],
    [
      'no approval id',
      JSON.stringify({ v: 1, type: 'verdict', verdict: 'approved', reason: '' }),
      'approvalId must be a non-empty string',
    ],
    [
      'an empty approval id',
      JSON.stringify({ ...ok, approvalId: '' }),
      'approvalId must be a non-empty string',
    ],
    ['a made-up verdict', JSON.stringify({ ...ok, verdict: 'maybe' }), 'verdict must be'],
    [
      'no session id on a reset',
      JSON.stringify({ v: 1, type: 'reset', reason: '' }),
      'sessionId must be a non-empty string',
    ],
  ])('refuses %s', (_label, line, expected) => {
    expect(refusal(line)).toContain(expected);
  });

  it('refuses an implausibly long id', () => {
    expect(refusal(JSON.stringify({ ...ok, approvalId: 'x'.repeat(MAX_ID_LENGTH + 1) }))).toContain(
      'implausibly long',
    );
  });

  it('refuses a reason longer than a reason', () => {
    expect(refusal(JSON.stringify({ ...ok, reason: 'x'.repeat(MAX_REASON_LENGTH + 1) }))).toContain(
      'too long',
    );
  });

  it('round-trips through encodeFrame, newline and all', () => {
    const line = encodeFrame({ v: 1, type: 'reset', sessionId: '01S', reason: 'why' });

    expect(line.endsWith('\n')).toBe(true);
    expect(parseCommandFrame(line.trimEnd())).toEqual({
      ok: true,
      frame: { v: 1, type: 'reset', sessionId: '01S', reason: 'why' },
    });
  });
});

describe('parseReplyFrame', () => {
  it('reads an answer, with the phase when there is one', () => {
    expect(
      parseReplyFrame(JSON.stringify({ v: 1, ok: true, message: 'done', phase: 'closed' })),
    ).toEqual({ ok: true, frame: { v: 1, ok: true, message: 'done', phase: 'closed' } });
  });

  it('tolerates a missing message, because a reply is not where to be strict', () => {
    expect(parseReplyFrame(JSON.stringify({ v: 1, ok: false }))).toEqual({
      ok: true,
      frame: { v: 1, ok: false, message: '' },
    });
  });

  it.each([
    ['not JSON', 'oops', 'not JSON'],
    ['not an object', '42', 'not a JSON object'],
    ['a version this build does not speak', JSON.stringify({ v: 9, ok: true }), 'frame version'],
    ['a non-boolean ok', JSON.stringify({ v: 1, ok: 'yes' }), 'ok must be a boolean'],
  ])('refuses %s', (_label, line, expected) => {
    const parsed = parseReplyFrame(line);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(expected);
  });
});

describe('resolveApprovalSocketPath', () => {
  it('takes AGENTFUSE_APPROVAL_SOCKET as an instruction', () => {
    const choice = resolveApprovalSocketPath({ [SOCKET_ENV_VAR]: '/tmp/af/x.sock' }, '77');

    expect(choice).toEqual({
      path: '/tmp/af/x.sock',
      origin: 'env',
      fallback: '/tmp/af/x-77.sock',
    });
  });

  it('prefers XDG_RUNTIME_DIR, which is where a unix socket belongs on Linux', () => {
    const choice = resolveApprovalSocketPath(
      { XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/a' },
      '77',
    );

    expect(choice.path).toBe('/run/user/1000/agentfuse/approvals.sock');
    expect(choice.origin).toBe('xdg');
  });

  it('falls back to $HOME, which is what macOS gets', () => {
    const choice = resolveApprovalSocketPath({ HOME: '/Users/a' }, '77');

    expect(choice.path).toBe('/Users/a/.agentfuse/approvals.sock');
    expect(choice.origin).toBe('home');
    expect(choice.fallback).toBe('/Users/a/.agentfuse/approvals-77.sock');
  });

  it('reads USERPROFILE when HOME is not the one that is set', () => {
    expect(resolveApprovalSocketPath({ USERPROFILE: '/Users/b' }, '1').origin).toBe('home');
  });

  it.each([
    ['a relative override', { [SOCKET_ENV_VAR]: 'sock' }, 'must be an absolute path'],
    ['nothing to go on', {}, 'cannot work out where'],
    ['a relative HOME', { HOME: 'home' }, 'cannot work out where'],
    ['an empty HOME', { HOME: '' }, 'cannot work out where'],
  ])('refuses %s', (_label, env, expected) => {
    expect(() => resolveApprovalSocketPath(env, '1')).toThrow(expected);
  });

  it('refuses a path longer than sun_path, which bind reports as EINVAL', () => {
    // The kernel does not truncate a socket path, it refuses it — with an error
    // that says nothing about paths. Naming the limit and the variable that
    // fixes it is the whole value of this check.
    const long = `/${'d'.repeat(120)}/x.sock`;

    try {
      resolveApprovalSocketPath({ [SOCKET_ENV_VAR]: long }, '1');
      expect.unreachable('a path that long must be refused');
    } catch (error) {
      const cli = error as CliError;
      expect(cli.message).toContain('too long');
      expect(cli.hints.join(' ')).toContain(SOCKET_ENV_VAR);
    }
  });

  it('gives a fallback even to an override with no .sock suffix', () => {
    expect(resolveApprovalSocketPath({ [SOCKET_ENV_VAR]: '/tmp/af/pipe' }, '77').fallback).toBe(
      '/tmp/af/pipe.77',
    );
  });
});
