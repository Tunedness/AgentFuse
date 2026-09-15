import { describe, expect, it } from 'vitest';
import { BACKEND_ID, describeBackend } from './index.js';

describe('@agentfuse/embeddings-local', () => {
  it('describes itself without loading a model', () => {
    expect(describeBackend()).toEqual({ id: BACKEND_ID, dimensions: 384 });
  });
});
