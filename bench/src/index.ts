import type { ToolCall } from '@agentfuse/core';
import { toToolCall } from '@agentfuse/proxy';

/**
 * A named workload the benchmark harness replays through the proxy.
 *
 * TODO(phase-9): the real harness measures added latency per `tools/call` and
 * compares it against a committed baseline. This is the shape it will use.
 */
export interface Scenario {
  readonly name: string;
  readonly calls: readonly ToolCall[];
}

/**
 * Builds a synthetic scenario of `size` identical calls — the degenerate loop
 * the breaker is supposed to catch, and the cheapest thing to measure against.
 */
export function repeatedCallScenario(size: number): Scenario {
  const calls = Array.from({ length: size }, (_, index) =>
    toToolCall({ name: 'filesystem.read_file', arguments: { path: '/etc/hosts' } }, index),
  );

  return { name: `repeated-call-${size}`, calls };
}
