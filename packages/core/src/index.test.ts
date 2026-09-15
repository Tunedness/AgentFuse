import { describe, expect, it } from 'vitest';
import { CORE_VERSION, parseToolCall } from './index.js';
import { DEFAULT_POLICY_DECISION, isPolicyDecision } from './policy/index.js';

describe('@agentfuse/core', () => {
  it('exposes a contract version', () => {
    expect(CORE_VERSION).toBe('0.0.0');
  });

  it('parses a tool call and defaults its arguments', () => {
    const call = parseToolCall({ toolName: 'filesystem.read_file', calledAt: 0 });

    expect(call.toolName).toBe('filesystem.read_file');
    expect(call.arguments).toEqual({});
  });

  it('rejects a tool call without a name', () => {
    expect(() => parseToolCall({ toolName: '', calledAt: 0 })).toThrow();
  });

  it('defaults to allowing unmatched tools', () => {
    expect(DEFAULT_POLICY_DECISION).toBe('allow');
    expect(isPolicyDecision(DEFAULT_POLICY_DECISION)).toBe(true);
    expect(isPolicyDecision('explode')).toBe(false);
  });
});
