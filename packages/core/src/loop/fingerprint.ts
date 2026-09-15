import { sha256 } from '../util/hash.js';

/** NUL. Written as an escape because a raw NUL byte in source is unreadable. */
const SEPARATOR = '\u0000';

/**
 * A call's identity: `sha256(serverName \0 toolName \0 argsNormalized)`.
 *
 * NUL is the separator rather than a space because a server alias or a tool
 * name may legitimately contain spaces, and `("a b", "c")` must not collide
 * with `("a", "b c")`. NUL cannot appear in either.
 */
export function fingerprint(serverName: string, toolName: string, argsNormalized: string): string {
  return sha256([serverName, toolName, argsNormalized].join(SEPARATOR));
}

/** Enough of a fingerprint to identify it in a report, but not to fill a line. */
export function shortFingerprint(value: string): string {
  return value.slice(0, 12);
}

/** What `errorSignature` needs to know about a failure. */
export interface ErrorInput {
  /** A structured error code, when the upstream supplied one. */
  code?: string | number | undefined;
  /** The error text. */
  text?: string | undefined;
}

const ABS_PATH_RE = /(?:[A-Za-z]:)?(?:[/\\][\w.@+-]+){2,}[/\\]?/g;
const HEX_RUN_RE = /(?<![0-9A-Za-z])[0-9a-fA-F]{8,}(?![0-9A-Za-z])/g;
const NUMBER_RE = /\d+/g;

/**
 * Stable identity for a failure.
 *
 * A structured code wins when there is one. Otherwise the first line of the
 * message is masked hard: `file not found: /tmp/a1b2` and
 * `file not found: /tmp/c3d4` have to produce the same signature, or the
 * error-repeat rule will never see an agent retrying the same broken thing with
 * a slightly different temp path.
 *
 * Only the first line is used — stack traces differ between attempts and would
 * defeat the whole exercise.
 */
export function errorSignature(input: ErrorInput): string {
  if (input.code !== undefined && input.code !== '') return `code:${input.code}`;
  const firstLine = (input.text ?? '').split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return 'unknown_error';
  // Paths first: they contain digits, and masking digits first would destroy
  // the path shape the path mask is looking for.
  return firstLine
    .replace(ABS_PATH_RE, '«path»')
    .replace(HEX_RUN_RE, '«hex»')
    .replace(NUMBER_RE, '«n»')
    .slice(0, 200);
}
