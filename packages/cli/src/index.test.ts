import { describe, expect, it } from 'vitest';
import { CLI_VERSION, versionBanner } from './index.js';

describe('agentfuse', () => {
  it('reports the versions of the packages it shipped with', () => {
    expect(versionBanner()).toBe(`agentfuse ${CLI_VERSION} (core 0.0.0, proxy 0.0.0)`);
  });
});
