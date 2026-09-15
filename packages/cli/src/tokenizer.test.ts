import { HeuristicTokenizer } from '@agentfuse/core';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { describe, expect, it } from 'vitest';
import { costModelFor, GptTokenizer, TOKENIZER_ID } from './tokenizer.js';

describe('GptTokenizer', () => {
  const tokenizer = new GptTokenizer();

  it('names the encoding it used, because reports carry the number', () => {
    expect(tokenizer.id).toBe(TOKENIZER_ID);
    expect(TOKENIZER_ID).toContain('o200k_base');
  });

  it('counts nothing for empty text', () => {
    expect(tokenizer.count('')).toBe(0);
  });

  it.each([
    // Fixtures with a checked length, so a library upgrade that changes the
    // encoding shows up here rather than in somebody's budget.
    [' ', 1],
    ['hello world', 2],
    ['hello world, this is a test of the tokenizer', 10],
    ['{"path":"/tmp/x.ts","contents":"const a = 1;"}', 17],
  ])('counts %j as %i tokens', (text, expected) => {
    expect(tokenizer.count(text)).toBe(expected);
  });

  it('agrees with the library it wraps on a payload of the shape it will actually see', () => {
    const payload = JSON.stringify({
      tool: 'read_file',
      args: { path: 'src/engine.ts', range: [1, 400] },
      result: 'export class FuseEngine {\n  readonly #policy: CompiledPolicy;\n}\n',
    });

    expect(tokenizer.count(payload)).toBe(countTokens(payload));
  });

  it('counts a special-token marker instead of throwing on it', () => {
    // A file an agent is editing may contain `<|endoftext|>` as ordinary text.
    // `countTokens` rejects that by default, and a throw here would surface as
    // a failed tool call: `count` is called synchronously from `afterCall`.
    expect(() => countTokens('a <|endoftext|> b')).toThrow();
    expect(tokenizer.count('a <|endoftext|> b')).toBeGreaterThan(0);
    expect(tokenizer.fallbacks).toBe(0);
  });

  it('beats the byte heuristic on JSON, which is the reason it exists', () => {
    // ADR-007's claim, as a test: `bytes/4` was calibrated on prose and
    // under-counts the code and JSON that actually crosses a tools/call
    // boundary, by a factor that depends on what the agent is doing.
    const json = JSON.stringify({ a: 1, b: [2, 3], c: { d: 'e' }, f: null, g: true });
    const heuristic = new HeuristicTokenizer().count(json);

    expect(tokenizer.count(json)).toBeGreaterThan(heuristic);
  });

  it('falls back to the byte heuristic rather than propagating, and counts that it did', () => {
    // A slightly wrong token count is worth vastly less than a broken tool
    // call, so anything the library objects to degrades instead of throwing.
    const broken = new GptTokenizer(() => {
      throw new Error('merge table unavailable');
    });

    expect(broken.count('hello world')).toBe(new HeuristicTokenizer().count('hello world'));
    expect(broken.count('again')).toBe(new HeuristicTokenizer().count('again'));
    // Counted, so a run whose figures are half heuristic can say so instead of
    // reporting a worse number under a better name.
    expect(broken.fallbacks).toBe(2);
  });

  it('counts its own fallbacks, so a run cannot quietly report heuristic numbers', () => {
    expect(new GptTokenizer().fallbacks).toBe(0);
  });
});

describe('costModelFor', () => {
  const cost = costModelFor({ input_per_mtok_usd: 3, output_per_mtok_usd: 15 });

  it('prices input and output separately, per million tokens', () => {
    expect(cost.estimateUsd({ input: 1_000_000, output: 0 })).toBeCloseTo(3, 10);
    expect(cost.estimateUsd({ input: 0, output: 1_000_000 })).toBeCloseTo(15, 10);
    expect(cost.estimateUsd({ input: 500_000, output: 200_000 })).toBeCloseTo(1.5 + 3, 10);
  });

  it('is zero for no tokens', () => {
    expect(cost.estimateUsd({ input: 0, output: 0 })).toBe(0);
  });

  it('is linear, so a doubled session costs double', () => {
    const once = cost.estimateUsd({ input: 1_234, output: 5_678 });

    expect(cost.estimateUsd({ input: 2_468, output: 11_356 })).toBeCloseTo(once * 2, 12);
  });

  it('honours a policy that declares free tokens', () => {
    const free = costModelFor({ input_per_mtok_usd: 0, output_per_mtok_usd: 0 });

    expect(free.estimateUsd({ input: 9_000_000, output: 9_000_000 })).toBe(0);
  });

  it('feeds the same arithmetic the engine would have used by default', () => {
    // Core builds a `TableCostModel` from the policy when no `cost` port is
    // supplied. This is the same class, passed explicitly so the wiring says
    // who owns it — not a second implementation that could disagree.
    const pricing = { input_per_mtok_usd: 2.5, output_per_mtok_usd: 10 };
    const tokens = { input: 123_456, output: 7_890 };

    expect(costModelFor(pricing).estimateUsd(tokens)).toBe(
      (tokens.input / 1_000_000) * 2.5 + (tokens.output / 1_000_000) * 10,
    );
  });
});

describe('ADR-007 labelling', () => {
  it('names every figure it produces an estimate', () => {
    // The port itself has no room for a caveat, so the rule is enforced where
    // the numbers surface: core's `TOKEN_ESTIMATE_NOTE`, the policy's
    // `max_tokens_estimated` / `max_usd_estimated` keys, and the `_estimated`
    // suffix in reports and diagnostics. What this test pins is the one thing
    // the CLI could get wrong on its own: the id it stamps on the count.
    expect(new GptTokenizer().id).not.toContain('exact');
    expect(new GptTokenizer().id).toBe('gpt-tokenizer:o200k_base');
  });
});
