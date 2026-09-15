import { describe, expect, it } from 'vitest';
import { sanitizeFreeText } from './text.js';

/**
 * The sanitiser for text a person wrote.
 *
 * Its caller is the approval reason, which is typed by a human into a terminal
 * or written by a remote webhook endpoint, and then stored in a JSON report,
 * printed into a ruled table and read back by somebody else's terminal. Every
 * case below is one of those readers being protected.
 */

const LIMIT = 40;

/** `ESC`, spelled out so the source stays readable and greppable. */
const ESC = '\u001B';

describe('sanitizeFreeText', () => {
  it('keeps ordinary prose exactly as written', () => {
    expect(sanitizeFreeText('checked the path by hand', LIMIT)).toBe('checked the path by hand');
  });

  it('keeps non-ASCII, including emoji', () => {
    // Paired surrogates are a whole character; only unpaired ones are removed.
    expect(sanitizeFreeText('über · 日本語 · 👍', LIMIT)).toBe('über · 日本語 · 👍');
  });

  it('turns newlines, tabs and carriage returns into single spaces', () => {
    // A newline would break the report's ruled table apart and a `\r` would
    // overwrite the line a reader just saw.
    expect(sanitizeFreeText('one\ntwo\r\nthree\tfour', LIMIT)).toBe('one two three four');
  });

  it('removes ANSI escape sequences whole, not just the escape byte', () => {
    // Stripping only the ESC would leave `[31m` behind as literal text.
    expect(sanitizeFreeText(`${ESC}[31mred${ESC}[0m and ${ESC}]0;title\u0007bell`, LIMIT)).toBe(
      'red and bell',
    );
  });

  it('removes C0 and C1 controls, including NUL and DEL', () => {
    expect(sanitizeFreeText('a\u0000b\u0008c\u007Fd\u009Fe', LIMIT)).toBe('a b c d e');
  });

  it('removes the line and paragraph separators', () => {
    // Not `\n`, but a newline to anything that renders Unicode properly.
    expect(sanitizeFreeText('a\u2028b\u2029c', LIMIT)).toBe('a b c');
  });

  it('removes a lone surrogate, which is half a character', () => {
    expect(sanitizeFreeText('a\uD800b', LIMIT)).toBe('ab');
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(sanitizeFreeText('   a     b   ', LIMIT)).toBe('a b');
  });

  it('caps the length and says so with an ellipsis', () => {
    const capped = sanitizeFreeText('x'.repeat(500), LIMIT);

    expect(capped).toHaveLength(LIMIT);
    expect(capped?.endsWith('…')).toBe(true);
  });

  it('caps after the removals, so escape sequences cannot spend the budget', () => {
    const noisy = `${`${ESC}[31m`.repeat(50)}short`;

    expect(sanitizeFreeText(noisy, LIMIT)).toBe('short');
  });

  it('is undefined for anything that is not a string', () => {
    // A gateway that hands back a number or an object cannot put it in a report.
    expect(sanitizeFreeText(undefined, LIMIT)).toBeUndefined();
    expect(sanitizeFreeText(7, LIMIT)).toBeUndefined();
    expect(sanitizeFreeText({ reason: 'nice try' }, LIMIT)).toBeUndefined();
    expect(sanitizeFreeText(null, LIMIT)).toBeUndefined();
  });

  it('is undefined for text that was only whitespace or only controls', () => {
    // An empty reason field says less than no field at all.
    expect(sanitizeFreeText('', LIMIT)).toBeUndefined();
    expect(sanitizeFreeText('   \n\t ', LIMIT)).toBeUndefined();
    expect(sanitizeFreeText(`${ESC}[2J${ESC}[H`, LIMIT)).toBeUndefined();
  });

  it('survives a zero limit without producing a negative slice', () => {
    expect(sanitizeFreeText('anything', 0)).toBe('…');
  });

  it('leaves the result serialisable and free of anything a terminal obeys', () => {
    const hostile = `${ESC}[2Jwiped\r\n\u0000${`${ESC}[31m`.repeat(20)} ${'y'.repeat(200)}`;
    const cleaned = sanitizeFreeText(hostile, LIMIT) ?? '';

    expect(JSON.parse(JSON.stringify({ reason: cleaned })).reason).toBe(cleaned);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(cleaned)).toBe(false);
    expect(cleaned.length).toBeLessThanOrEqual(LIMIT);
  });
});
