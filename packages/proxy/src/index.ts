import { parseToolCall, type ToolCall } from '@agentfuse/core';
import type { Client } from '@modelcontextprotocol/client';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import type { McpServer } from '@modelcontextprotocol/server';

/** Version of the proxy implementation. */
export const PROXY_VERSION = '0.0.0';

/**
 * The two halves of a running proxy.
 *
 * AgentFuse is a man-in-the-middle: it presents an MCP *server* to the agent
 * and holds an MCP *client* against the real upstream server. Everything the
 * agent sends arrives on the server side, gets a decision from
 * `@agentfuse/core`, and is either forwarded over the client or answered with a
 * structured refusal.
 */
export interface ProxyWiring {
  /** Downstream face: what the agent connects to. */
  readonly server: McpServer;
  /** Upstream face: the real tool server being guarded. */
  readonly client: Client;
}

/**
 * Translates raw `tools/call` params off the wire into the protocol-agnostic
 * {@link ToolCall} the breaker reasons about.
 *
 * This is the only direction the dependency runs: the proxy knows about MCP and
 * about core, core knows nothing about MCP.
 *
 * @param params - `params` of an MCP `tools/call` request.
 * @param now - Injectable clock, so the breaker's time window is testable.
 */
export function toToolCall(params: unknown, now: number = Date.now()): ToolCall {
  const parsed = CallToolRequestParamsSchema.parse(params);

  return parseToolCall({
    toolName: parsed.name,
    arguments: parsed.arguments ?? {},
    calledAt: now,
  });
}
