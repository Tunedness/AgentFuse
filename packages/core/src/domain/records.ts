/**
 * Records of what an agent actually did.
 *
 * These are the only shapes the decision engine reasons about. Nothing here
 * names a wire protocol: the proxy translates MCP (or anything else) into a
 * {@link ToolCallRecord} and the engine never learns where it came from.
 */

/**
 * Server-supplied behavioural hints attached to a tool definition.
 *
 * **These are untrusted.** They are written by the upstream server, which is
 * exactly the component AgentFuse exists to be sceptical of. The engine only
 * consults them when the policy sets `annotations.trust_hints: true`, which
 * defaults to `false`.
 */
export interface ToolAnnotations {
  /** The server claims the tool performs no mutation. */
  readOnlyHint?: boolean;
  /** The server claims the tool may perform irreversible mutation. */
  destructiveHint?: boolean;
  /** The server claims repeated identical calls are safe. */
  idempotentHint?: boolean;
  /** The server claims the tool reaches systems outside its own state. */
  openWorldHint?: boolean;
  /** Human-facing display name. */
  title?: string;
}

/** How a tool call ended, as reported back by the proxy. */
export interface CallOutcome {
  /** Whether the upstream reported an error result. */
  isError: boolean;
  /**
   * Stable identity of the failure: a structured error code when the upstream
   * supplied one, otherwise the first line of the error text with volatile
   * detail masked out. See `errorSignature()` in `loop/fingerprint.ts`.
   */
  errorSignature?: string;
  /**
   * At most 512 characters of the result, used both as the text the semantic
   * layer embeds and as the preview a human reads in a trip report.
   */
  resultSummary: string;
  /** Size of the full (un-summarised) result payload in bytes. */
  resultBytes: number;
}

/** Estimated token cost of a single call's tool I/O. */
export interface TokenEstimate {
  /** Tokens attributable to the normalized arguments. */
  argsTokens: number;
  /** Tokens attributable to the result payload. */
  resultTokens: number;
}

/**
 * One intercepted tool invocation, from the moment it entered the proxy to the
 * moment its result came back.
 */
export interface ToolCallRecord {
  /** ULID minted by the engine through the injected {@link IdGenerator}. */
  id: string;
  /** Session this call belongs to. */
  sessionId: string;
  /** Upstream alias as named in the AgentFuse configuration. */
  serverName: string;
  /** Tool name as requested by the agent. */
  toolName: string;
  /** Raw arguments, exactly as the agent sent them. */
  args: unknown;
  /** Canonical JSON of {@link args} with volatile values masked. */
  argsNormalized: string;
  /** `sha256(serverName \0 toolName \0 argsNormalized)`, hex encoded. */
  fingerprint: string;
  /** Untrusted server hints, when the transport carried any. */
  annotations?: ToolAnnotations;
  /** `Clock.now()` when the call entered the engine. */
  startedAt: number;
  /** `Clock.now()` when the result came back. */
  endedAt?: number;
  /** Present once the call completed. */
  outcome?: CallOutcome;
  /** Filled in by `afterCall` from the injected {@link Tokenizer}. */
  tokensEstimated?: TokenEstimate;
  /**
   * W3C trace context propagated from the request's `_meta` (SEP-414).
   *
   * Only ever copied from an inbound request — AgentFuse never invents a
   * traceparent, because a fabricated one would silently corrupt a user's
   * distributed traces.
   */
  traceparent?: string;
}
