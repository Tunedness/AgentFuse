/**
 * Session identity over HTTP — the ADR-006 ladder.
 *
 * ## What this file is, and what it is not
 *
 * In stdio wrap mode a session is a fact: one child process, one connection,
 * one ULID. Over HTTP there is no such thing to lean on. The `2026-07-28`
 * revision removed sessions from the protocol outright — no `Mcp-Session-Id`,
 * no `initialize`, every request independent and stateless — so "which calls
 * belong to one task" has to be answered from what the requests themselves
 * carry. ADR-006 answers it with a ladder, and this file is that ladder.
 *
 * **Gateway mode proper is P1**, and this is deliberately only its groundwork.
 * The reason is structural rather than a matter of effort: the SDK's HTTP entry
 * (`createMcpHandler`) builds a server instance per request on the legacy path,
 * and its factory context carries the HTTP `Request` but not the parsed
 * `_meta` — so the rungs that live in `_meta` (`traceparent`, `baggage`) can
 * only be read once a request is being *handled*, not when the instance is
 * built. A correct gateway therefore needs an upstream connection pool keyed by
 * a session resolved per request, which is a design with its own trade-offs and
 * its own ADR. Shipping a handler that quietly opened one upstream connection
 * per HTTP request would look like it worked and cost a process spawn per tool
 * call.
 *
 * So what lives here is the part that is finished and testable: resolving the
 * session key, saying out loud how exact the answer is, and the per-call
 * adapter Phase 6 plugs into {@link createToolCallGuard}.
 *
 * ## Honesty is a requirement, not a nicety
 *
 * The bottom rung — hash of `clientInfo` plus remote address, bounded by an
 * idle timeout — is a guess. Two agents behind one NAT with the same client
 * build share a session and therefore share a budget. ADR-006 says this is
 * documented as best effort rather than presented as a guarantee, and
 * {@link SessionKeyResolution.exact} is how a report or a log line says which
 * of the two it got.
 */

import type { Clock, FusePolicy, IdGenerator } from '@agentfuse/core';
import { sha256 } from '@agentfuse/core';
import type { GuardedToolCall } from './bridge.js';
import type { MetaBag } from './era.js';
import { baggageEntry, type ClientIdentity, clientInfoOf, traceparentOf } from './remap.js';

/** NUL. Written as an escape because a raw NUL byte in source is unreadable. */
const SEPARATOR = '\u0000';

/**
 * The baggage member AgentFuse and McpGuard agree on.
 *
 * This is a cross-tool contract, not an implementation detail: McpGuard's PRD
 * says the two can be chained, and the convention is that the outermost proxy
 * resolves the session and injects this member while the inner ones adopt it.
 * When the umbrella's `tunedness.*` schema package ships, this constant's home
 * is there.
 */
export const SESSION_BAGGAGE_KEY = 'tunedness.session-id';

/** Which rung of the ladder produced a session key. */
export type SessionKeySource = 'traceparent' | 'baggage' | 'mcp-session-id' | 'client-address';

/** Everything the ladder is allowed to look at. */
export interface SessionKeyInput {
  /** The request's `_meta`, envelope merged in. Where the trace rungs live. */
  readonly meta?: MetaBag | undefined;
  /** The `Mcp-Session-Id` header, when the legacy HTTP transport supplied one. */
  readonly mcpSessionId?: string | undefined;
  /**
   * Self-reported caller identity, for the bottom rung.
   *
   * Read from `_meta` when absent here; the parameter exists because on a
   * legacy connection the identity came from `initialize` instead.
   */
  readonly clientInfo?: ClientIdentity | undefined;
  /**
   * Remote address, for the bottom rung.
   *
   * Supplied by the caller because a web-standard `Request` has no notion of
   * one — in Node it lives on the socket, and behind a load balancer it lives
   * in a header the operator has to nominate.
   */
  readonly remoteAddress?: string | undefined;
}

/** What the ladder resolved, and how much it is worth. */
export interface SessionKeyResolution {
  /** The session every call sharing this key is metered against. */
  readonly sessionId: string;
  /** Which rung answered. */
  readonly source: SessionKeySource;
  /**
   * `true` when the key came from something the caller actually declared,
   * `false` when it was inferred. Only the bottom rung is inferred.
   */
  readonly exact: boolean;
}

/** The trace id out of a W3C `traceparent`, when it is well-formed. */
export function traceIdOf(traceparent: string | undefined): string | undefined {
  if (traceparent === undefined) return undefined;
  // `version-traceid-spanid-flags`, the trace id being 32 lowercase hex digits.
  // An all-zero trace id is explicitly invalid in the spec, and accepting it
  // would merge every badly-instrumented caller into one session.
  const fields = traceparent.split('-');
  const traceId = fields[1];
  if (fields.length < 4 || traceId === undefined) return undefined;
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0{32}$/.test(traceId)) return undefined;
  return traceId;
}

/** Stable identity for the bottom rung: who, from where. */
export function clientAddressKey(
  clientInfo: ClientIdentity | undefined,
  remoteAddress: string | undefined,
): string | undefined {
  if (clientInfo === undefined && remoteAddress === undefined) return undefined;
  // NUL-separated for the same reason core's fingerprint is: a name or an
  // address may contain the obvious separators, and NUL cannot.
  return sha256(
    [clientInfo?.name ?? '', clientInfo?.version ?? '', remoteAddress ?? ''].join(SEPARATOR),
  );
}

/** One remembered bottom-rung binding. */
interface AddressBinding {
  sessionId: string;
  lastSeenAt: number;
}

/**
 * Runs the ladder for one endpoint.
 *
 * The bottom rung needs memory — the same caller has to land on the same
 * session id across requests — and that memory needs an expiry, or a
 * long-running gateway accumulates one entry per client that ever connected.
 * Expiry is lazy, compared against an injected {@link Clock}: the proxy holds
 * no timers of its own, for the same reason `@agentfuse/core` holds none.
 */
export class SessionKeyResolver {
  readonly #key: FusePolicy['session']['key'];
  readonly #idleTimeoutMs: number;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #bindings = new Map<string, AddressBinding>();

  constructor(options: {
    /** The policy's `session.key`. */
    readonly key: FusePolicy['session']['key'];
    /** The policy's `session.idle_timeout`, in milliseconds. */
    readonly idleTimeoutMs: number;
    readonly clock: Clock;
    readonly ids: IdGenerator;
  }) {
    this.#key = options.key;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  /**
   * Resolves the session a request belongs to.
   *
   * `undefined` means the configured key could not be resolved. That is not a
   * bug to paper over with a fresh id: metering a call against a session that
   * exists only for that call turns every budget into no budget. The caller
   * refuses the request instead.
   */
  resolve(input: SessionKeyInput): SessionKeyResolution | undefined {
    const configured = this.#key;

    if (configured === 'traceparent') {
      const traceId = traceIdOf(traceparentOf(input.meta));
      return traceId === undefined
        ? undefined
        : { sessionId: traceId, source: 'traceparent', exact: true };
    }

    if (configured.startsWith('baggage:')) {
      const name = configured.slice('baggage:'.length);
      const value = baggageEntry(input.meta, name);
      return value === undefined ? undefined : { sessionId: value, source: 'baggage', exact: true };
    }

    if (configured === 'connection') {
      // The transport's own notion of a connection. Over legacy HTTP that is
      // `Mcp-Session-Id`; the modern revision has no such thing, which is why
      // this setting cannot be the default.
      return input.mcpSessionId === undefined
        ? undefined
        : { sessionId: input.mcpSessionId, source: 'mcp-session-id', exact: true };
    }

    return this.#auto(input);
  }

  /** How many bottom-rung bindings are held. Asserted on by the leak tests. */
  get size(): number {
    return this.#bindings.size;
  }

  /** Drops bindings idle past the timeout. Returns how many went. */
  sweep(): number {
    const now = this.#clock.now();
    let dropped = 0;
    for (const [key, binding] of this.#bindings) {
      if (now - binding.lastSeenAt < this.#idleTimeoutMs) continue;
      this.#bindings.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /** Forgets every binding, for endpoint teardown. */
  clear(): void {
    this.#bindings.clear();
  }

  #auto(input: SessionKeyInput): SessionKeyResolution | undefined {
    const traceId = traceIdOf(traceparentOf(input.meta));
    if (traceId !== undefined) return { sessionId: traceId, source: 'traceparent', exact: true };

    const chained = baggageEntry(input.meta, SESSION_BAGGAGE_KEY);
    if (chained !== undefined) return { sessionId: chained, source: 'baggage', exact: true };

    // Below the chaining contract on purpose. ADR-006 says an inner proxy
    // *adopts* the baggage member an outer one injected; a transport-level id
    // the outer proxy does not control must not outrank that, or chaining
    // stops meaning anything the moment both are present. The ADR's own
    // wording for the legacy-HTTP case reads the other way round and is worth
    // a clarifying edit.
    if (input.mcpSessionId !== undefined) {
      return { sessionId: input.mcpSessionId, source: 'mcp-session-id', exact: true };
    }

    const addressKey = clientAddressKey(
      input.clientInfo ?? clientInfoOf(input.meta),
      input.remoteAddress,
    );
    if (addressKey === undefined) return undefined;

    this.sweep();
    const now = this.#clock.now();
    const existing = this.#bindings.get(addressKey);
    if (existing !== undefined) {
      existing.lastSeenAt = now;
      return { sessionId: existing.sessionId, source: 'client-address', exact: false };
    }

    const sessionId = this.#ids.next();
    this.#bindings.set(addressKey, { sessionId, lastSeenAt: now });
    return { sessionId, source: 'client-address', exact: false };
  }
}

/**
 * One sentence naming the regime in force, for a report or a log line.
 *
 * ADR-006's consequence clause: the tool writes plainly which regime it is
 * under, because a budget that is exact in one mode and heuristic in another
 * must never look the same in a report.
 */
export function describeSessionRegime(resolution: SessionKeyResolution | undefined): string {
  if (resolution === undefined) {
    return 'session unresolved: the configured session.key produced nothing for this request';
  }
  switch (resolution.source) {
    case 'traceparent':
      return 'session from the W3C traceparent trace id (exact)';
    case 'baggage':
      return `session from the ${SESSION_BAGGAGE_KEY} baggage member (exact, chained from an outer proxy)`;
    case 'mcp-session-id':
      return 'session from the Mcp-Session-Id header (exact, legacy era only)';
    case 'client-address':
      return 'session inferred from clientInfo and remote address, bounded by session.idle_timeout — best effort, not a guarantee';
  }
}

/**
 * Adapts a resolver into the per-call hook {@link createToolCallGuard} takes.
 *
 * Returns `undefined` when the ladder could not resolve, which the guard reads
 * as "use the connection's session id". Over HTTP a strict `session.key` that
 * resolves to nothing has to be refused before the request ever reaches the
 * gate — that rejection belongs to the serving entry, which is P1.
 */
export function sessionIdResolverFor(
  resolver: SessionKeyResolver,
  extra?: (call: GuardedToolCall) => Omit<SessionKeyInput, 'meta'>,
): (call: GuardedToolCall) => string | undefined {
  return (call) => resolver.resolve({ meta: call.meta, ...extra?.(call) })?.sessionId;
}
