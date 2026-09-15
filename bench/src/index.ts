import type { BeforeCallInput } from '@agentfuse/core';

/**
 * A named workload the benchmark harness replays through the engine.
 *
 * The call shape is `@agentfuse/core`'s own {@link BeforeCallInput}: phase 5
 * replaced the placeholder `ToolCall` the proxy used to declare, because a
 * benchmark that measures a shape nothing else uses measures nothing.
 *
 * TODO(phase-9): the real harness measures added latency per `tools/call` and
 * compares it against a committed baseline.
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
