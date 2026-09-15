import { z } from 'zod';

/**
 * Version of the AgentFuse domain contract described by this package.
 * Bumped independently of the proxy and CLI releases.
 */
export const CORE_VERSION = '0.0.0';

/**
 * A single intercepted tool invocation, reduced to the fields the circuit
 * breaker reasons about.
 *
 * This shape is deliberately protocol-agnostic — nothing in `@agentfuse/core`
 * may name MCP, or import a transport, or reach for an embedding backend. The
 * proxy translates the wire format into this; the policy engine only ever sees
 * this. That one-way direction is what keeps the decision logic testable
 * without a live server.
 */
export const ToolCallSchema = z.object({
  /** Fully qualified tool name, e.g. `filesystem.read_file`. */
  toolName: z.string().min(1),
  /** Raw arguments as supplied by the agent. */
  arguments: z.record(z.string(), z.unknown()).default({}),
  /** Unix epoch milliseconds at which the call entered the proxy. */
  calledAt: z.number().int().nonnegative(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * Validates an untrusted payload as a {@link ToolCall}.
 *
 * @throws {z.ZodError} when the payload does not describe a tool call.
 */
export function parseToolCall(input: unknown): ToolCall {
  return ToolCallSchema.parse(input);
}
