/**
 * Free text written by a human, made safe to keep.
 *
 * The one caller today is the approval reason (ADR-009), and the journey that
 * text takes is why this exists: a person types it into a terminal, it crosses
 * a unix socket or an HTTP response, and it ends up in a JSON report file, on
 * somebody else's terminal when they run `agentfuse report`, and inside a
 * rendered table of fixed width. Untrusted is the only sane reading — the
 * webhook channel's half of it is written by a remote endpoint, not by the
 * operator at all.
 *
 * What is removed, and why each one:
 *
 * - **C0 and C1 control characters, including newlines and tabs.** A newline
 *   breaks the report's ruled table apart; `\r` overwrites the line a reader
 *   just saw; `\b` deletes it. They become spaces rather than nothing, so two
 *   words never fuse into one.
 * - **ANSI escape sequences.** `ESC` is a control character and would be
 *   removed by the rule above, but the bytes *after* it would then be printed
 *   as literal `[31m`. The whole sequence goes instead.
 * - **Lone surrogates.** `JSON.stringify` escapes them rather than failing, so
 *   the file stays valid JSON either way; they are dropped because a reader
 *   gains nothing from half a character. Paired surrogates — every emoji — are
 *   untouched: with the `u` flag `\p{Cs}` matches only the unpaired ones.
 * - **Runs of whitespace**, collapsed to one space, and the ends trimmed.
 *
 * Length is capped last, after the removals, so a string of escape sequences
 * cannot spend the budget. An empty result is `undefined`: a record with an
 * empty reason field says less than a record with no field at all.
 */

/**
 * ANSI/VT sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL`) and the
 * two-character escapes. Matched before {@link CONTROL} removes the `ESC`
 * itself, which would otherwise leave `[31m` behind as literal text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/** C0 and C1 control characters, and the Unicode line/paragraph separators. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * Sanitises one piece of human-written text.
 *
 * @param value anything; a non-string yields `undefined`, so a gateway that
 * hands back a number or an object cannot put it in a report.
 * @param limit maximum characters kept. A longer string is truncated with an
 * ellipsis, so a reader can tell that it was.
 */
export function sanitizeFreeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(ANSI, ' ')
    .replace(CONTROL, ' ')
    .replace(/\p{Cs}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return undefined;
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, Math.max(0, limit - 1))}…`;
}
