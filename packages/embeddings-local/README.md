# @agentfuse/embeddings-local

The optional local embedding backend for
[AgentFuse](https://github.com/tunedness/agentfuse)'s semantic loop detector.
Runs `Xenova/all-MiniLM-L6-v2` (int8) on the CPU through `onnxruntime-node`, so
the content of your tool calls never leaves the machine and embedding costs
nothing per call.

**It is optional, and AgentFuse works without it.** No published AgentFuse
package depends on this one. The CLI looks for it with a dynamic `import()`;
if it is not there, the deterministic loop rules — exact repeats, error
repeats, short cycles — run at full strength. They catch 60 of the 87 loops in
the benchmark corpus on their own.

## Install it deliberately, and know what it costs

```sh
# On linux/x64, do it this way:
ONNXRUNTIME_NODE_INSTALL=skip npm install @agentfuse/embeddings-local
npx agentfuse models install
```

This package is 27 kB. Its dependency is not.

- **`onnxruntime-node` is 113.5 MB compressed, 292 MB unpacked.** It carries
  every platform's binaries in one tarball with no per-platform
  `optionalDependencies` to narrow it. That measurement is the entire reason
  this is a separate package: a 300 MB `npx agentfuse` would end adoption for a
  tool whose pitch is a frictionless drop-in.
- **On linux/x64 its postinstall fetches another 236 MB that AgentFuse never
  loads.** The per-platform manifest asks for `cuda12` there, and those
  binaries are deliberately absent from the npm tarball — so every `npm
  install` pulls `Microsoft.ML.OnnxRuntime.Gpu.Linux` from nuget.org,
  measured at 236,037,232 bytes, outside any npm cache, for a GPU runtime that
  is never touched. **`ONNXRUNTIME_NODE_INSTALL=skip` avoids it and costs
  nothing:** the inference session is pinned to `executionProviders: ['cpu']`,
  because this is a background embedding queue on a developer's machine, not a
  training rig.
- **`@huggingface/tokenizers` is 600 kB with zero dependencies.** The
  alternatives were rejected on measurement:
  `@huggingface/transformers` drags `sharp` into the tree and pins an old ONNX
  runtime; `fastembed` is unmaintained and pinned to ORT 1.21.
- **The model is ~23 MB and is not in the package.** It is downloaded on first
  use, or ahead of time by `agentfuse models install`.

## The model cache

Three files, pinned by revision and sha256:

| File | Bytes |
| --- | --- |
| `onnx/model_quantized.onnx` | 22,972,370 |
| `tokenizer.json` | 711,661 |
| `tokenizer_config.json` | 366 |

They live at
`<cache root>/agentfuse/models/<owner>--<model>/<revision>/<file>`, where the
cache root is the explicit `cacheDir` option, then `AGENTFUSE_CACHE_DIR`, then
`$XDG_CACHE_HOME/agentfuse`, then `~/.cache/agentfuse`. An empty string counts
as unset, so a shell with `export XDG_CACHE_HOME=` does not send the cache to
`/agentfuse`.

The revision is a **directory step**, not part of the filename: re-pinning the
model writes beside the old one rather than over it, so bisecting, downgrading
and two checkouts on one machine keep working.

**The download is written as a gate**, because the bytes on the other end are
about to be handed to a native inference runtime:

1. **`AGENTFUSE_OFFLINE=1` is a wall, not a hint.** It refuses before a socket
   is opened, and names both the variable and the path it wanted. `0` and the
   empty string count as off; every other value is on.
2. **The expected byte count is a ceiling.** A longer body is cut mid-stream by
   an `AbortController` rather than buffered and then rejected, so an endless
   response can neither exhaust memory nor fill the disk.
3. **The temporary file is in the destination directory** with a random
   suffix — same directory so the `rename` is atomic on one filesystem, random
   suffix so two processes downloading the same model each write their own file
   and each rename a *complete* one into place. A reader sees nothing or a
   whole file. No digest check at load time can tell a half-written file from a
   bad network; the rename is what makes the question not arise.
4. **The digest is checked before the rename**, and a mismatch deletes the
   temporary file and throws with both digests. There is no "try anyway" path.

Verification is a **precondition of loading**, not a side effect of
downloading: `ensureModelFiles` verifies every file even when it downloads
nothing. That makes `agentfuse models install` a repair tool too — a cache
corrupted later is caught by the same check, and only the bad file is
re-fetched.

**A model id that is not in the pinned table is refused.** "We have no digest,
so skip verification" is not a gate. The realistic cause is a typo in a policy
file, so the error lists the ids it knows.

**`createEmbeddingProvider` never downloads.** A missing model is an error that
names `agentfuse models install`. Starting a proxy should not quietly become a
23 MB download.

## Public surface

The CLI only ever uses two of these, and their shape is the contract:

```ts
createEmbeddingProvider(options: { model: string }): Promise<EmbeddingProvider>
installModel(options: { model: string; onProgress?(p: InstallProgress): void }): Promise<InstallResult>
```

The rest is exported because the pieces are testable and occasionally useful on
their own:

- **Models:** `DEFAULT_MODEL` · `KNOWN_MODELS` · `modelSpec` · `urlOf` ·
  `ModelSpec` · `ModelFile`
- **Cache:** `cacheRoot` · `modelDir` · `filePath` · `sha256File` ·
  `verifyFile` · `Env` · `FileVerdict`
- **Download:** `downloadFile` · `isOffline` · `DownloadError` · `OFFLINE_ENV` ·
  `DownloadProgress` · `FetchLike`
- **Install:** `ensureModelFiles` · `installModel` · `InstallOptions` ·
  `InstallResult` · `InstallProgress` · `EnsureOptions`
- **Inference:** `openSession` · `defaultThreads` · `packBatch` · `meanPool` ·
  `LocalEmbeddingProvider` · `EmbeddingSession` · `SessionOptions` ·
  `EncodedBatch` · `Encoding` · `SpecialTokens` · `ProviderParts` · `Tokenizing`
- `BACKEND_ID` (`'local'`, the value of `loop_detection.semantic.provider` that
  selects this backend) · `EMBEDDINGS_LOCAL_VERSION`

`session.ts` is the only file that touches `onnxruntime-node` and `create.ts`
the only one that touches `@huggingface/tokenizers`, both behind dynamic
imports. So importing this package loads no native code and no model —
which is what lets the CLI import it just to answer "is the backend installed?".

## The one place this could be silently wrong

**Mean pooling over `last_hidden_state` with the attention mask applied, then
L2 normalisation.** That is what this checkpoint's sentence-transformers
configuration specifies. The obvious-looking alternative —
`last_hidden_state[:, 0]`, the `[CLS]` position — produces 384 finite,
unit-length, **meaningless** numbers, because this checkpoint's `[CLS]` was
never trained as a sentence representation. In a world where every test checks
shapes, that mistake passes, and a threshold gets calibrated against noise.

The load-bearing line is applying the mask to the sum, not the division by the
token count: L2 normalisation follows immediately, and scaling by a positive
constant does not change direction, so mean and sum pooling give the same unit
vector. The division stays because it is part of the recipe.

**L2 normalisation is not decoration.** The window score
`(‖S‖² − W) / (W · (W − 1))` is the mean pairwise cosine *only* on unit
vectors. Every output's norm is pinned by a test, against both the fake session
and the real model.

Truncation keeps the trailing `[SEP]`, and `maxTokens` is **256**, not 512 —
that is the `max_seq_length` this model was trained with.

## Two measurements worth carrying

**Quantisation is batch-sensitive.** `model_quantized.onnx` is *dynamically*
quantised: the activation scale derives from the whole input tensor, so one
text embedded alongside different neighbours comes back slightly differently.
Worst measured: cosine **0.9983** between the same text alone and in a batch of
six. Within one batch, identical input is bit-identical. **So a score computed
on these vectors has a meaning floor of ±0.002**, and thresholds are not
calibrated finer than that. Avoiding it would mean an fp32 export (~90 MB).

**Latency, on an M-series laptop with 4 threads:** opening a session 75 ms
(including the sha256 of 23 MB and graph optimisation), a batch of eight
10.7 ms. Neither is on the hot path — `session.run` is awaited, not run
synchronously, so ONNX does the work on a libuv worker while the JSON-RPC
frames keep moving.

## License

Apache-2.0
