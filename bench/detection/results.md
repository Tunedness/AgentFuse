# AgentFuse — detection benchmark

corpus: 200 sessions, 2084 calls, 100 positive / 100 negative
embedder: local:all-MiniLM-L6-v2 (384 dims), loaded in 74 ms
embedded 2084 calls in 5449 ms (2.61 ms/call, batches of 8)

## Rule tier alone (R1/R2/R3, window 8, semantic off)

precision 0.659  recall 0.600  F1 0.628
TP 60  FN 40  FP 31  TN 69  FP-rate 31.0%
detection latency (turns): mean 2.87  p50 3  p95 5  max 5
caught by: rules 60, semantic 0
  verbatim-retry            20/20 tripped
  reworded-retry             0/20 tripped
  error-loop                20/20 tripped
  oscillation               20/20 tripped
  drifting-loop              0/20 tripped
  pagination-sweep           0/20 tripped
  bulk-edit                  0/20 tripped
  try-then-fix              11/20 tripped
  list-traverse-process      0/20 tripped
  converging-build-test     20/20 tripped

## Threshold sweep

2337 candidates over window 5/6/8/10/12, min_calls 4/5/6/8/10, consecutive 1/2/3, threshold 0.8–1 step 0.005
0 of them meet both PRD §6 targets

### ROC at window=5, min_calls=5, consecutive_windows=2

| threshold | recall | FP rate | precision | F1 | latency p95 |
| --- | --- | --- | --- | --- | --- |
| 0.800 | 96.0% | 53.0% | 64.4% | 0.771 | 6 |
| 0.805 | 96.0% | 52.0% | 64.9% | 0.774 | 6 |
| 0.810 | 96.0% | 50.0% | 65.8% | 0.780 | 6 |
| 0.815 | 96.0% | 50.0% | 65.8% | 0.780 | 6 |
| 0.820 | 96.0% | 50.0% | 65.8% | 0.780 | 6 |
| 0.825 | 96.0% | 49.0% | 66.2% | 0.784 | 6 |
| 0.830 | 96.0% | 47.0% | 67.1% | 0.790 | 6 |
| 0.835 | 96.0% | 43.0% | 69.1% | 0.803 | 6 |
| 0.840 | 96.0% | 40.0% | 70.6% | 0.814 | 6 |
| 0.845 | 96.0% | 39.0% | 71.1% | 0.817 | 6 |
| 0.850 | 96.0% | 39.0% | 71.1% | 0.817 | 6 |
| 0.855 | 96.0% | 36.0% | 72.7% | 0.828 | 6 |
| 0.860 | 96.0% | 34.0% | 73.8% | 0.835 | 6 |
| 0.865 | 96.0% | 33.0% | 74.4% | 0.838 | 6 |
| 0.870 | 96.0% | 30.0% | 76.2% | 0.850 | 6 |
| 0.875 | 96.0% | 28.0% | 77.4% | 0.857 | 6 |
| 0.880 | 95.0% | 25.0% | 79.2% | 0.864 | 6 |
| 0.885 | 95.0% | 22.0% | 81.2% | 0.876 | 6 |
| 0.890 | 94.0% | 21.0% | 81.7% | 0.874 | 6 |
| 0.895 | 91.0% | 19.0% | 82.7% | 0.867 | 6 |
| 0.900 | 89.0% | 18.0% | 83.2% | 0.860 | 6 |
| 0.905 | 88.0% | 18.0% | 83.0% | 0.854 | 6 |
| 0.910 | 86.0% | 18.0% | 82.7% | 0.843 | 6 |
| 0.915 | 85.0% | 14.0% | 85.9% | 0.854 | 6 |
| 0.920 | 85.0% | 14.0% | 85.9% | 0.854 | 6 |
| 0.925 | 85.0% | 14.0% | 85.9% | 0.854 | 6 |
| 0.930 | 84.0% | 14.0% | 85.7% | 0.848 | 6 |
| 0.935 | 82.0% | 14.0% | 85.4% | 0.837 | 6 |
| 0.940 | 82.0% | 14.0% | 85.4% | 0.837 | 6 |
| 0.945 | 81.0% | 14.0% | 85.3% | 0.831 | 6 |
| 0.950 | 80.0% | 14.0% | 85.1% | 0.825 | 6 |
| 0.955 | 80.0% | 14.0% | 85.1% | 0.825 | 6 |
| 0.960 | 80.0% | 14.0% | 85.1% | 0.825 | 6 |
| 0.965 | 80.0% | 14.0% | 85.1% | 0.825 | 6 |
| 0.970 | 80.0% | 13.0% | 86.0% | 0.829 | 6 |
| 0.975 | 79.0% | 13.0% | 85.9% | 0.823 | 6 |
| 0.980 | 77.0% | 13.0% | 85.6% | 0.811 | 6 |
| 0.985 | 76.0% | 13.0% | 85.4% | 0.804 | 6 |
| 0.990 | 76.0% | 11.0% | 87.4% | 0.813 | 6 |
| 0.995 | 75.0% | 2.0% | 97.4% | 0.847 | 8 |
| 1.000 | 60.0% | 0.0% | 100.0% | 0.750 | 5 |

### Where each scenario sits (critical threshold at the chosen window shape)

| scenario | label | rule-caught | min | median | max |
| --- | --- | --- | --- | --- | --- |
| verbatim-retry | positive | 20/20 | — | 1.0000 | 1.0000 |
| reworded-retry | positive | 0/20 | — | 0.8999 | 0.9460 |
| error-loop | positive | 20/20 | — | 0.7139 | 0.9968 |
| oscillation | positive | 20/20 | — | 0.4948 | 0.5438 |
| drifting-loop | positive | 0/20 | 0.9731 | 0.9965 | 0.9976 |
| pagination-sweep | negative | 0/20 | 0.7576 | 0.8202 | 0.9952 |
| bulk-edit | negative | 0/20 | 0.8626 | 0.9115 | 0.9970 |
| try-then-fix | negative | 0/20 | — | 0.5340 | 0.5945 |
| list-traverse-process | negative | 0/20 | 0.8266 | 0.8584 | 0.9109 |
| converging-build-test | negative | 0/20 | 0.5123 | 0.5440 | 0.5962 |

## Chosen operating point

window 5 · min_calls 5 · threshold 0.995 · consecutive_windows 2
margin to the nearest flip: 0.0000 (nearest negative 0.9948, nearest positive 0.9950; model resolution floor 0.002)

**No candidate met both PRD §6 targets.** The point below is the best of those that hold the false-positive line; recall is reported as measured, not as hoped.

precision 0.974  recall 0.750  F1 0.847
TP 75  FN 25  FP 2  TN 98  FP-rate 2.0%
detection latency (turns): mean 3.68  p50 3  p95 8  max 8
caught by: rules 60, semantic 15
  verbatim-retry            20/20 tripped
  reworded-retry             0/20 tripped
  error-loop                20/20 tripped
  oscillation               20/20 tripped
  drifting-loop             15/20 tripped
  pagination-sweep           1/20 tripped
  bulk-edit                  1/20 tripped
  try-then-fix               0/20 tripped
  list-traverse-process      0/20 tripped
  converging-build-test      0/20 tripped

## End-to-end verification (real engine, real detector, real provider)

ran 200 sessions in 4809 ms
precision 0.962  recall 0.750  F1 0.843
TP 75  FN 25  FP 3  TN 97  FP-rate 3.0%
detection latency (turns): mean 3.68  p50 3  p95 8  max 8
**2 disagreements** between the sweep model and the engine:
pagination-sweep-10: model said 14, engine said 12
bulk-edit-16: model said null, engine said 6

## The `cursor` exemption

15 of 20 pagination sweeps use a `cursor` argument. With the exemption removed, 15 would lose fingerprint variation entirely and 12 would be halted by R1 at the third page.

## Verdict against PRD §6

- detection ≥ 90%: NOT MET (75.0%)
- false positives < 5%: MET (3.0%)
