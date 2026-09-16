# AgentFuse — latency benchmark

1000 measured calls per configuration, 200 discarded first · node v24.20.0 · darwin/arm64
embedder: local:all-MiniLM-L6-v2 (384 dims)

## Tier 1 — `InMemoryTransport` (the engine and one in-process hop)

| configuration | min | mean | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| direct · telemetry off | 0.009 | 0.018 | 0.013 | 0.025 | 0.040 | 1.588 |
| rules · telemetry off | 0.022 | 0.035 | 0.030 | 0.047 | 0.061 | 1.189 |
| semantic · telemetry off | 0.022 | 0.029 | 0.026 | 0.032 | 0.040 | 1.367 |
| direct · telemetry on | 0.008 | 0.012 | 0.009 | 0.012 | 0.019 | 2.305 |
| rules · telemetry on | 0.020 | 0.031 | 0.028 | 0.035 | 0.043 | 2.103 |
| semantic · telemetry on | 0.020 | 0.026 | 0.024 | 0.030 | 0.043 | 1.684 |

## Tier 2 — a real stdio pipe through the built CLI

| configuration | min | mean | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| direct · telemetry off | 0.024 | 0.048 | 0.043 | 0.070 | 0.131 | 0.648 |
| rules · telemetry off | 0.086 | 0.136 | 0.116 | 0.205 | 0.446 | 0.974 |
| semantic · telemetry off | 4.110 | 4.532 | 4.499 | 4.807 | 7.519 | 8.641 |
| direct · telemetry on | 0.023 | 0.046 | 0.043 | 0.062 | 0.109 | 0.684 |
| rules · telemetry on (18 export posts) | 0.098 | 0.159 | 0.125 | 0.269 | 0.680 | 1.397 |
| semantic · telemetry on (18 export posts) | 4.142 | 4.587 | 4.516 | 4.897 | 7.946 | 8.866 |

## Added latency — `(rules | semantic) − direct`, percentile by percentile

| configuration | min | mean | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| in-memory · rules · telemetry off | 0.013 | 0.017 | 0.017 | 0.022 | 0.020 | -0.399 |
| in-memory · semantic · telemetry off | 0.012 | 0.011 | 0.013 | 0.007 | -0.000 | -0.220 |
| in-memory · rules · telemetry on | 0.012 | 0.019 | 0.019 | 0.022 | 0.024 | -0.202 |
| in-memory · semantic · telemetry on | 0.012 | 0.014 | 0.015 | 0.018 | 0.024 | -0.621 |
| stdio · rules · telemetry off | 0.063 | 0.087 | 0.072 | 0.134 | 0.315 | 0.326 |
| stdio · semantic · telemetry off | 4.086 | 4.484 | 4.455 | 4.737 | 7.388 | 7.993 |
| stdio · rules · telemetry on | 0.075 | 0.113 | 0.082 | 0.207 | 0.571 | 0.713 |
| stdio · semantic · telemetry on | 4.118 | 4.541 | 4.473 | 4.835 | 7.837 | 8.182 |

## What telemetry costs

- in-memory rules: p95 0.047 → 0.035 ms (-0.012 ms), p99 0.061 → 0.043 ms
- in-memory semantic: p95 0.032 → 0.030 ms (-0.002 ms), p99 0.040 → 0.043 ms
- stdio rules: p95 0.205 → 0.269 ms (0.064 ms), p99 0.446 → 0.680 ms
- stdio semantic: p95 4.807 → 4.897 ms (0.089 ms), p99 7.519 → 7.946 ms

## What the embedding queue actually did

in-memory, 1200 calls: offered 1200, embedded 0, shed by sampling 0, dropped on overflow 1135, still waiting at the end 64
wrapped process, 300 calls: offered 300, embedded 300, droppedOverflow 0, droppedSampling 0, batches 300, failures 0, skipped 0, trips 0, depth 0

These two lines are the explanation for the whole table. In memory the client calls faster than any model can answer, so the queue sheds almost everything and the semantic tier is free — which is the property ADR-002 was designed for, and the proof that the hot path is genuinely decoupled. Through a pipe the calls are slower, the queue keeps up, and the ONNX work then competes for the same process and the same cores as the proxy: that is where the extra milliseconds come from. Load shedding is the design working, not a fault; a session that shed is marked `degraded` and its report says so.

**Note the batch count: 300 batches for 300 jobs.** Under a steady arrival rate the worker is always idle when the next call completes, so it takes a batch of one and pays the model's fixed per-inference cost every time; phase 4 measured a batch of eight at 10.7 ms, so eight batches of one cost several times what one batch of eight would. The queue cannot wait for company because it owns no timer — core has no clock of its own and phase 3 rejected a `Scheduler` port for that reason — and the only alternative, holding jobs until a deadline checked on the *next* enqueue, would leave the tail of a short session unscored. That is a detection-coverage trade for a latency budget with ten times the headroom it needs, so it is recorded here rather than taken.

## Verdict against PRD §6

- added latency p95 < 50 ms: MET · worst configuration is stdio · semantic · telemetry on at 4.835 ms
