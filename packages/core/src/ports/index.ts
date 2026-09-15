/**
 * Every edge of the engine, expressed as an interface.
 *
 * `@agentfuse/core` performs no I/O and reads no ambient state. Time, identity,
 * randomness, persistence, human approval, tokenisation, pricing, telemetry and
 * embeddings all arrive through these ports. That is what makes the engine
 * deterministically testable — and what will let McpGuard reuse it, and what
 * makes the in-process SDK mode possible at all.
 *
 * All of these are frozen as of phase 2 so the proxy, the embeddings package
 * and the CLI can be built against them in parallel.
 */

import type { Reason } from '../domain/decision.js';
import type { FuseEvent } from '../domain/events.js';
import type { SessionState } from '../domain/session.js';

/**
 * Turns text into vectors for the semantic loop detector.
 *
 * Nothing in phase 2 implements this; it is declared now so
 * `@agentfuse/embeddings-local` has a fixed target.
 */
export interface EmbeddingProvider {
  /** Identifies the model in reports, e.g. `local:all-MiniLM-L6-v2`. */
  readonly id: string;
  /** Vector width. */
  readonly dims: number;
  /**
   * Embeds a batch of texts.
   *
   * **Vectors MUST be L2-normalized.** The detector compares them with a plain
   * dot product and will silently produce nonsense scores otherwise.
   */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Releases the backing model, if any. */
  close?(): Promise<void>;
}

/**
 * Where session state lives.
 *
 * Synchronous on purpose: this sits on the hot path of every tool call, and an
 * `await` here would put the proxy's added latency at the mercy of a store's
 * round trip.
 */
export interface SessionStore {
  get(sessionId: string): SessionState | undefined;
  create(sessionId: string, now: number): SessionState;
  /** Records activity; updates `lastActivityAt` and the wall-clock counter. */
  touch(state: SessionState, now: number): void;
  delete(sessionId: string): void;
  /** Drops sessions idle for longer than the timeout; returns the ids dropped. */
  sweepIdle(idleTimeoutMs: number, now: number): string[];
  all(): Iterable<SessionState>;
}

/** A request for a human to decide. */
export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  toolName: string;
  serverName: string;
  /** Truncated, possibly redacted argument preview safe to show in a terminal. */
  argsPreview: string;
  reasons: Reason[];
  /** The policy's `approvals.timeout`, in milliseconds. */
  timeoutMs: number;
}

/**
 * Asks a human.
 *
 * The **gateway owns the timeout**, not the engine: the engine has no clock of
 * its own beyond the injected {@link Clock} and refuses to start real timers,
 * so it passes `timeoutMs` and expects `'timeout'` back. The `AbortSignal` is
 * fired when the session ends or the breaker is reset, and an implementation
 * must abandon the prompt when it trips.
 */
export interface ApprovalGateway {
  requestApproval(
    req: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<'approved' | 'denied' | 'timeout'>;
}

/**
 * Where events go.
 *
 * Fire-and-forget: `emit` must not throw and must not block. Implementations
 * buffer and batch.
 */
export interface TelemetrySink {
  emit(event: FuseEvent): void;
  shutdown(): Promise<void>;
}

/** The only source of time in the engine. `Date.now()` is never called directly. */
export interface Clock {
  now(): number;
}

/** The only source of identity. `Math.random()` is never called directly. */
export interface IdGenerator {
  next(): string;
}

/** Counts tokens in text. */
export interface Tokenizer {
  /** Identifies the counting method in reports, e.g. `heuristic:bytes/4`. */
  readonly id: string;
  count(text: string): number;
}

/** Turns token counts into money. */
export interface CostModel {
  estimateUsd(tokens: { input: number; output: number }): number;
}

/** The full set of ports the engine depends on. */
export interface Ports {
  clock: Clock;
  ids: IdGenerator;
  sessions: SessionStore;
  approvals: ApprovalGateway;
  telemetry: TelemetrySink;
  tokenizer: Tokenizer;
  cost: CostModel;
}
