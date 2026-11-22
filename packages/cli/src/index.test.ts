import { CORE_VERSION } from '@tunedness/agentfuse-core';
import { PROXY_VERSION } from '@tunedness/agentfuse-proxy';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION, versionBanner } from './index.js';

describe('agentfuse', () => {
  it('reports the versions of the packages it shipped with', () => {
    expect(versionBanner()).toBe(
      `agentfuse ${CLI_VERSION} (core ${CORE_VERSION}, proxy ${PROXY_VERSION})`,
    );
  });
});
