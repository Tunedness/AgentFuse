/**
 * Protocol-era classification.
 *
 * The MCP wire protocol splits into two eras. `legacy` covers revisions
 * `2024-10-07` … `2025-11-25`: the connection is negotiated with `initialize`,
 * sessions exist, and `ping` and `logging/setLevel` are part of the vocabulary.
 * `modern` is `2026-07-28` and later: `initialize` is gone, `server/discover`
 * replaces it, sessions were removed, and every request carries its own `_meta`
 * envelope.
 *
 * **AgentFuse does not translate between the two (ADR-005).** A proxy that
 * rewrote one era into the other would have to invent the facts the other era
 * deleted — a session id where the spec says there is none, a negotiated
 * version where there is no handshake — and every such invention is a lie the
 * user only discovers during an incident. The proxy is era-*transparent*: the
 * downstream era is decided by the serving entry, the upstream connection is
 * negotiated to match it, and a residual disagreement is reported loudly
 * rather than papered over.
 *
 * This module imports neither `@agentfuse/core` nor anything else of the
 * proxy's own. It is part of the transport skeleton McpGuard's ADR anticipates
 * lifting into a shared internal package, and knowing about the decision engine
 * would make that a rewrite instead of a move.
 */

import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';

/**
 * Which wire era a connection speaks.
 *
 * Structurally identical to the SDK's own `ProtocolEra`, restated here because
 * the SDK exports it only as a type from the server and client packages while
 * the boundary between the two eras — the revision string that separates them —
 * is internal. Restating a two-member union is cheaper than depending on an
 * internal constant.
 */
export type ProtocolEra = 'legacy' | 'modern';

/**
 * The first revision of the modern era.
 *
 * Revisions are ISO dates, so a lexicographic comparison against this constant
 * is also a chronological one — no version parsing required, and an unknown
 * future revision sorts into the modern era rather than being rejected.
 */
export const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Classifies a protocol revision string into its era. */
export function eraOfProtocolVersion(version: string): ProtocolEra {
  return version >= FIRST_MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy';
}

/**
 * An untyped view of a request's `_meta`.
 *
 * The SDK ships `RequestMetaEnvelope` as a type whose reserved
 * `io.modelcontextprotocol/*` keys are not addressable through an index
 * signature, so the proxy reads them by name off this bag instead.
 */
export type MetaBag = Readonly<Record<string, unknown>>;

/** The two places one request can carry era evidence. */
export interface EraSignals {
  /** `_meta` as the handler sees it, with reserved keys already lifted out. */
  readonly meta?: MetaBag | undefined;
  /** The lifted reserved `io.modelcontextprotocol/*` keys, when there were any. */
  readonly envelope?: MetaBag | undefined;
}

/**
 * Reads the protocol version a request declares, if it declares one.
 *
 * Only modern-era requests carry it: on a legacy connection the version is a
 * property of the handshake, not of the request. The SDK lifts the reserved
 * keys out of `_meta` before a handler sees them, so the envelope is checked
 * first and raw `_meta` second — the latter matters for a request the proxy
 * inspects before dispatch.
 */
export function declaredProtocolVersion(signals: EraSignals): string | undefined {
  const fromEnvelope = signals.envelope?.[PROTOCOL_VERSION_META_KEY];
  if (typeof fromEnvelope === 'string') return fromEnvelope;
  const fromMeta = signals.meta?.[PROTOCOL_VERSION_META_KEY];
  return typeof fromMeta === 'string' ? fromMeta : undefined;
}

/**
 * The era a single inbound request belongs to.
 *
 * A declared `io.modelcontextprotocol/protocolVersion` is definitive evidence
 * of the modern era. Its absence is evidence of the legacy era: a modern
 * request is *required* to carry the key, so a request without one is a legacy
 * request.
 */
export function detectRequestEra(signals: EraSignals): ProtocolEra {
  const declared = declaredProtocolVersion(signals);
  return declared === undefined ? 'legacy' : eraOfProtocolVersion(declared);
}

/** Anything that can report the era it negotiated — `Client` satisfies it. */
export interface EraReporting {
  getProtocolEra(): ProtocolEra | undefined;
  getNegotiatedProtocolVersion(): string | undefined;
}

/**
 * The era a connected client ended up on.
 *
 * `Client.getProtocolEra()` is the SDK's own answer and is preferred; the
 * negotiated version is the fallback for a peer that reports one without the
 * era accessor (a hand-written transport double, for instance).
 */
export function eraOfConnection(connection: EraReporting): ProtocolEra | undefined {
  const reported = connection.getProtocolEra();
  if (reported !== undefined) return reported;
  const version = connection.getNegotiatedProtocolVersion();
  return version === undefined ? undefined : eraOfProtocolVersion(version);
}

/**
 * Raised when the two sides of the proxy do not speak the same era.
 *
 * Deliberately verbose. Somebody hits this while wiring AgentFuse in front of
 * a server for the first time, and the useful answer is not "era mismatch" —
 * it is which side is which and what to change.
 */
export class EraMismatchError extends Error {
  /** The era the agent (downstream) is speaking. */
  readonly downstream: ProtocolEra;
  /** The era the guarded server (upstream) turned out to speak. */
  readonly upstream: ProtocolEra | undefined;

  constructor(downstream: ProtocolEra, upstream: ProtocolEra | undefined, detail?: string) {
    const upstreamLabel =
      upstream === undefined ? 'no era at all (it never negotiated)' : `the ${upstream} era`;
    super(
      `AgentFuse protocol era mismatch: the downstream client speaks the ${downstream} era ` +
        `but the upstream server speaks ${upstreamLabel}.\n` +
        'AgentFuse is era-transparent by design (ADR-005) and does not translate between ' +
        'the 2025 and 2026-07-28 protocol revisions. Both sides must agree.\n' +
        `Fix it by ${
          downstream === 'modern'
            ? 'pointing AgentFuse at a server that serves the 2026-07-28 revision, or by ' +
              'configuring the client to negotiate the legacy era'
            : 'upgrading the client to negotiate the 2026-07-28 revision, or by configuring ' +
              "AgentFuse's upstream connection for the legacy era"
        }.${detail === undefined ? '' : `\n${detail}`}`,
    );
    this.name = 'EraMismatchError';
    this.downstream = downstream;
    this.upstream = upstream;
  }
}

/**
 * Checks that an upstream connection landed on the era the downstream speaks.
 *
 * The proxy asks the upstream `Client` to negotiate the downstream's era, so a
 * mismatch is normally impossible. It is still checked, because
 * `versionNegotiation: { mode: 'auto' }` is allowed to *fall back* to the
 * legacy handshake: a modern downstream in front of a server that answers
 * `server/discover` with a 2025 signal would otherwise be silently proxied
 * across an era boundary, which is the one thing ADR-005 says never happens.
 *
 * @throws {EraMismatchError} when the two sides disagree.
 */
export function assertSameEra(
  downstream: ProtocolEra,
  upstream: ProtocolEra | undefined,
  detail?: string,
): void {
  if (downstream !== upstream) throw new EraMismatchError(downstream, upstream, detail);
}
