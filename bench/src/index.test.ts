import { describe, expect, it } from 'vitest';
import { repeatedCallScenario } from './index.js';

describe('@agentfuse/bench', () => {
  it('builds a scenario of the requested size', () => {
    const scenario = repeatedCallScenario(3);

    expect(scenario.name).toBe('repeated-call-3');
    expect(scenario.calls).toHaveLength(3);
    expect(scenario.calls[0]?.toolName).toBe('read_file');
  });

  it('keeps every call in one session, so the loop rules can see the repeat', () => {
    const scenario = repeatedCallScenario(4);
    const sessions = new Set(scenario.calls.map((call) => call.sessionId));

    expect(sessions.size).toBe(1);
  });
});
