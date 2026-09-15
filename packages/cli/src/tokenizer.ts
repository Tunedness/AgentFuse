/**
 * The real tokenizer, and the cost model that turns its output into money.
 *
 * ## Why not `bytes/4`
 *
 * `@agentfuse/core` ships a `HeuristicTokenizer` so it can meter a token budget
 * with zero dependencies, and says in its own doc that it is a floor rather than
 * a measurement. ADR-007 is explicit about why the CLI replaces it: the
 * character heuristic was calibrated on prose, and what actually crosses a
 * `tools/call` boundary is source code, diffs and JSON. Those tokenize much
 * worse than four bytes to a token — a minified JSON blob or a run of
 * punctuation can be close to one token per character — so on the payloads this
 * product exists to meter, the heuristic under-counts by a factor that varies
 * with the content. A budget whose error depends on what the agent happens to
 * be doing is not a budget.
 *
 * So the CLI injects `gpt-tokenizer`'s `o200k_base`, which is the encoding
 * ADR-007 names.
 *
 * ## Two things this had to get right
 *
 * **Special tokens cannot be allowed to throw.** `countTokens` rejects text
 * containing `<|endoftext|>` and friends unless told otherwise, and tool
 * arguments are agent- and file-content-shaped: a chat-template fragment inside
 * a file an agent is editing is entirely ordinary. `Tokenizer.count` is called
 * from `FuseEngine.afterCall`, which is on the proxy's response path and is
 * synchronous, so a throw there would turn "this file contains a string" into a
 * failed tool call. `ALL_SPECIAL_TOKENS` therefore moves every special marker
 * out of the library's disallowed set. Whether a given occurrence then counts
 * as one token or as its literal characters is the library's business; either
 * way it is a number and not an exception, which is the property that matters
 * here.
 *
 * **It still must not throw.** Anything else the library might object to falls
 * back to the byte heuristic rather than propagating, because a slightly wrong
 * token count is worth vastly less than a broken tool call. The fallback is
 * counted so it cannot be silent.
 */

import { type CostModel, type PricingTable, TableCostModel, type Tokenizer } from '@agentfuse/core';
import { ALL_SPECIAL_TOKENS, countTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** What `Tokenizer.id` reports. Appears in reports, so it is part of the record. */
export const TOKENIZER_ID = 'gpt-tokenizer:o200k_base';

/** The BPE counter itself. Injectable so the fallback path is reachable in a test. */
export type CountFn = (text: string) => number;

const bpeCount: CountFn = (text) => countTokens(text, { allowedSpecial: ALL_SPECIAL_TOKENS });

/**
 * `o200k_base` BPE token counting.
 *
 * The encoder's merge tables are loaded on first use by the library itself, so
 * constructing this is free; the first `count` pays for the table.
 */
export class GptTokenizer implements Tokenizer {
  readonly id = TOKENIZER_ID;
  readonly #encoder = new TextEncoder();
  readonly #count: CountFn;
  #fallbacks = 0;

  constructor(count: CountFn = bpeCount) {
    this.#count = count;
  }

  /**
   * How many counts fell back to the byte heuristic.
   *
   * Observable on purpose: a run whose token figures are half heuristic should
   * be able to say so rather than quietly reporting a worse number under a
   * better name.
   */
  get fallbacks(): number {
    return this.#fallbacks;
  }

  count(text: string): number {
    if (text === '') return 0;
    try {
      // Counting, not prompting: a `<|endoftext|>` inside a tool argument is
      // just text, and refusing to count it would fail the call.
      return this.#count(text);
    } catch {
      this.#fallbacks += 1;
      return Math.ceil(this.#encoder.encode(text).length / 4);
    }
  }
}

/**
 * The cost model for a policy's `pricing` block.
 *
 * Core's `TableCostModel` already does exactly this arithmetic, and the engine
 * already builds one from the policy when no `cost` port is supplied — so this
 * is a named re-use rather than a second implementation. It is passed
 * explicitly anyway, because "the CLI owns the cost model" should be visible in
 * the wiring instead of being a default that happens to be right.
 *
 * ADR-007 governs what may be done with the result: the proxy sees tool
 * arguments and tool results and nothing else, so the figure is a floor on the
 * cost of the context the tools injected — never the model's own usage. Every
 * surface that shows it calls it `usd_estimated`.
 */
export function costModelFor(pricing: {
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
}): CostModel {
  const table: PricingTable = {
    inputPerMTokUsd: pricing.input_per_mtok_usd,
    outputPerMTokUsd: pricing.output_per_mtok_usd,
  };
  return new TableCostModel(table);
}
