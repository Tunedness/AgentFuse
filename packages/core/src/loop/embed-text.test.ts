import { describe, expect, it } from 'vitest';
import type { CallOutcome, ToolCallRecord } from '../domain/records.js';
import { MAX_ARGS_CHARS, MAX_SUMMARY_CHARS, semanticEmbeddingText } from './embed-text.js';
import { normalizeArgs } from './normalize.js';

const NOW = 1_700_000_000_000;

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  const args = overrides.args ?? { path: '/etc/hosts' };
  return {
    id: 'call-1',
    sessionId: 's1',
    serverName: 'fs',
    toolName: 'read_file',
    args,
    argsNormalized: normalizeArgs(args, NOW),
    fingerprint: 'abc123',
    startedAt: NOW,
    ...overrides,
  };
}

const ok: CallOutcome = { isError: false, resultSummary: 'file contents', resultBytes: 13 };

describe('semanticEmbeddingText', () => {
  it('writes the tool, the normalized arguments and the result summary', () => {
    expect(semanticEmbeddingText(record({ outcome: ok }))).toBe(
      'fs__read_file\n{"path":"/etc/hosts"}\nresult: file contents',
    );
  });

  it('identifies the tool by server and name, as the fingerprint does', () => {
    // `read_file` on two different servers is not the same piece of work, and
    // the two must not collapse onto one point in embedding space.
    const a = semanticEmbeddingText(record({ serverName: 'fs', outcome: ok }));
    const b = semanticEmbeddingText(record({ serverName: 'sandbox', outcome: ok }));
    expect(a.startsWith('fs__read_file\n')).toBe(true);
    expect(b.startsWith('sandbox__read_file\n')).toBe(true);
  });

  it('reuses the arguments the hot path already normalized', () => {
    // Masking is not repeated here: the exact-repeat rule and the semantic rule
    // have to agree on what "the same call" looks like.
    const text = semanticEmbeddingText(
      record({ args: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }, outcome: ok }),
    );
    expect(text).toContain('«uuid»');
  });

  it('puts the error signature in front of a failed result', () => {
    const text = semanticEmbeddingText(
      record({
        outcome: {
          isError: true,
          errorSignature: 'code:ENOENT',
          resultSummary: 'no such file',
          resultBytes: 12,
        },
      }),
    );
    expect(text.endsWith('\nresult: ERROR(code:ENOENT): no such file')).toBe(true);
  });

  it('names an unsignposted failure rather than leaving the prefix empty', () => {
    const text = semanticEmbeddingText(
      record({ outcome: { isError: true, resultSummary: 'boom', resultBytes: 4 } }),
    );
    expect(text).toContain('ERROR(unknown_error): boom');
  });

  it('keeps a still-in-flight record embeddable', () => {
    // The detector runs on the response path and must not be able to throw
    // there, so a record with no outcome gets an empty result line.
    expect(semanticEmbeddingText(record())).toBe('fs__read_file\n{"path":"/etc/hosts"}\nresult: ');
  });
});

describe('semanticEmbeddingText — budgets', () => {
  it('clips over-long arguments and marks that it did', () => {
    // Many fields, not one huge one: `normalizeArgs` already collapses any
    // single string past 256 characters, so the 800-character budget here only
    // ever bites on a *wide* argument object.
    const args = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field${i}`, 'x'.repeat(30)]),
    );
    const text = semanticEmbeddingText(record({ args, outcome: ok }));
    const argsLine = text.split('\n')[1] as string;
    expect(argsLine).toHaveLength(MAX_ARGS_CHARS + 1);
    expect(argsLine.endsWith('…')).toBe(true);
  });

  it('clips an over-long result summary', () => {
    const text = semanticEmbeddingText(
      record({ outcome: { isError: false, resultSummary: 'y'.repeat(900), resultBytes: 900 } }),
    );
    const resultLine = text.split('\n')[2] as string;
    expect(resultLine).toHaveLength('result: '.length + MAX_SUMMARY_CHARS + 1);
    expect(resultLine.endsWith('…')).toBe(true);
  });

  it('counts the error prefix against the summary budget', () => {
    const text = semanticEmbeddingText(
      record({
        outcome: {
          isError: true,
          errorSignature: 'code:E'.padEnd(60, 'X'),
          resultSummary: 'z'.repeat(400),
          resultBytes: 400,
        },
      }),
    );
    const resultLine = text.split('\n')[2] as string;
    expect(resultLine).toHaveLength('result: '.length + MAX_SUMMARY_CHARS + 1);
    expect(resultLine).toContain('ERROR(');
  });

  it('leaves text that already fits exactly alone', () => {
    const summary = 'q'.repeat(MAX_SUMMARY_CHARS);
    const text = semanticEmbeddingText(
      record({ outcome: { isError: false, resultSummary: summary, resultBytes: summary.length } }),
    );
    expect(text.endsWith(`result: ${summary}`)).toBe(true);
    expect(text).not.toContain('…');
  });
});
