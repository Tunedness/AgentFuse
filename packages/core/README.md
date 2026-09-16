# @agentfuse/core

The decision engine behind [AgentFuse](https://github.com/tunedness/agentfuse):
given a tool call, decide whether it happens. Loop detection, budget
accounting, per-tool policy, the circuit breaker state machine, and the trip
report.

**Most people do not install this.** It is the library the `agentfuse` command
line and `@agentfuse/proxy` are built on. Install it directly when you are
embedding the breaker in something that is not an MCP proxy — an agent
framework, a gateway, another Tunedness tool.

```sh
npm install @agentfuse/core
```

## It is pure, and that is the design

No I/O, no protocol, no ambient time. Specifically:

- **No `node:fs`, `node:net`, `node:child_process`, no MCP SDK.** The only
  runtime dependency is `zod`, and `node:crypto` is permitted for hashing.
- **Time arrives through an injected `Clock`** and ids through an
  `IdGenerator`. `Date.now()` and `Math.random()` are never called directly.
- **No timers.** `setTimeout`, `setInterval`, `setImmediate`,
  `queueMicrotask`, `process.hrtime` and `performance.now` are all absent. The
  embedding queue's backoff is a deadline compared against `clock.now()`, and
  the owner of an approval timeout is the gateway, not the engine.

This is enforced by a test (`purity.test.ts`) that scans the source, not by
convention. It is what makes the engine reusable in-process, deterministic
under a `FakeClock`, and safe to run inside a proxy whose stdout is a JSON-RPC
stream.

## Using it

```ts
import { FuseEngine, parsePolicy, compilePolicy, SystemClock, UlidGenerator } from '@agentfuse/core';

const policy = compilePolicy(parsePolicy(yamlText));
const engine = new FuseEngine({ policy, ports: { clock: new SystemClock(), ids: new UlidGenerator() } });

const sessionId = engine.startSession();
const decision = await engine.beforeCall({ sessionId, serverName: 'fs', toolName: 'read_file', args });

if (decision.action === 'deny') {
  // Refuse, and tell the agent why. `decision.report` is the audit artefact.
} else {
  const result = await callTheTool();
  engine.afterCall({ callId: decision.callId, result });
}
```

`beforeCall` runs the guard pipeline in order — breaker, policy rules, budgets,
rule-based loop detection, then human approval if the policy asked for one —
and is async only because of that last step. `afterCall` closes the record.
`endSession` returns a summary, and returns a zeroed one for a session it does
not know rather than throwing: a transport closing can race an idle sweep.

## Public surface

### Engine and decisions

`FuseEngine` · `BeforeCallInput` · `Decision` · `DecisionAction` · `Reason` ·
`TripCode` · `LOOP_CODES` · `BUDGET_CODES` · `ApprovalRecord` ·
`APPROVAL_REASON_LIMIT` · `DecisionHook` · `DecisionHookContext` ·
`DecisionHookResult` · `HookCallView` · `HookSessionView` ·
`RecordCompleteListener`

### Policy

`FusePolicySchemaV1` (zod) · `parsePolicy` · `compilePolicy` · `defaultPolicy` ·
`loadPolicy` · `mergeLoopDetection` · `evaluateRules` · `PolicyValidationError` ·
`compileGlob` · `globMatches` · `toolKey` · `parseDuration` · `formatDuration` ·
types `FusePolicy`, `CompiledPolicy`, `CompiledRule`, `ToolRule`, `RuleAction`,
`PolicyMode`, `LoopDetectionSettings`, `LoopDetectionOverride`,
`TripDisposition`, `RuleEvaluation`

Also on the `@agentfuse/core/policy` subpath, which additionally exports
`DURATION_PATTERN` and `DURATION_MESSAGE`. The generated JSON Schema is a
resolvable subpath too:
`@agentfuse/core/schemas/fusepolicy.v1.schema.json`.

### Ports (implement these to wire the engine into a host)

`Clock` · `IdGenerator` · `SessionStore` · `ApprovalGateway` ·
`ApprovalRequest` · `ApprovalAnswer` · `TelemetrySink` · `Tokenizer` ·
`CostModel` · `EmbeddingProvider` · `Ports`

Default implementations: `SystemClock` · `UlidGenerator` ·
`InMemorySessionStore` · `DenyAllApprovalGateway` · `NoopTelemetrySink` ·
`HeuristicTokenizer` · `TableCostModel`

`EmbeddingProvider` is **frozen**, and its contract is that vectors come back
L2-normalised. The sliding-window score is a closed form that is only the mean
pairwise cosine on unit vectors; a provider that returns unnormalised vectors
does not fail loudly, it scores wrongly.

### Loop detection

`EmbeddingWindow` · `EmbeddingQueue` · `ResultNoveltyWindow` ·
`SemanticLoopDetector` · `attachSemanticLoopDetector` · `SemanticHost` ·
`semanticEmbeddingText` · `semanticResultText` · `noveltyTokens` ·
`fingerprint` · `shortFingerprint` · `errorSignature` · `normalizeArgs` ·
`argsPreview` · `maskString` · `truncateValue` · `MASKS` ·
`NEVER_MASKED_KEYS` · `MAX_ARGS_CHARS` · `MAX_SUMMARY_CHARS`

The text handed to the embedder is a **contract**, produced in exactly one
place (`semanticEmbeddingText`). Change it and every calibrated threshold loses
its meaning — `loop_detection.semantic.threshold` is a property of that text
under one model.

### Breaker, guards, reports, events

`initialBreakerState` · `applyBreakerEvent` · `applyTrip` · `runGuards` ·
`GUARDS` · `GuardState` · `Guard` · `GuardContext` · `BreakerState` ·
`BreakerPhase` · `BreakerEvent` · `BreakerTransition` · `TripOutcome` ·
`buildTripReport` · `renderTripReport` · `TripReport` · `ReportedCall` ·
`TOKEN_ESTIMATE_NOTE` · `FuseEvent` and its four members
(`ToolCallEvent`, `PolicyDecisionEvent`, `BudgetEvent`, `LoopDetectionEvent`) ·
`SessionState` · `SessionSummary` · `SessionCounters` · `ToolCallRecord` ·
`CallOutcome` · `ToolAnnotations` · `TokenEstimate` · `DegradedCause`

### Utilities

`sha256` · `stableStringify` · `toJsonValue` · `sanitizeFreeText` ·
`JsonValue` · `CORE_VERSION`

### `@agentfuse/core/testing`

Test doubles, on a subpath so they cannot be configured in production:
`FakeClock` · `CounterIdGenerator` · `ScriptedApprovalGateway` ·
`RecordingTelemetrySink` · `HashingProvider`

`HashingProvider` is an `EmbeddingProvider` that needs no model and no ONNX
runtime — an FNV-1a trigram sketch that really does keep unrelated texts
near-orthogonal. It is what the whole suite runs against; calibration uses the
real model.

## Two things that will surprise you

**`min_calls` gates the semantic rule only.** The deterministic rules ignore it
deliberately: otherwise the default `min_calls: 5` would make "the same call
three times trips on the third" impossible.

**Token and dollar figures are lower-bound estimates of tool I/O.** A
`tools/call` observer cannot see the model's own tokens. Every estimated
quantity carries the `_estimated` suffix, in the schema, in reports and in
telemetry, and the reports print the floor warning as plain text.
`max_duration` and `max_calls` are the exact ones.

## License

Apache-2.0
