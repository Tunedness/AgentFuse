import { createHash } from 'node:crypto';

/**
 * Hex-encoded SHA-256.
 *
 * `node:crypto` is the one Node builtin `@agentfuse/core` imports. It performs
 * no I/O and reads no ambient state, so it does not compromise the purity
 * invariant that the rest of the package is built on.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
