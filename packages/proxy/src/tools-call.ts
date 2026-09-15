/**
 * The guarded path: `tools/call` through the decision engine.
 *
 * This is the only place in the package where a tool call meets
 * `@agentfuse/core`. Everything before it is transport (see `bridge.ts`) and
 * everything after it is text (see `trip-result.ts`).
 *
 * The shape is fixed by the engine's contract and is deliberately boring:
 *
 * ```
 * beforeCall(input) → allow  → forward → afterCall(callId, outcome)
 *                   → warn   → forward → afterCall(callId, outcome)
 *                   → deny   → isError result, no afterCall
 * ```
 *
 * `afterCall` runs on **every** settled forwarded call — result, upstream
 * error, or cancellation. Skipping it on the unhappy paths would leave the
 * record in `session.inFlight` forever, which is both a leak and a lie: the
 * session's call counter would drift below what the agent actually did.
 */

import {
  type BeforeCallInput,
  type CallOutcome,
  type Decision,
  errorSignature,
  type FuseEngine,
  type SessionSummary,
  type ToolAnnotations,
} from '@agentfuse/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { GuardedToolCall, ToolCallGate } from './bridge.js';
import type { Diagnostics } from './diagnostics.js';
import { traceparentOf } from './remap.js';
import { buildTripResult, renderTripDiagnostic } from './trip-result.js';

/** How many characters of a result the engine gets to see. */
const SUMMARY_LIMIT = 512;

/** How a {@link createToolCallGuard} behaves. */
export interface ToolCallGuardOptions {
  /** The decision engine. Shared across connections; the session id is not. */
  readonly engine: FuseEngine;
  /**
   * Alias of the guarded upstream server, as named in the AgentFuse
   * configuration. It is part of every fingerprint: `read_file` on two
   * different servers is not the same work.
   */
  readonly serverName: string;
  /**
   * The session this connection's calls belong to (ADR-006).
   *
   * In stdio wrap mode this is exact — one child process, one connection, one
   * ULID. Over HTTP it is whatever the session-key ladder resolved, which the
   * ADR is explicit about being best effort.
   */
  readonly sessionId: string;
  /**
   * Resolves the session per call instead of per connection.
   *
   * Only HTTP needs this: the `traceparent` / `baggage` rungs of the ADR-006
   * ladder live in a request's `_meta`, so they cannot be read when the
   * connection opens. `undefined` from the resolver means "use
   * {@link ToolCallGuardOptions.sessionId}" — a strict `session.key` that
   * resolves to nothing must be refused by the serving entry before the call
   * ever reaches the gate, and that entry is P1. See `http-serve.ts`.
   */
  readonly resolveSessionId?: ((call: GuardedToolCall) => string | undefined) | undefined;
  /** Where the trip report and the diagnostics go. Always stderr in wrap mode. */
  readonly diagnostics?: Diagnostics | undefined;
  /**
   * Server-declared behavioural hints for a tool, if the host keeps a catalogue.
   *
   * Unwired by default, and that costs nothing until somebody sets
   * `annotations.trust_hints: true` in their policy — which defaults to `false`
   * precisely because these hints are written by the server AgentFuse exists to
   * be sceptical of. Supplying them needs a `tools/list` cache, which is the
   * CLI's business, not the proxy's.
   */
  readonly annotationsFor?: ((toolName: string) => ToolAnnotations | undefined) | undefined;
  /**
   * Persists a trip report and returns where it went.
   *
   * The proxy does no file I/O of its own: the path it puts in the agent-facing
   * result and in `structuredContent` is whatever this returns. Absent, the
   * result references the trip id instead.
   */
  readonly writeReport?: ((decision: Decision) => string | undefined) | undefined;
  /** Notified when {@link ToolCallGuard.endSession} runs. */
  readonly onSessionEnd?: ((summary: SessionSummary) => void) | undefined;
  /**
   * The `traceparent` to put on the request forwarded upstream, in place of the
   * agent's.
   *
   * Without this the guarded server's work is a **sibling** of AgentFuse's own
   * span rather than its child, so a trace cannot show that the tool call
   * happened inside the guarded hop. The host is the only party that can close
   * that: it is the one that mints the span, and it mints it while the decision
   * is being made — which is why the decision is handed over too, and why the
   * hook is read after `beforeCall` rather than before it.
   *
   * Returning `undefined` — which is also what an unset hook means — forwards
   * the agent's context verbatim and puts nothing new on the wire. **A host
   * must never synthesise a value here.** A `traceparent` naming a span nobody
   * exports grafts a fabricated span onto a real trace, which is worse than no
   * trace at all; see `FORWARDED_META_KEYS` in `remap.ts`.
   */
  readonly traceparentFor?:
    | ((call: GuardedToolCall, decision: Decision) => string | undefined)
    | undefined;
}

/** The gate plus the lifecycle hook the serving entry owns. */
export interface ToolCallGuard {
  /** Hand this to `createBridge({ onToolCall })`. */
  readonly gate: ToolCallGate;
  /**
   * Closes the session and returns its totals.
   *
   * Called when the downstream connection goes away. Phase 3 left a note that
   * matters here: a host that also runs the semantic detector must call
   * `detector.forget(sessionId)` afterwards, because the detector cannot see a
   * session leave the store. {@link ToolCallGuardOptions.onSessionEnd} is where
   * that is wired.
   */
  endSession(): SessionSummary;
}

/** The first `type: 'text'` block of a result, if it has one. */
function firstText(result: CallToolResult): string | undefined {
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return undefined;
}

/**
 * What the engine gets to know about a result.
 *
 * Text blocks first, `structuredContent` as a fallback: a tool that answers
 * only with structured output would otherwise be summarised as the empty
 * string, and the semantic layer would see every one of its calls as identical.
 */
function summarise(result: CallToolResult): string {
  const text = firstText(result);
  if (text !== undefined && text !== '') return text.slice(0, SUMMARY_LIMIT);
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent).slice(0, SUMMARY_LIMIT);
  }
  return '';
}

/** Byte size of the whole result, for the token estimate's scaling factor. */
function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    // A result that will not serialise cannot be measured; zero is the only
    // honest answer, and the engine treats it as "no payload to charge for".
    return 0;
  }
}

function outcomeOfResult(result: CallToolResult): CallOutcome {
  const summary = summarise(result);
  const isError = result.isError === true;
  return {
    isError,
    resultSummary: summary,
    resultBytes: byteSize(result),
    ...(isError ? { errorSignature: errorSignature({ text: summary }) } : undefined),
  };
}

function outcomeOfThrow(error: unknown): CallOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    errorSignature: errorSignature({
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : undefined),
      text: message,
    }),
    resultSummary: message.slice(0, SUMMARY_LIMIT),
    resultBytes: Buffer.byteLength(message, 'utf8'),
  };
}

/** Actions that mean the call does not happen. */
function blocks(decision: Decision): boolean {
  // `beforeCall` resolves `require_approval` itself in enforce mode and
  // downgrades it to `warn` in warn mode, so it can only reach here from an
  // `onDecision` hook that raised the action after the gateway already ran.
  // There is nobody left to ask, so it fails closed.
  return decision.action === 'deny' || decision.action === 'require_approval';
}

/**
 * Builds the guarded `tools/call` path.
 *
 * One guard per downstream connection, because the session id is per
 * connection; the engine behind it is shared.
 */
export function createToolCallGuard(options: ToolCallGuardOptions): ToolCallGuard {
  const { engine, serverName, sessionId: connectionSessionId, diagnostics } = options;

  const gate: ToolCallGate = async (call: GuardedToolCall): Promise<CallToolResult> => {
    const params = call.request.params;
    const toolName = params.name;
    const annotations = options.annotationsFor?.(toolName);
    const traceparent = traceparentOf(call.meta);
    const sessionId = options.resolveSessionId?.(call) ?? connectionSessionId;

    const input: BeforeCallInput = {
      sessionId,
      serverName,
      toolName,
      args: params.arguments,
      ...(annotations !== undefined ? { annotations } : undefined),
      ...(traceparent !== undefined ? { traceparent } : undefined),
    };

    const decision = await engine.beforeCall(input);

    if (decision.report !== undefined) {
      // The operator-facing report, rendered by core. Stderr only: in wrap mode
      // stdout is the JSON-RPC stream.
      diagnostics?.block(renderTripDiagnostic(decision.report));
    }

    if (blocks(decision)) {
      const reportPath = options.writeReport?.(decision);
      diagnostics?.emit('blocked', {
        sessionId,
        tool: toolName,
        action: decision.action,
        codes: decision.reasons.map((reason) => reason.code),
      });
      // A refusal, not a protocol error. See `trip-result.ts`.
      return buildTripResult({
        decision,
        ...(reportPath !== undefined ? { reportPath } : undefined),
      });
    }

    if (decision.wouldTrip) {
      // The whole point of warn mode: the operator measures the false-positive
      // rate before turning enforcement on, and this is the line they count.
      diagnostics?.emit('would_trip', {
        sessionId,
        tool: toolName,
        codes: decision.reasons.map((reason) => reason.code),
      });
    }

    // `afterCall` on every settled call, including the cancelled and the failed
    // ones: a record left in flight is a leak, and a call counter that misses
    // the failures understates what the agent actually did. Written as two
    // explicit arms rather than a `finally`, so the outcome is definitely
    // assigned on both.
    // Read here rather than before the decision: the host mints the span while
    // the decision is emitted, so the identity to re-inject does not exist any
    // earlier. `undefined` leaves the outbound `_meta` exactly as it is today.
    const upstreamTraceparent = options.traceparentFor?.(call, decision);

    try {
      const result = await call.forward(
        upstreamTraceparent === undefined ? undefined : { traceparent: upstreamTraceparent },
      );
      engine.afterCall(decision.callId, outcomeOfResult(result));
      return result;
    } catch (error) {
      engine.afterCall(decision.callId, outcomeOfThrow(error));
      throw error;
    }
  };

  return {
    gate,
    endSession: () => {
      const summary = engine.endSession(connectionSessionId);
      options.onSessionEnd?.(summary);
      return summary;
    },
  };
}
