import { describe, expect, it } from 'vitest';
import { PROXY_VERSION, toToolCall } from './index.js';

describe('@agentfuse/proxy', () => {
  it('exposes a version', () => {
    expect(PROXY_VERSION).toBe('0.0.0');
  });

  it('translates MCP tools/call params into a core ToolCall', () => {
    const call = toToolCall({ name: 'filesystem.read_file', arguments: { path: '/tmp/a' } }, 1_700);

    expect(call).toEqual({
      toolName: 'filesystem.read_file',
      arguments: { path: '/tmp/a' },
      calledAt: 1_700,
    });
  });

  it('treats missing arguments as an empty object', () => {
    expect(toToolCall({ name: 'clock.now' }, 0).arguments).toEqual({});
  });
});
