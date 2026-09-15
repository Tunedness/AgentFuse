import { describe, expect, it } from 'vitest';
import type { EncodedBatch, Encoding } from './batch.js';
import { KNOWN_MODELS, type ModelSpec } from './models.js';
import { LocalEmbeddingProvider, type Tokenizing } from './provider.js';
import type { EmbeddingSession } from './session.js';

/**
 * The provider is exercised against a fake tokenizer and a fake session, which
 * is the point of those two seams: batching, truncation, pooling, the closed
 * state and every error path are pinned by a run that downloads nothing and
 * loads no native code. `model.test.ts` covers the same provider over the real
 * model, and skips when it is not in the cache.
 */

const SPEC: ModelSpec = {
  ...(KNOWN_MODELS['Xenova/all-MiniLM-L6-v2'] as ModelSpec),
  dims: 4,
  maxTokens: 6,
};

/** One id per character, so an assertion can talk about the text it came from. */
const tokenizer: Tokenizing = {
  encode(text: string): Encoding {
    const ids = [101, ...[...text].map((character) => character.codePointAt(0) ?? 0), 102];
    return { ids, attention_mask: ids.map(() => 1), token_type_ids: ids.map(() => 0) };
  },
};

interface Recorded {
  readonly session: EmbeddingSession;
  readonly batches: EncodedBatch[];
  closed: number;
}

/**
 * A session whose hidden state is a deterministic function of the token ids, so
 * the vectors that come out are checkable without being meaningful.
 */
function fakeSession(dims = SPEC.dims): Recorded {
  const batches: EncodedBatch[] = [];
  const recorded: Recorded = {
    batches,
    closed: 0,
    session: {
      async run(batch: EncodedBatch): Promise<Float32Array> {
        batches.push(batch);
        const out = new Float32Array(batch.rows * batch.length * dims);
        for (let i = 0; i < batch.rows * batch.length; i += 1) {
          const id = Number(batch.ids[i]);
          for (let k = 0; k < dims; k += 1) out[i * dims + k] = ((id + k) % 17) - 8;
        }
        return out;
      },
      async close(): Promise<void> {
        recorded.closed += 1;
      },
    },
  };
  return recorded;
}

function provider(recorded: Recorded, spec: ModelSpec = SPEC): LocalEmbeddingProvider {
  return new LocalEmbeddingProvider({
    spec,
    tokenizer,
    session: recorded.session,
    special: { sep: 102, pad: 0 },
  });
}

function norm(vector: Float32Array): number {
  let total = 0;
  for (const value of vector) total += value * value;
  return Math.sqrt(total);
}

describe('LocalEmbeddingProvider', () => {
  it('reports the model it was built from', () => {
    const instance = provider(fakeSession());
    expect(instance.id).toBe('local:all-MiniLM-L6-v2');
    expect(instance.dims).toBe(4);
  });

  it('returns one unit vector per text, in order', async () => {
    const vectors = await provider(fakeSession()).embed(['alpha', 'beta', 'gamma']);

    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(4);
      // Core's port says vectors MUST be L2-normalised, and phase 3's
      // closed-form window score is only the mean pairwise cosine if they are.
      expect(norm(vector)).toBeCloseTo(1, 6);
    }
  });

  it('runs one graph execution for the whole batch', async () => {
    // Phase 3's queue hands over up to eight texts at a time precisely so this
    // is one crossing into the runtime rather than eight.
    const recorded = fakeSession();
    await provider(recorded).embed(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    expect(recorded.batches).toHaveLength(1);
    expect(recorded.batches[0]?.rows).toBe(8);
  });

  it('never touches the session for an empty batch', async () => {
    const recorded = fakeSession();
    await expect(provider(recorded).embed([])).resolves.toEqual([]);
    expect(recorded.batches).toEqual([]);
  });

  it('truncates a long text to the model maximum before it reaches the runtime', async () => {
    const recorded = fakeSession();
    await provider(recorded).embed(['abcdefghijklmnop']);

    expect(recorded.batches[0]?.length).toBe(SPEC.maxTokens);
    const ids = [...(recorded.batches[0]?.ids ?? [])].map(Number);
    expect(ids.at(-1)).toBe(102);
  });

  it('embeds the same text to the same vector', async () => {
    const instance = provider(fakeSession());
    const [first] = await instance.embed(['github__search_issues']);
    const [second] = await instance.embed(['github__search_issues']);

    expect([...(first as Float32Array)]).toEqual([...(second as Float32Array)]);
  });

  it('closes the session once, however often it is asked', async () => {
    const recorded = fakeSession();
    const instance = provider(recorded);

    await instance.close();
    await instance.close();

    expect(recorded.closed).toBe(1);
  });

  it('refuses to embed after it has been closed', async () => {
    const instance = provider(fakeSession());
    await instance.close();

    // The alternative is handing a released native session to the runtime,
    // which is a segfault rather than an exception.
    await expect(instance.embed(['anything'])).rejects.toThrow(/has been closed/);
  });

  it('rejects a hidden state of the wrong size instead of reading past it', async () => {
    const recorded = fakeSession(3);
    await expect(provider(recorded).embed(['alpha'])).rejects.toThrow(/expected/);
  });

  it('propagates a runtime failure rather than inventing vectors', async () => {
    const recorded = fakeSession();
    const failing: EmbeddingSession = {
      run: async () => {
        throw new Error('onnxruntime exploded');
      },
      close: recorded.session.close.bind(recorded.session),
    };
    const instance = new LocalEmbeddingProvider({
      spec: SPEC,
      tokenizer,
      session: failing,
      special: { sep: 102, pad: 0 },
    });

    // Phase 3 turns a rejected `embed` into `degraded: 'unavailable'`, which is
    // a truthful report. A provider that swallowed this and returned zeros
    // would make the detector score noise and call it a measurement.
    await expect(instance.embed(['alpha'])).rejects.toThrow('onnxruntime exploded');
  });
});
