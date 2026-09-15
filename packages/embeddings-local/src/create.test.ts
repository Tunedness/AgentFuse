import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmbeddingProvider, specialTokensOf } from './create.js';
import { OFFLINE_ENV } from './download.js';

/**
 * The factory's refusals, none of which reach the runtime or the network.
 * `model.test.ts` covers what it does when it succeeds.
 */

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentfuse-create-'));
  temporary.push(dir);
  return dir;
}

describe('createEmbeddingProvider', () => {
  it('refuses a model it has no pinned digest for', async () => {
    await expect(
      createEmbeddingProvider({ model: 'sentence-transformers/whatever' }),
    ).rejects.toThrow(/unknown embedding model/);
  });

  it('refuses a model that is not cached, and names the command that fetches it', async () => {
    // Deliberately not a download. Starting a proxy must not silently turn
    // into a 23 MB fetch in the middle of somebody's agent run, which is why
    // the CLI's own message for this case says `agentfuse models install`.
    await expect(
      createEmbeddingProvider({ model: 'Xenova/all-MiniLM-L6-v2', cacheDir: await scratch() }),
    ).rejects.toThrow(/agentfuse models install/);
  });

  it('says the same thing when downloads are off, rather than something obscure', async () => {
    await expect(
      createEmbeddingProvider({
        model: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: await scratch(),
        env: { [OFFLINE_ENV]: '1' },
      }),
    ).rejects.toThrow(/agentfuse models install/);
  });
});

describe('specialTokensOf', () => {
  const vocabulary = (ids: Record<string, number>) => ({
    token_to_id: (token: string): number | undefined => ids[token],
  });

  it('reads [SEP] and [PAD] out of the vocabulary', () => {
    expect(specialTokensOf(vocabulary({ '[SEP]': 102, '[PAD]': 0 }), 'fixture')).toEqual({
      sep: 102,
      pad: 0,
    });
  });

  it.each(['[SEP]', '[PAD]'])('refuses a tokenizer with no %s', (missing) => {
    const ids: Record<string, number> = { '[SEP]': 102, '[PAD]': 0 };
    delete ids[missing];

    // Without these two there is no correct way to truncate a long text or to
    // pad a short one, and guessing an id would feed the encoder a token it
    // never saw.
    expect(() => specialTokensOf(vocabulary(ids), 'fixture')).toThrow(/no \[SEP\]\/\[PAD\]/);
  });
});
