import { describe, expect, it } from 'vitest';
import * as proxy from './index.js';

describe('@agentfuse/proxy public surface', () => {
  it('exposes a contract version', () => {
    expect(proxy.PROXY_VERSION).toBe('0.0.0');
  });

  it('exposes the two serving entries and the layer under them', () => {
    expect(typeof proxy.wrapStdioServer).toBe('function');
    expect(typeof proxy.createBridge).toBe('function');
    expect(typeof proxy.createToolCallGuard).toBe('function');
  });

  it('exposes the trip surface the agent and the operator see', () => {
    expect(typeof proxy.buildTripResult).toBe('function');
    expect(typeof proxy.renderTripText).toBe('function');
    expect(typeof proxy.renderTripDiagnostic).toBe('function');
    expect(proxy.TRIP_META_KEY).toBe('io.tunedness.agentfuse/trip');
    expect(proxy.RETRY_WARNING).toContain('will be blocked too');
  });

  it('exposes the era and session-identity vocabulary', () => {
    expect(proxy.FIRST_MODERN_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(proxy.SESSION_BAGGAGE_KEY).toBe('tunedness.session-id');
    expect(typeof proxy.SessionKeyResolver).toBe('function');
  });

  it('no longer exports the phase-1 ToolCall stopgap', () => {
    // It was a four-field placeholder declared locally so the scaffold did not
    // depend on a type core had not frozen yet. Core froze `BeforeCallInput` in
    // phase 2; keeping a second shape alive would guarantee they drift.
    expect('toToolCall' in proxy).toBe(false);
    expect('ToolCall' in proxy).toBe(false);
  });
});
