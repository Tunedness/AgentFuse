/**
 * `@agentfuse/proxy` — the transparent MCP proxy.
 *
 * AgentFuse is a man-in-the-middle: it presents an MCP *server* to the agent
 * and holds an MCP *client* against the real upstream server. Everything the
 * agent sends arrives on the server side; `tools/call` gets a decision from
 * `@agentfuse/core` and is either forwarded or answered with a structured
 * refusal, and every other method passes through blind.
 *
 * ## The layering, which is enforced rather than described
 *
 * ```
 * era.ts  remap.ts  bridge.ts  diagnostics.ts   ← MCP plumbing. No engine.
 *                      │
 *          tools-call.ts   trip-result.ts       ← the only files that know
 *                      │                          @agentfuse/core exists
 *          stdio-wrap.ts   http-serve.ts        ← serving entries
 * ```
 *
 * McpGuard's ADR anticipates lifting the top row into a shared internal
 * package. `boundary.test.ts` fails the build if anything in it imports the
 * engine, so that lift stays a move rather than a rewrite.
 *
 * ## Where to start
 *
 * {@link wrapStdioServer} is the whole product in one call: give it a command
 * and an engine and it puts the breaker in front of that server's `tools/call`
 * traffic. {@link createBridge} is the layer under it, for a host that owns its
 * own transports.
 */

export type {
  Bridge,
  BridgeOptions,
  GuardedToolCall,
  ToolCallGate,
} from './bridge.js';
export { createBridge, PASSTHROUGH_RESULT } from './bridge.js';
export type { DiagnosticSink, DiagnosticsOptions } from './diagnostics.js';
export { DIAGNOSTIC_PREFIX, Diagnostics } from './diagnostics.js';
export type { EraReporting, EraSignals, MetaBag, ProtocolEra } from './era.js';
export {
  assertSameEra,
  declaredProtocolVersion,
  detectRequestEra,
  EraMismatchError,
  eraOfConnection,
  eraOfProtocolVersion,
  FIRST_MODERN_PROTOCOL_VERSION,
} from './era.js';
export type {
  SessionKeyInput,
  SessionKeyResolution,
  SessionKeySource,
} from './http-serve.js';
export {
  clientAddressKey,
  describeSessionRegime,
  SESSION_BAGGAGE_KEY,
  SessionKeyResolver,
  sessionIdResolverFor,
  traceIdOf,
} from './http-serve.js';
export type {
  ClientIdentity,
  ForwardedRequest,
  OutboundMetaOverrides,
  Params,
  ProgressToken,
  SplitParams,
  WireRequestId,
} from './remap.js';
export {
  baggageEntry,
  clientInfoOf,
  FORWARDED_META_KEYS,
  forwardedMeta,
  mergeMeta,
  RequestRemap,
  splitProgressToken,
  traceparentOf,
  upstreamParams,
} from './remap.js';
export type { StdioWrapHandle, StdioWrapOptions } from './stdio-wrap.js';
export { RELAYABLE_CLIENT_CAPABILITIES, wrapStdioServer } from './stdio-wrap.js';
export type { ToolCallGuard, ToolCallGuardOptions } from './tools-call.js';
export { createToolCallGuard } from './tools-call.js';
export type { TripResultInput, TripStructuredContent } from './trip-result.js';
export {
  buildTripResult,
  primaryReason,
  RETRY_WARNING,
  renderTripDiagnostic,
  renderTripText,
  TRIP_META_KEY,
} from './trip-result.js';
export { PROXY_VERSION } from './version.js';
