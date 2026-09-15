/**
 * The models this package will load, pinned file by file.
 *
 * Everything here is a constant on purpose. A model is a few tens of megabytes
 * of someone else's bytes that this process is about to hand to a native
 * inference runtime, so the only safe posture is: we know exactly which bytes
 * we asked for, and we check them before anyone touches them.
 *
 * Three things are pinned rather than resolved at runtime:
 *
 * - **The revision.** Hugging Face's `main` is a moving branch. The URL carries
 *   a commit sha, so re-running the download a year from now fetches the same
 *   artefact the sha256 below was taken from.
 * - **The digest.** Checked after the download and again before the file is
 *   opened by the runtime, so a corrupted cache is caught as well as a
 *   corrupted download.
 * - **The byte count.** It is the download's size bound — a response longer
 *   than the pin is aborted mid-stream rather than buffered and then rejected —
 *   and it is what makes a truncated file impossible to mistake for a complete
 *   one even before the digest is computed.
 *
 * A model id that is not in this table is refused. "Verify, unless we happen to
 * have no digest for it" is not a gate, and silently running an unverified
 * graph would be the exact failure this table exists to prevent.
 */

/** One file of a model: where it comes from, and what it must be. */
export interface ModelFile {
  /** Path inside the Hugging Face repo. */
  readonly repoPath: string;
  /** File name in the cache directory. Basename of {@link repoPath}. */
  readonly name: string;
  /** Lowercase hex sha256 of the exact bytes. */
  readonly sha256: string;
  /** Exact size. Also the download's hard cap. */
  readonly bytes: number;
}

/** A model this package knows how to fetch and run. */
export interface ModelSpec {
  /** The id as it appears in `loop_detection.semantic.model`. */
  readonly id: string;
  /** The `id` an {@link EmbeddingProvider} built from this reports. */
  readonly providerId: string;
  /** Git revision of the Hugging Face repo the files were pinned from. */
  readonly revision: string;
  /** Vector width. */
  readonly dims: number;
  /**
   * Token budget per text, special tokens included.
   *
   * 256 rather than the 512 the ONNX graph accepts: `all-MiniLM-L6-v2` was
   * trained by sentence-transformers with `max_seq_length: 256`, and feeding it
   * longer sequences produces embeddings from positions it never learned to
   * pool. Overlong texts are truncated to 256 with the final `[SEP]` kept.
   */
  readonly maxTokens: number;
  readonly onnx: ModelFile;
  readonly tokenizer: ModelFile;
  readonly tokenizerConfig: ModelFile;
}

/** Every file of a spec, in the order {@link installModel} fetches them. */
export function filesOf(spec: ModelSpec): readonly ModelFile[] {
  // Tokenizer first: it is a thousandth of the download and it is the file that
  // proves the network path works, so a bad proxy or a 403 costs a second
  // rather than the whole 23 MB.
  return [spec.tokenizerConfig, spec.tokenizer, spec.onnx];
}

/**
 * `Xenova/all-MiniLM-L6-v2`, int8.
 *
 * ADR-003 chose it: 384 dimensions, ~23 MB quantized, and the
 * sentence-transformers recipe behind it is the one the pooling in
 * `provider.ts` implements. The unquantized export is four times the size for
 * a difference the detector cannot see.
 */
const ALL_MINILM_L6_V2: ModelSpec = {
  id: 'Xenova/all-MiniLM-L6-v2',
  providerId: 'local:all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dims: 384,
  maxTokens: 256,
  onnx: {
    repoPath: 'onnx/model_quantized.onnx',
    name: 'model_quantized.onnx',
    sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
    bytes: 22_972_370,
  },
  tokenizer: {
    repoPath: 'tokenizer.json',
    name: 'tokenizer.json',
    sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
    bytes: 711_661,
  },
  tokenizerConfig: {
    repoPath: 'tokenizer_config.json',
    name: 'tokenizer_config.json',
    sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    bytes: 366,
  },
};

/** Every model this build can load, keyed by the id a policy writes. */
export const KNOWN_MODELS: Readonly<Record<string, ModelSpec>> = {
  [ALL_MINILM_L6_V2.id]: ALL_MINILM_L6_V2,
};

/** The model used when nothing names one. Matches the CLI's `DEFAULT_MODEL`. */
export const DEFAULT_MODEL = ALL_MINILM_L6_V2.id;

/** Where the files are fetched from. */
export const HUGGINGFACE_HOST = 'https://huggingface.co';

/** The pinned URL of one file. */
export function urlOf(spec: ModelSpec, file: ModelFile): string {
  return `${HUGGINGFACE_HOST}/${spec.id}/resolve/${spec.revision}/${file.repoPath}`;
}

/**
 * Looks a model up.
 *
 * @throws {Error} naming the models that are known, because the realistic
 * cause is a typo in a policy file and a list is a better answer than a
 * rejection.
 */
export function modelSpec(id: string): ModelSpec {
  const spec = KNOWN_MODELS[id];
  if (spec === undefined) {
    const known = Object.keys(KNOWN_MODELS).join(', ');
    throw new Error(
      `unknown embedding model ${JSON.stringify(id)}; this build pins ${known}. ` +
        'Models are pinned by revision and sha256 so the downloaded bytes can be verified ' +
        'before they are loaded, which is why an arbitrary id cannot be accepted.',
    );
  }
  return spec;
}
