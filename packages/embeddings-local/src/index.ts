/**
 * Local, on-device embedding backend for AgentFuse semantic loop detection.
 *
 * This package is deliberately a leaf that nothing imports statically. The CLI
 * reaches it through `await import('@agentfuse/embeddings-local')` only when the
 * operator selects the local backend, so installing AgentFuse does not drag a
 * few hundred megabytes of ONNX runtime binaries onto every machine.
 */

/** Identifier of the backend, as it appears in an AgentFuse config file. */
export const BACKEND_ID = 'local';

/**
 * Port the loop detector talks to.
 *
 * TODO(phase-4): this mirrors the port type that will live in
 * `@agentfuse/core`. It is declared locally for now because this package has no
 * dependencies yet; phase 4 replaces it with an import from `@agentfuse/core`
 * and implements it on top of onnxruntime-node plus @huggingface/tokenizers.
 */
export interface EmbeddingBackend {
  /** Stable name of the backend, for logs and config round-tripping. */
  readonly id: string;
  /** Dimensionality of the vectors {@link EmbeddingBackend.embed} returns. */
  readonly dimensions: number;
  /** Embeds a batch of texts, preserving input order. */
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

/**
 * Describes the backend without loading a model.
 *
 * Lets the CLI list and validate available backends cheaply; actually creating
 * one costs a model download and several hundred milliseconds of warm-up.
 */
export function describeBackend(): Pick<EmbeddingBackend, 'id' | 'dimensions'> {
  // TODO(phase-4): report the real model's dimensions once it is wired up.
  return { id: BACKEND_ID, dimensions: 384 };
}
