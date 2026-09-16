/**
 * `@agentfuse/bench` — the private benchmark harness. Never published.
 *
 * Two benchmarks live here, and between them they are the evidence for PRD §6:
 *
 * - `detection/` — a seeded corpus of labelled sessions replayed through the
 *   real {@link FuseEngine} with the real local embedder, reporting precision,
 *   recall, F1, detection latency in turns, and the threshold sweep the
 *   schema's defaults are calibrated from.
 * - `latency/` — a no-op upstream driven over both `InMemoryTransport` and a
 *   real stdio pipe, reporting the added latency of interposing AgentFuse.
 *
 * Neither is a unit test. `npm test` runs only the corpus's determinism checks
 * from this package; the measurements themselves load a 23 MB model or spawn
 * processes and are run from `npm run bench:*`.
 */

import type { BeforeCallInput } from '@agentfuse/core';

export type { CorpusOptions } from './detection/corpus.js';
export {
  ALL_SCENARIOS,
  DEFAULT_SEED,
  fromJsonl,
  generateCorpus,
  SESSIONS_PER_SCENARIO,
  toJsonl,
} from './detection/corpus.js';
export type {
  CorpusCall,
  CorpusSession,
  NegativeScenario,
  PositiveScenario,
  ScenarioName,
} from './detection/types.js';
export { NEGATIVE_SCENARIOS, POSITIVE_SCENARIOS } from './detection/types.js';
export { Rng, seedFrom } from './rng.js';

/**
 * A named workload the benchmark harness replays through the engine.
 *
 * The call shape is `@agentfuse/core`'s own {@link BeforeCallInput}: phase 5
 * replaced the placeholder `ToolCall` the proxy used to declare, because a
 * benchmark that measures a shape nothing else uses measures nothing.
 */
export interface Scenario {
  readonly name: string;
  readonly calls: readonly BeforeCallInput[];
}

/**
 * Builds a synthetic scenario of `size` identical calls — the degenerate loop
 * the breaker is supposed to catch, and the cheapest thing to measure against.
 */
export function repeatedCallScenario(size: number): Scenario {
  const calls = Array.from(
    { length: size },
    (): BeforeCallInput => ({
      sessionId: `bench-repeated-${size}`,
      serverName: 'filesystem',
      toolName: 'read_file',
      args: { path: '/etc/hosts' },
    }),
  );

  return { name: `repeated-call-${size}`, calls };
}
