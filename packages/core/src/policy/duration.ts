/**
 * Human durations.
 *
 * A policy is written by a person under time pressure, so `30m` has to work.
 * A bare number is accepted too and means milliseconds — that is the form a
 * generated policy or a test fixture will use.
 */

/** `30m`, `120s`, `2m`, `1h`, `500ms`, `7d`. No compound forms. */
export const DURATION_PATTERN = '^[0-9]+(ms|s|m|h|d)$';

const DURATION_RE = new RegExp(DURATION_PATTERN);

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/** Message shown when a duration will not parse. Shared with the Zod schema. */
export const DURATION_MESSAGE =
  'expected a duration like "500ms", "120s", "30m", "1h" or "7d", or a non-negative number of milliseconds';

/**
 * Parses a duration into milliseconds.
 *
 * @throws {RangeError} when the input is neither a valid duration string nor a
 * non-negative integer.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0) throw new RangeError(DURATION_MESSAGE);
    return input;
  }
  const match = DURATION_RE.exec(input.trim());
  if (!match) throw new RangeError(DURATION_MESSAGE);
  const unit = match[1] as keyof typeof UNIT_MS;
  return Number.parseInt(input, 10) * UNIT_MS[unit];
}

/** Renders milliseconds back into the most readable whole unit. */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0ms';
  for (const [unit, size] of [
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
    ['s', UNIT_MS.s],
  ] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
