/**
 * Identifier remapping and `_meta` plumbing.
 *
 * A transparent proxy keeps two numbering spaces apart. The agent's request ids
 * and progress tokens live on the downstream connection; the proxy's own live
 * on the upstream one. Letting either leak into the other is how proxies end up
 * delivering a progress notification the client has never heard of, or
 * cancelling the wrong call.
 *
 * ## What the installed SDK already does, and what is left here
 *
 * Both wire-level rewrites are performed by `@modelcontextprotocol/*@2.0.0`
 * itself, and this module deliberately does not duplicate them:
 *
 * - **progressToken.** `Protocol.request` overwrites `_meta.progressToken`
 *   with its own outbound JSON-RPC message id whenever `RequestOptions.onprogress`
 *   is supplied, and routes the upstream `notifications/progress` back to that
 *   callback. Re-minting a token by hand would fight it: the SDK's dispatcher
 *   would answer an echo of the *agent's* token with "progress notification for
 *   an unknown token" and drop it. What is left for the proxy is to strip the
 *   agent's token off the outbound request, remember it for the lifetime of the
 *   call, and stamp it back onto the notification it re-emits downstream —
 *   which is what {@link RequestRemap} is for.
 * - **cancellation.** `notifications/cancelled` is consumed by the downstream
 *   `Server`'s own notification handler, which aborts the request handler's
 *   `AbortController`; chaining `ctx.mcpReq.signal` into the forwarded
 *   `client.request` makes the upstream `Client` emit its own
 *   `notifications/cancelled` carrying *its* request id. The id translation is
 *   therefore a consequence of passing one `AbortSignal` through, not a map.
 *   In the modern era over Streamable HTTP the same signal closes the
 *   per-request stream instead. Either way there is no `downstreamReqId →
 *   upstreamReqId` table to keep, and no place to leak one.
 *
 * So the one table that remains is keyed by the **downstream** request id, and
 * it exists for exactly two reasons: to answer "which token does this progress
 * notification belong to", and to be assertable — a settled request must leave
 * no entry behind, and {@link RequestRemap.size} is how a test says so.
 *
 * Like {@link era}, this module knows nothing about `@agentfuse/core`.
 */

import {
  BAGGAGE_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
} from '@modelcontextprotocol/server';
import type { MetaBag } from './era.js';

/** A progress token as it appears on the wire. */
export type ProgressToken = string | number;

/** A JSON-RPC request id as it appears on the wire. */
export type WireRequestId = string | number;

/** Request `params` as the proxy handles them: an untyped bag. */
export type Params = Record<string, unknown>;

/**
 * The reserved `_meta` keys the proxy copies from the agent's request onto the
 * one it forwards.
 *
 * `clientInfo` and `clientCapabilities` are forwarded so the guarded server
 * sees the *real* caller rather than "agentfuse": a server that varies its
 * behaviour by client — or, on the 2026-07-28 revision, gates an
 * `input_required` result on the caller's declared capabilities — would
 * otherwise be reasoning about the proxy.
 *
 * `traceparent` / `tracestate` / `baggage` (SEP-414) are forwarded so a tool
 * call keeps its place in the user's distributed trace. The proxy never
 * *invents* any of them: a synthesised traceparent would silently graft a
 * fabricated span onto a real trace, which is worse than no trace at all.
 *
 * `io.modelcontextprotocol/protocolVersion` is deliberately absent. It
 * describes the connection the request travels on, and the upstream connection
 * is a different one; the SDK stamps the correct value for it. Copying the
 * downstream's would be the one era-translating act ADR-005 rules out.
 */
export const FORWARDED_META_KEYS: readonly string[] = [
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  BAGGAGE_META_KEY,
];

/** Narrows an unknown value to a readable bag, without copying it. */
function asBag(value: unknown): MetaBag | undefined {
  return typeof value === 'object' && value !== null ? (value as MetaBag) : undefined;
}

/**
 * Merges the lifted envelope back over `_meta` into one readable bag.
 *
 * The SDK hands a handler `_meta` with the reserved `io.modelcontextprotocol/*`
 * keys removed and the same keys separately as `ctx.mcpReq.envelope`. Every
 * reader in the proxy wants the union, so it is assembled in one place.
 */
export function mergeMeta(meta?: MetaBag, envelope?: MetaBag): MetaBag | undefined {
  if (meta === undefined && envelope === undefined) return undefined;
  return { ...meta, ...envelope };
}

/** The W3C `traceparent` carried by a request, if it carried one. */
export function traceparentOf(meta: MetaBag | undefined): string | undefined {
  const value = meta?.[TRACEPARENT_META_KEY];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * One member's value from a W3C `baggage` list.
 *
 * Tolerant by design: baggage is written by whatever sat in front of the proxy,
 * and a malformed member must not cost the well-formed one next to it.
 */
export function baggageEntry(meta: MetaBag | undefined, name: string): string | undefined {
  const raw = meta?.[BAGGAGE_META_KEY];
  if (typeof raw !== 'string') return undefined;
  for (const member of raw.split(',')) {
    const [key, ...rest] = member.split('=');
    if (key?.trim() !== name || rest.length === 0) continue;
    // A baggage value may carry `;`-delimited properties; they are metadata
    // about the entry, not part of the value.
    const value = decodeURIComponent(rest.join('=').split(';', 1)[0]?.trim() ?? '');
    if (value !== '') return value;
  }
  return undefined;
}

/** The self-reported identity of the software that made a request. */
export interface ClientIdentity {
  readonly name: string;
  readonly version?: string;
  readonly title?: string;
}

/**
 * The `io.modelcontextprotocol/clientInfo` a request declares.
 *
 * Only modern-era requests carry it. On a legacy connection the caller's
 * identity is a property of the `initialize` handshake instead, which is why
 * {@link forwardedMeta} accepts a fallback.
 */
export function clientInfoOf(meta: MetaBag | undefined): ClientIdentity | undefined {
  const bag = asBag(meta?.[CLIENT_INFO_META_KEY]);
  return typeof bag?.name === 'string' ? (bag as unknown as ClientIdentity) : undefined;
}

/**
 * The identity and trace keys to graft onto an outbound request's `_meta`.
 *
 * `fallbackClientInfo` fills in `io.modelcontextprotocol/clientInfo` when the
 * request itself did not carry it — the legacy-era case, where the proxy's
 * `Server` learned the caller's identity from `initialize`. Stamping it onto a
 * legacy-era request is safe: legacy `_meta` is an open bag, and a server that
 * does not read the key is unaffected by its presence.
 */
export function forwardedMeta(
  meta: MetaBag | undefined,
  fallbackClientInfo?: ClientIdentity | undefined,
): Params | undefined {
  const out: Params = {};
  let any = false;
  for (const key of FORWARDED_META_KEYS) {
    const value = meta?.[key];
    if (value === undefined) continue;
    out[key] = value;
    any = true;
  }
  if (out[CLIENT_INFO_META_KEY] === undefined && fallbackClientInfo !== undefined) {
    out[CLIENT_INFO_META_KEY] = fallbackClientInfo;
    any = true;
  }
  return any ? out : undefined;
}

/** What {@link splitProgressToken} peeled off a request. */
export interface SplitParams {
  /** The params to forward upstream, with the downstream token removed. */
  readonly params: Params | undefined;
  /** The token the agent asked to be notified on, if it asked. */
  readonly progressToken: ProgressToken | undefined;
}

/**
 * Removes the agent's `progressToken` from a request's `_meta`.
 *
 * It must not travel upstream. See the module documentation: the SDK mints its
 * own token for the outbound leg, and an upstream server echoing the *agent's*
 * token back would be dropped as unknown by the SDK's progress dispatcher.
 *
 * An empty `_meta` is left in place rather than deleted. Removing it would make
 * the forwarded request differ from the agent's in a second way, and an empty
 * `_meta` object is valid on both eras.
 */
export function splitProgressToken(params: Params | undefined): SplitParams {
  const meta = asBag(params?._meta);
  if (meta === undefined) return { params, progressToken: undefined };
  const { progressToken, ...restMeta } = meta as Params;
  if (progressToken === undefined) return { params, progressToken: undefined };
  return {
    params: { ...params, _meta: restMeta },
    progressToken:
      typeof progressToken === 'string' || typeof progressToken === 'number'
        ? progressToken
        : undefined,
  };
}

/**
 * Builds the params to send upstream: the agent's, with the forwarded `_meta`
 * keys merged over whatever `_meta` survived {@link splitProgressToken}.
 */
export function upstreamParams(
  params: Params | undefined,
  downstreamMeta: MetaBag | undefined,
  fallbackClientInfo?: ClientIdentity | undefined,
): Params | undefined {
  const forwarded = forwardedMeta(downstreamMeta, fallbackClientInfo);
  if (forwarded === undefined) return params;
  const existing = asBag(params?._meta);
  return { ...params, _meta: { ...existing, ...forwarded } };
}

/** One in-flight forwarded request, as the proxy remembers it. */
export interface ForwardedRequest {
  /** The JSON-RPC id the agent gave the request. */
  readonly downstreamRequestId: WireRequestId;
  /** The progress token the agent asked to be notified on, if it asked. */
  readonly downstreamProgressToken: ProgressToken | undefined;
}

/**
 * The proxy's per-connection bookkeeping for requests it is currently
 * forwarding.
 *
 * An entry is created when a request is forwarded and dropped the moment it
 * settles — with a result, with an error, or by cancellation. A leak here is
 * unbounded memory growth in a process designed to run for the length of an
 * agent session, so {@link size} exists to be asserted on and `begin` /
 * `settle` are deliberately symmetric enough to put in a `try` / `finally`.
 */
export class RequestRemap {
  readonly #inFlight = new Map<WireRequestId, ForwardedRequest>();

  /** Records a request as in flight. A repeated id replaces the older entry. */
  begin(
    downstreamRequestId: WireRequestId,
    downstreamProgressToken?: ProgressToken | undefined,
  ): ForwardedRequest {
    const entry: ForwardedRequest = { downstreamRequestId, downstreamProgressToken };
    this.#inFlight.set(downstreamRequestId, entry);
    return entry;
  }

  /** The in-flight record for a downstream request id, while it is in flight. */
  get(downstreamRequestId: WireRequestId): ForwardedRequest | undefined {
    return this.#inFlight.get(downstreamRequestId);
  }

  /**
   * The token to stamp onto a progress notification going back downstream.
   *
   * `undefined` once the request has settled, which is the signal to drop a
   * late notification rather than emit one the agent can no longer place.
   */
  progressTokenFor(downstreamRequestId: WireRequestId): ProgressToken | undefined {
    return this.#inFlight.get(downstreamRequestId)?.downstreamProgressToken;
  }

  /** Drops an entry. Safe to call twice; the second call is a no-op. */
  settle(downstreamRequestId: WireRequestId): void {
    this.#inFlight.delete(downstreamRequestId);
  }

  /** How many requests are in flight. Zero whenever nothing is. */
  get size(): number {
    return this.#inFlight.size;
  }

  /** Drops every entry, for connection teardown. */
  clear(): void {
    this.#inFlight.clear();
  }
}
