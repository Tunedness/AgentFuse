/**
 * `@agentfuse/core` — the decision engine.
 *
 * ## The purity invariant
 *
 * This package does **no I/O**. It never imports a transport, an MCP SDK, an
 * embedding backend, `node:fs`, `node:net` or `node:child_process`. Its only
 * runtime dependency is `zod`; the only Node builtin it touches is
 * `node:crypto`, for SHA-256.
 *
 * Time arrives through {@link Clock}, identity through {@link IdGenerator},
 * persistence through {@link SessionStore}, human consent through
 * {@link ApprovalGateway}. `Date.now()` and `Math.random()` appear in exactly
 * one adapter each, and never in the engine.
 *
 * That is not tidiness for its own sake. It is what makes the engine
 * deterministic under test, what makes the in-process SDK mode possible without
 * a proxy, and what will let McpGuard reuse this same code. A test
 * (`purity.test.ts`) enforces it on every source file.
 */

export type { ApprovalVerdict, PricingTable, RandomSource } from './adapters/index.js';
export {
  CounterIdGenerator,
  DenyAllApprovalGateway,
  FakeClock,
  HeuristicTokenizer,
  InMemorySessionStore,
  NoopTelemetrySink,
  RecordingTelemetrySink,
  ScriptedApprovalGateway,
  SystemClock,
  TableCostModel,
  UlidGenerator,
} from './adapters/index.js';
export type {
  BreakerPhase,
  BreakerState,
  BudgetDimension,
  BudgetEvent,
  CallOutcome,
  Decision,
  DecisionAction,
  FuseEvent,
  FuseEventBase,
  LoopDetectionEvent,
  PolicyDecisionEvent,
  Reason,
  SessionCounters,
  SessionState,
  SessionSummary,
  TokenEstimate,
  ToolAnnotations,
  ToolCallEvent,
  ToolCallRecord,
  TripCode,
} from './domain/index.js';
export { BUDGET_CODES, initialBreakerState, LOOP_CODES } from './domain/index.js';
export type {
  BeforeCallInput,
  DecisionHook,
  DecisionHookContext,
  DecisionHookResult,
  HookCallView,
  HookSessionView,
  RecordCompleteListener,
} from './engine.js';
export { FuseEngine } from './engine.js';
export type {
  BreakerEvent,
  BreakerTransition,
  Guard,
  GuardContext,
  TripOutcome,
} from './guards/index.js';
export { applyBreakerEvent, applyTrip, GUARDS, GuardState, runGuards } from './guards/index.js';
export type { ErrorInput } from './loop/fingerprint.js';
export { errorSignature, fingerprint, shortFingerprint } from './loop/fingerprint.js';
export {
  argsPreview,
  MASKS,
  maskString,
  NEVER_MASKED_KEYS,
  normalizeArgs,
  truncateValue,
} from './loop/normalize.js';
export type {
  DropCause,
  EmbeddingJob,
  EmbeddingQueueOptions,
  EmbeddingQueueStats,
} from './loop/queue.js';
export { EmbeddingQueue } from './loop/queue.js';
export type { EmbeddingWindowOptions } from './loop/window.js';
export { EmbeddingWindow } from './loop/window.js';
export type {
  CompiledPolicy,
  CompiledRule,
  FusePolicy,
  LoopDetectionOverride,
  LoopDetectionSettings,
  PolicyMode,
  RuleAction,
  RuleEvaluation,
  ToolRule,
  TripDisposition,
} from './policy/index.js';
export {
  compileGlob,
  compilePolicy,
  defaultPolicy,
  evaluateRules,
  FusePolicySchemaV1,
  formatDuration,
  globMatches,
  loadPolicy,
  mergeLoopDetection,
  PolicyValidationError,
  parseDuration,
  parsePolicy,
  toolKey,
} from './policy/index.js';
export type {
  ApprovalGateway,
  ApprovalRequest,
  Clock,
  CostModel,
  EmbeddingProvider,
  IdGenerator,
  Ports,
  SessionStore,
  TelemetrySink,
  Tokenizer,
} from './ports/index.js';
export type { BuildTripReportInput, ReportedCall, TripReport } from './report/index.js';
export { buildTripReport, renderTripReport, TOKEN_ESTIMATE_NOTE } from './report/index.js';
export { sha256 } from './util/hash.js';
export type { JsonValue } from './util/json.js';
export { stableStringify, toJsonValue } from './util/json.js';
export { CORE_VERSION } from './version.js';
