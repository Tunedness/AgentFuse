import { DIAGNOSTIC_PREFIX } from '@agentfuse/proxy';
import { describe, expect, it } from 'vitest';
import { StringWriter, writeLine, writeLines, writeNotice } from './io.js';

describe('StringWriter', () => {
  it('accumulates chunks and splits them back into non-empty lines', () => {
    const out = new StringWriter();

    writeLine(out, 'one');
    writeLine(out);
    writeLines(out, ['two', 'three']);

    expect(out.text).toBe('one\n\ntwo\nthree\n');
    expect(out.lines).toEqual(['one', 'two', 'three']);
  });

  it('reports a successful write, like a real stream', () => {
    expect(new StringWriter().write('x')).toBe(true);
  });

  it('clears', () => {
    const out = new StringWriter();
    out.write('gone');
    out.clear();

    expect(out.text).toBe('');
  });
});

describe('writeLines', () => {
  it('writes nothing at all for an empty list', () => {
    const out = new StringWriter();

    writeLines(out, []);

    // Not even a bare newline: a command with nothing to say says nothing.
    expect(out.text).toBe('');
  });

  it('emits exactly one trailing newline', () => {
    const out = new StringWriter();

    writeLines(out, ['a', 'b']);

    expect(out.text).toBe('a\nb\n');
  });
});

describe('writeNotice', () => {
  it('prefixes the headline and indents the rest under the same prefix', () => {
    const out = new StringWriter();

    writeNotice(out, 'warning', ['the thing is missing', 'install it', 'or turn it off']);

    expect(out.text).toBe(
      `${DIAGNOSTIC_PREFIX} warning: the thing is missing\n` +
        `${DIAGNOSTIC_PREFIX}   install it\n` +
        `${DIAGNOSTIC_PREFIX}   or turn it off\n`,
    );
  });

  it('marks every line with the prefix, so a wrapped server`s stderr stays distinguishable', () => {
    const out = new StringWriter();

    writeNotice(out, 'note', ['one', 'two']);

    expect(out.lines.every((line) => line.startsWith(DIAGNOSTIC_PREFIX))).toBe(true);
  });

  it('writes nothing for an empty notice', () => {
    const out = new StringWriter();

    writeNotice(out, 'warning', []);

    expect(out.text).toBe('');
  });
});
