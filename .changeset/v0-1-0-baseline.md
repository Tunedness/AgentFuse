---
'@agentfuse/core': minor
'@agentfuse/proxy': minor
'@agentfuse/embeddings-local': minor
'agentfuse': minor
---

First release: a circuit breaker for an agent's tool calls.

`agentfuse wrap -- <server>` puts a transparent MCP proxy between an agent and
one tool server and decides, per `tools/call`, whether the call happens. The
default mode is `warn`: every decision is computed and every trip report is
written, and the call is forwarded anyway, so the false-positive rate can be
measured on real traffic before enforcement is turned on.

**Loop detection** in two tiers. The deterministic tier — exact repeats where
the answers have stopped moving too, repeated error signatures, short cycles —
needs no model and no network. The semantic tier embeds each completed call off
the hot path and scores a sliding window as `min(average pairwise cosine,
answer staleness)`; it needs the optional `@agentfuse/embeddings-local`
companion, and the deterministic tier is complete without it.

Measured on a committed 200-session corpus at the calibrated operating point
(`window: 5`, `threshold: 0.905`, `consecutive_windows: 1`): **87.0% detection
at 0.0% false positives**, precision 1.000, F1 0.930, detection latency p95 5
turns. The design target of ≥90% detection is **not met**; reaching it on this
corpus costs 16% false positives, and that trade was declined. Added latency is
p95 4.84 ms in the worst configuration measured — a real stdio pipe with the
semantic tier and telemetry both on — against a 50 ms budget.

**Budgets** per session. `max_duration` and `max_calls` are exact;
`max_tokens_estimated` and `max_usd_estimated` are lower-bound estimates of
tool I/O, because a `tools/call` proxy cannot see the model's own tokens, and
the `_estimated` suffix is binding across the schema, the reports and the
telemetry.

**Per-tool policy** in one declarative `fusepolicy.yaml` with a published JSON
Schema — `allow`, `warn`, `deny`, `require_approval` against globs — plus a
single `onDecision` escape hatch that can raise or lower an action but never
rewrite arguments.

**Human approval** over a unix socket or an HMAC-signed webhook, with
`agentfuse approve` / `agentfuse deny`. The reason a person gives is carried
into the trip report, into `agentfuse report`, and — for denials — into the
refusal the agent reads, attributed to them.

**Trip reports**, machine-readable and human-readable from one renderer, and an
agent-facing refusal that says a retry will be blocked too and offers concrete
alternatives.

**Telemetry** over OTLP/HTTP, off by default, four `tunedness.*` event types,
and zero additional dependencies when it is on.

Not in this release: a guarded HTTP gateway (`agentfuse serve` binds an
endpoint and resolves session identity, but does not forward tool calls), a
Python in-process SDK, usage ingest for exact token accounting, and A2A
traffic.
