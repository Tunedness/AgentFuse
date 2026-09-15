import { describe, expect, it } from 'vitest';
import { CliError, EXIT, formatCliError, messageOf } from './errors.js';

describe('CliError', () => {
  it('defaults to the usage exit code and no hints', () => {
    const error = new CliError('something is off');

    expect(error.name).toBe('CliError');
    expect(error.exitCode).toBe(EXIT.usage);
    expect(error.hints).toEqual([]);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries an exit code, hints and a cause', () => {
    const cause = new Error('underlying');
    const error = new CliError('no policy', {
      exitCode: EXIT.policy,
      hints: ['Run `agentfuse init`.'],
      cause,
    });

    expect(error.exitCode).toBe(EXIT.policy);
    expect(error.hints).toEqual(['Run `agentfuse init`.']);
    expect(error.cause).toBe(cause);
  });

  it('keeps `cause` absent rather than undefined when none was given', () => {
    // `exactOptionalPropertyTypes` is on, and an explicit `{ cause: undefined }`
    // would show up in `Object.keys`, which is how a "no cause" error starts
    // printing `cause: undefined` in somebody's debugger.
    expect('cause' in new CliError('x')).toBe(false);
  });

  it('gives every failure class a distinct exit code', () => {
    const codes = Object.values(EXIT);

    expect(new Set(codes).size).toBe(codes.length);
    expect(EXIT.ok).toBe(0);
  });
});

describe('messageOf', () => {
  it('takes the message of an Error', () => {
    expect(messageOf(new Error('disk full'))).toBe('disk full');
  });

  it('takes a thrown string as it is', () => {
    // A module whose top-level `throw 'x'` rejected a dynamic import.
    expect(messageOf('top-level throw')).toBe('top-level throw');
  });

  it('describes a thrown object instead of printing [object Object]', () => {
    expect(messageOf({ code: 'EACCES' })).toBe('{"code":"EACCES"}');
  });

  it('falls back to String for a value JSON cannot describe', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(messageOf(cyclic)).toBe('[object Object]');
  });

  it('handles the values JSON.stringify returns undefined for', () => {
    expect(messageOf(undefined)).toBe('undefined');
    expect(messageOf(() => 1)).toContain('=>');
  });

  it('keeps a subclass`s message', () => {
    expect(messageOf(new CliError('nope'))).toBe('nope');
  });
});

describe('formatCliError', () => {
  it('prefixes the message and indents the hints', () => {
    const text = formatCliError(
      new CliError('the --policy flag needs a value', {
        hints: ['For example: --policy ./fusepolicy.yaml', 'Or drop the flag.'],
      }),
    );

    expect(text).toBe(
      'agentfuse: the --policy flag needs a value\n' +
        '  For example: --policy ./fusepolicy.yaml\n' +
        '  Or drop the flag.\n',
    );
  });

  it('is one line when there are no hints', () => {
    expect(formatCliError(new CliError('nope'))).toBe('agentfuse: nope\n');
  });
});
