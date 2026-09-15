import type { CostModel, Tokenizer } from '../ports/index.js';

/**
 * Dependency-free token estimate: one token per four bytes of UTF-8.
 *
 * This is a **floor**, not a measurement. It exists so core can meter a token
 * budget with zero dependencies; the CLI injects a real BPE tokenizer
 * (`gpt-tokenizer`) in phase 6. Every number derived from it travels with the
 * "tool-I/O floor estimate" caveat, per ADR-007.
 */
export class HeuristicTokenizer implements Tokenizer {
  readonly id = 'heuristic:bytes/4';
  readonly #encoder = new TextEncoder();

  count(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(this.#encoder.encode(text).length / 4);
  }
}

/** Per-million-token prices, as they appear in a policy's `pricing` block. */
export interface PricingTable {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

/** Linear cost model driven by the policy's `pricing` table. */
export class TableCostModel implements CostModel {
  readonly #pricing: PricingTable;

  constructor(pricing: PricingTable) {
    this.#pricing = pricing;
  }

  estimateUsd(tokens: { input: number; output: number }): number {
    const { inputPerMTokUsd, outputPerMTokUsd } = this.#pricing;
    return (
      (tokens.input / 1_000_000) * inputPerMTokUsd + (tokens.output / 1_000_000) * outputPerMTokUsd
    );
  }
}
