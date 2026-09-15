import { describe, expect, it } from 'vitest';
import * as core from './index.js';
import * as policy from './policy/index.js';
import * as testing from './testing.js';

describe('@agentfuse/core public surface', () => {
  it('exposes a contract version', () => {
    expect(core.CORE_VERSION).toBe('0.0.0');
  });

  it('exposes the engine and the pieces a host needs to drive it', () => {
    for (const name of [
      'FuseEngine',
      'parsePolicy',
      'compilePolicy',
      'buildTripReport',
      'renderTripReport',
      'normalizeArgs',
      'fingerprint',
      'errorSignature',
      'applyBreakerEvent',
      'InMemorySessionStore',
      'SystemClock',
      'UlidGenerator',
      'HeuristicTokenizer',
      'TableCostModel',
      'NoopTelemetrySink',
      'DenyAllApprovalGateway',
    ]) {
      expect(core, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it('exposes the asynchronous semantic layer', () => {
    for (const name of [
      'EmbeddingWindow',
      'EmbeddingQueue',
      'SemanticLoopDetector',
      'attachSemanticLoopDetector',
      'semanticEmbeddingText',
    ]) {
      expect(core, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it('re-exports the policy surface on its own subpath', () => {
    expect(policy.parsePolicy).toBe(core.parsePolicy);
    expect(policy.FusePolicySchemaV1).toBe(core.FusePolicySchemaV1);
  });

  it('keeps the test doubles on a separate subpath', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'CounterIdGenerator',
      'FakeClock',
      'HashingProvider',
      'RecordingTelemetrySink',
      'ScriptedApprovalGateway',
    ]);
  });

  it('exposes the approval record’s vocabulary, so a host can read one', () => {
    // ADR-009: the answer a human gave travels on the decision and into the
    // report, so the cap and the sanitiser are part of the contract.
    expect(core.APPROVAL_REASON_LIMIT).toBe(500);
    expect(typeof core.sanitizeFreeText).toBe('function');
  });

  it('names the loop and budget code groups', () => {
    expect(core.LOOP_CODES).toContain('LOOP_SEMANTIC');
    expect(core.BUDGET_CODES).toContain('BUDGET_USD');
    expect(core.initialBreakerState()).toEqual({ phase: 'closed', approvedSinceHalfOpen: 0 });
  });
});
