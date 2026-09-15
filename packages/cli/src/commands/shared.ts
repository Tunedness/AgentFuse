/**
 * Flag plumbing shared by the commands that load a policy.
 *
 * Small, but worth being one place: `--mode` is validated against the same list
 * the schema uses, and a typo there must not silently leave the policy's own
 * mode in force. A flag that looks like it worked and did nothing is the worst
 * kind for a tool whose job is enforcement.
 */

import type { PolicyMode } from '@agentfuse/core';
import { CliError } from '../errors.js';

/** The accepted `--mode` values. */
export const MODE_VALUES: readonly PolicyMode[] = ['warn', 'enforce'];

/**
 * Validates a `--mode` value.
 *
 * @throws {CliError} for anything not in {@link MODE_VALUES}.
 */
export function asMode(value: string | undefined): PolicyMode | undefined {
  if (value === undefined) return undefined;
  if ((MODE_VALUES as readonly string[]).includes(value)) return value as PolicyMode;
  throw new CliError(`--mode must be one of ${MODE_VALUES.join(', ')}, not ${value}`, {
    hints: [
      '`warn` observes and reports; `enforce` breaks the circuit.',
      'Omit the flag to use the mode in the policy file.',
    ],
  });
}
