# AgentFuse — detection benchmark

corpus: 200 sessions, 2084 calls, 100 positive / 100 negative
embedder: local:all-MiniLM-L6-v2 (384 dims), loaded in 79 ms
embedded 2084 calls in 5474 ms (2.63 ms/call, batches of 8)

## Rule tier alone (R1/R2/R3, window 8, semantic off)

precision 0.870  recall 0.600  F1 0.710
TP 60  FN 40  FP 9  TN 91  FP-rate 9.0%
detection latency (turns): mean 2.87  p50 3  p95 5  max 5
caught by: rules 60, semantic 0
  verbatim-retry            20/20 tripped
  reworded-retry             0/20 tripped
  error-loop                20/20 tripped
  oscillation               20/20 tripped
  drifting-loop              0/20 tripped
  pagination-sweep           0/20 tripped
  bulk-edit                  0/20 tripped
  try-then-fix               7/20 tripped
  list-traverse-process      0/20 tripped
  converging-build-test      2/20 tripped

## Threshold sweep

3198 candidates over window 4/5/6/8/10/12, min_calls 3/4/5/6/8/10, consecutive 1/2/3, threshold 0.8–1 step 0.005
0 of them meet both PRD §6 targets

### Best candidate per shape (false-positive line held, margin ≥ 0.004)

| window | min_calls | consecutive | threshold | recall | FP rate | F1 | margin | latency p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 3 | 1 | 0.905 | 81.0% | 1.0% | 0.890 | 0.0067 | 4 |
| 4 | 3 | 2 | 0.890 | 82.0% | 0.0% | 0.901 | 0.0053 | 5 |
| 4 | 3 | 3 | 0.855 | 80.0% | 0.0% | 0.889 | 0.0062 | 6 |
| 5 | 3 | 1 | 0.905 | 87.0% | 0.0% | 0.930 | 0.0068 | 5 |
| 5 | 3 | 2 | 0.885 | 86.0% | 1.0% | 0.920 | 0.0050 | 6 |
| 5 | 3 | 3 | 0.860 | 86.0% | 0.0% | 0.925 | 0.0067 | 7 |

### ROC at window=5, min_calls=5, consecutive_windows=1

| threshold | recall | FP rate | precision | F1 | latency p95 |
| --- | --- | --- | --- | --- | --- |
| 0.800 | 90.0% | 20.0% | 81.8% | 0.857 | 5 |
| 0.805 | 90.0% | 20.0% | 81.8% | 0.857 | 5 |
| 0.810 | 90.0% | 20.0% | 81.8% | 0.857 | 5 |
| 0.815 | 90.0% | 20.0% | 81.8% | 0.857 | 5 |
| 0.820 | 90.0% | 20.0% | 81.8% | 0.857 | 5 |
| 0.825 | 90.0% | 19.0% | 82.6% | 0.861 | 5 |
| 0.830 | 90.0% | 19.0% | 82.6% | 0.861 | 5 |
| 0.835 | 90.0% | 19.0% | 82.6% | 0.861 | 5 |
| 0.840 | 90.0% | 17.0% | 84.1% | 0.870 | 5 |
| 0.845 | 90.0% | 16.0% | 84.9% | 0.874 | 5 |
| 0.850 | 89.0% | 16.0% | 84.8% | 0.868 | 5 |
| 0.855 | 89.0% | 11.0% | 89.0% | 0.890 | 5 |
| 0.860 | 89.0% | 8.0% | 91.8% | 0.904 | 5 |
| 0.865 | 89.0% | 6.0% | 93.7% | 0.913 | 5 |
| 0.870 | 88.0% | 5.0% | 94.6% | 0.912 | 5 |
| 0.875 | 88.0% | 5.0% | 94.6% | 0.912 | 5 |
| 0.880 | 88.0% | 3.0% | 96.7% | 0.921 | 5 |
| 0.885 | 88.0% | 2.0% | 97.8% | 0.926 | 5 |
| 0.890 | 88.0% | 1.0% | 98.9% | 0.931 | 5 |
| 0.895 | 87.0% | 1.0% | 98.9% | 0.926 | 5 |
| 0.900 | 87.0% | 0.0% | 100.0% | 0.930 | 5 |
| 0.905 | 87.0% | 0.0% | 100.0% | 0.930 | 5 |
| 0.910 | 87.0% | 0.0% | 100.0% | 0.930 | 5 |
| 0.915 | 85.0% | 0.0% | 100.0% | 0.919 | 5 |
| 0.920 | 84.0% | 0.0% | 100.0% | 0.913 | 5 |
| 0.925 | 83.0% | 0.0% | 100.0% | 0.907 | 5 |
| 0.930 | 83.0% | 0.0% | 100.0% | 0.907 | 5 |
| 0.935 | 82.0% | 0.0% | 100.0% | 0.901 | 5 |
| 0.940 | 81.0% | 0.0% | 100.0% | 0.895 | 5 |
| 0.945 | 81.0% | 0.0% | 100.0% | 0.895 | 5 |
| 0.950 | 81.0% | 0.0% | 100.0% | 0.895 | 5 |
| 0.955 | 81.0% | 0.0% | 100.0% | 0.895 | 5 |
| 0.960 | 80.0% | 0.0% | 100.0% | 0.889 | 5 |
| 0.965 | 80.0% | 0.0% | 100.0% | 0.889 | 5 |
| 0.970 | 80.0% | 0.0% | 100.0% | 0.889 | 5 |
| 0.975 | 80.0% | 0.0% | 100.0% | 0.889 | 5 |
| 0.980 | 77.0% | 0.0% | 100.0% | 0.870 | 5 |
| 0.985 | 76.0% | 0.0% | 100.0% | 0.864 | 5 |
| 0.990 | 76.0% | 0.0% | 100.0% | 0.864 | 5 |
| 0.995 | 76.0% | 0.0% | 100.0% | 0.864 | 7 |
| 1.000 | 60.0% | 0.0% | 100.0% | 0.750 | 5 |

### Where each scenario sits (critical threshold at the chosen window shape)

| scenario | label | rule-caught | min | median | max |
| --- | --- | --- | --- | --- | --- |
| verbatim-retry | positive | 20/20 | — | 1.0000 | 1.0000 |
| reworded-retry | positive | 0/20 | 0.6545 | 0.8491 | 0.9561 |
| error-loop | positive | 20/20 | — | 0.9143 | 0.9644 |
| oscillation | positive | 20/20 | 0.3289 | 0.5323 | 0.5485 |
| drifting-loop | positive | 0/20 | 0.9760 | 0.9969 | 0.9977 |
| pagination-sweep | negative | 0/20 | 0.3362 | 0.7500 | 0.7972 |
| bulk-edit | negative | 0/20 | 0.6000 | 0.6750 | 0.7429 |
| try-then-fix | negative | 0/20 | 0.2517 | 0.6000 | 0.6736 |
| list-traverse-process | negative | 0/20 | 0.8229 | 0.8573 | 0.8982 |
| converging-build-test | negative | 0/20 | 0.5870 | 0.6383 | 0.6798 |

## Chosen operating point

window 5 · min_calls 5 · threshold 0.905 · consecutive_windows 1
margin to the nearest flip: 0.0068 (nearest negative 0.8982, nearest positive 0.9130; model resolution floor 0.002)

**No candidate met both PRD §6 targets.** The point below is the best of those that hold the false-positive line; recall is reported as measured, not as hoped.

precision 1.000  recall 0.870  F1 0.930
TP 87  FN 13  FP 0  TN 100  FP-rate 0.0%
detection latency (turns): mean 3.53  p50 3  p95 5  max 5
caught by: rules 60, semantic 27
  verbatim-retry            20/20 tripped
  reworded-retry             7/20 tripped
  error-loop                20/20 tripped
  oscillation               20/20 tripped
  drifting-loop             20/20 tripped
  pagination-sweep           0/20 tripped
  bulk-edit                  0/20 tripped
  try-then-fix               0/20 tripped
  list-traverse-process      0/20 tripped
  converging-build-test      0/20 tripped

## End-to-end verification (real engine, real detector, real provider)

ran 200 sessions in 4765 ms
precision 1.000  recall 0.870  F1 0.930
TP 87  FN 13  FP 0  TN 100  FP-rate 0.0%
detection latency (turns): mean 3.53  p50 3  p95 5  max 5
the sweep model and the engine agree on every session

## The `cursor` exemption

15 of 20 pagination sweeps use a `cursor` argument. With the exemption removed, 15 would lose fingerprint variation entirely and 12 would be halted by R1 at the third page.

## Verdict against PRD §6

- detection ≥ 90%: NOT MET (87.0%)
- false positives < 5%: MET (0.0%)

The detection target is not reachable with this design on this corpus. Every miss is a `reworded-retry` session — the same question asked in new words, answered the same way — and those sit below the `list-traverse-process` negatives on every axis measured here, so no threshold separates them. This is a finding, not a tuning problem; PRD §6 and ADR-002 are where it gets resolved.

gate: recall ≥ 0.85 PASS · false positives < 0.05 PASS
