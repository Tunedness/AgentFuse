import { describe, expect, it } from 'vitest';
import { CliError, EXIT, formatCliError } from './errors.js';

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
