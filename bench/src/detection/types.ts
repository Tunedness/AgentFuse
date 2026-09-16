/**
 * The labelled corpus format.
 *
 * One session per JSONL line. The shape is deliberately *not* AgentFuse's
 * `ToolCallRecord`: the corpus describes what an agent did and what came back,
 * and every derived quantity — `argsNormalized`, the fingerprint, the error
 * signature, the embedding text — is computed by `@agentfuse/core` at replay
 * time. A corpus that carried pre-computed fingerprints would keep passing
 * after a normalizer regression.
 */

/** The five loops a trip is the right answer for. */
export const POSITIVE_SCENARIOS = [
  'verbatim-retry',
  'reworded-retry',
  'error-loop',
  'oscillation',
  'drifting-loop',
] as const;

/** The five honest workloads a trip would ruin. PRD §8's first risk, as data. */
export const NEGATIVE_SCENARIOS = [
  'pagination-sweep',
  'bulk-edit',
  'try-then-fix',
  'list-traverse-process',
  'converging-build-test',
] as const;

export type PositiveScenario = (typeof POSITIVE_SCENARIOS)[number];
export type NegativeScenario = (typeof NEGATIVE_SCENARIOS)[number];
export type ScenarioName = PositiveScenario | NegativeScenario;

/** What the corpus says about one call and its answer. */
export interface CorpusCall {
  readonly serverName: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Whether the upstream reported a failure. */
  readonly isError: boolean;
  /** The result text, verbatim. Becomes `CallOutcome.resultSummary`. */
  readonly result: string;
  /** A structured error code, when the scenario's upstream supplies one. */
  readonly errorCode?: string;
  /** Size of the notional full payload, for the budget counters. */
  readonly resultBytes: number;
}

/** One labelled session. */
export interface CorpusSession {
  readonly id: string;
  readonly scenario: ScenarioName;
  readonly label: 'positive' | 'negative';
  /**
   * Index of the first call that belongs to the wasteful behaviour, for
   * positives; `null` for negatives.
   *
   * Detection latency is measured from here: `tripIndex - loopStartIndex` is
   * how many calls of the loop the agent got to make before the breaker
   * stopped it. Counting from the start of the session instead would reward a
   * corpus whose loops begin on call zero, which real ones do not.
   */
  readonly loopStartIndex: number | null;
  /** One-line note on what this session is meant to catch. */
  readonly note: string;
  readonly calls: readonly CorpusCall[];
}
