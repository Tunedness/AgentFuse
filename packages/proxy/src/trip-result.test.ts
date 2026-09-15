import {
  type Decision,
  FakeClock,
  type Reason,
  type TripCode,
  type TripReport,
} from '@agentfuse/core';
import { describe, expect, it } from 'vitest';
import {
  buildTripResult,
  primaryReason,
  RETRY_WARNING,
  renderTripDiagnostic,
  renderTripText,
  TRIP_META_KEY,
} from './trip-result.js';

/** Every code, so a new one cannot be added without a variant to go with it. */
const ALL_CODES: TripCode[] = [
  'LOOP_EXACT_REPEAT',
  'LOOP_ERROR_REPEAT',
  'LOOP_CYCLE',
  'LOOP_SEMANTIC',
  'BUDGET_TOKENS',
  'BUDGET_USD',
  'BUDGET_DURATION',
  'BUDGET_CALLS',
  'POLICY_DENY',
  'POLICY_APPROVAL',
  'POLICY_WARN',
  'APPROVAL_DENIED',
  'APPROVAL_TIMEOUT',
  'BREAKER_OPEN',
];

/**
 * Evidence shaped exactly as the guard that raises each code produces it.
 *
 * Copied from `packages/core/src/guards/*` on purpose: the refusal text reads
 * these keys by name, so a divergence here is a divergence in the product
 * surface and these snapshots are where it shows up.
 */
const EVIDENCE: Record<TripCode, Record<string, unknown>> = {
  LOOP_EXACT_REPEAT: { count: 3, threshold: 3, idempotent: false, fingerprint: 'a1b2c3d4e5f6' },
  LOOP_ERROR_REPEAT: {
    count: 3,
    threshold: 3,
    errorSignature: 'ENOENT: «path»',
    toolName: 'read_file',
  },
  LOOP_CYCLE: { period: 2, repeats: 2, threshold: 4 },
  LOOP_SEMANTIC: { score: 0.9137, threshold: 0.83, consecutiveWindows: 2, windowSize: 8 },
  BUDGET_TOKENS: {
    dimension: 'tokens',
    value: 412_345,
    limit: 400_000,
    ratio: 1.03,
    estimate: true,
  },
  BUDGET_USD: { dimension: 'usd', value: 5.4217, limit: 5, ratio: 1.08, estimate: true },
  BUDGET_DURATION: { dimension: 'duration', value: 1_801_000, limit: 1_800_000, ratio: 1 },
  BUDGET_CALLS: { dimension: 'calls', value: 200, limit: 200, ratio: 1 },
  POLICY_DENY: { rule: 'tools[2]', match: 'shell__*', key: 'shell__exec' },
  POLICY_APPROVAL: { rule: 'tools[1]', match: 'fs__write*', key: 'fs__write_file' },
  POLICY_WARN: { rule: 'tools[3]', match: 'net__*', key: 'net__fetch' },
  APPROVAL_DENIED: { toolName: 'exec', serverName: 'shell' },
  APPROVAL_TIMEOUT: { timeoutMs: 120_000, onTimeout: 'deny' },
  BREAKER_OPEN: {
    trippedAt: 1_700_000_000_000,
    tripCode: 'LOOP_SEMANTIC',
    cooldownMs: 120_000,
    remainingMs: 95_000,
  },
};

function reason(code: TripCode): Reason {
  return { code, message: `core's own message for ${code}`, evidence: EVIDENCE[code] };
}

function decision(code: TripCode, overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'deny',
    reasons: [reason(code)],
    wouldTrip: false,
    callId: '01J0CALL',
    ...overrides,
  };
}

/** A report shaped like core's, with fixed ids so the snapshots are stable. */
function report(code: TripCode): TripReport {
  return {
    reportVersion: 1,
    kind: 'trip',
    tripId: '01J0TRIP',
    sessionId: '01J0SESSION',
    trippedAt: '2026-09-15T12:00:00.000Z',
    mode: 'enforce',
    trigger: { code, message: `core's own message for ${code}`, evidence: EVIDENCE[code] },
    breaker: { phase: 'open', cooldown: { calls: 3, durationMs: 120_000 } },
    budgets: {
      durationMs: 61_000,
      calls: 12,
      tokensEstimated: {
        args: 400,
        results: 3_200,
        note: 'tool-I/O floor estimate, not LLM usage',
      },
      usdEstimated: 0.0492,
      limits: {
        durationMs: 1_800_000,
        calls: 200,
        tokensEstimated: 400_000,
        usdEstimated: 5,
      },
    },
    recentCalls: [
      {
        id: '01J0C1',
        tool: 'filesystem__read_file',
        fingerprint: 'a1b2c3d4e5f60000',
        isError: false,
        durationMs: 12,
        startedAt: '2026-09-15T11:59:00.000Z',
        argsPreview: '{"path":"/etc/hosts"}',
      },
      {
        id: '01J0C2',
        tool: 'filesystem__read_file',
        fingerprint: 'a1b2c3d4e5f60000',
        isError: false,
        durationMs: 0,
        startedAt: '2026-09-15T12:00:00.000Z',
        argsPreview: '{"path":"/etc/hosts"}',
      },
    ],
    policy: {
      sha256: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      version: 1,
    },
    agentfuse: { version: '0.0.0' },
  };
}

describe('the refusal text', () => {
  it.each(ALL_CODES)('has its own variant for %s', (code) => {
    // Snapshotted per code, because the advice that fits a semantic loop is
    // noise when the session has run out of money. A new TripCode fails the
    // build here until somebody writes it advice.
    expect(renderTripText(reason(code), '.agentfuse/reports/01J0TRIP.json')).toMatchSnapshot();
  });

  it.each(ALL_CODES)('%s says a retry will be blocked too', (code) => {
    // The single load-bearing sentence in the package. Without it the agent
    // retries the circuit breaker in a tight loop and there are now two loops.
    expect(renderTripText(reason(code), undefined)).toContain(RETRY_WARNING);
  });

  it.each(ALL_CODES)('%s offers concrete alternatives, not just a refusal', (code) => {
    const text = renderTripText(reason(code), undefined);

    expect(text).toContain('Do this instead:');
    // Two or three: "stop" is not an instruction a goal-seeking agent can act
    // on, and a list of eight is a wall the model skims.
    expect(text).toMatch(/\n {2}2\. /);
    expect(text).not.toMatch(/\n {2}4\. /);
  });

  it.each(ALL_CODES)('%s stays near the 120-token budget', (code) => {
    const text = renderTripText(reason(code), '.agentfuse/reports/01J0TRIP.json');

    // ~4 characters per token for English prose. Longer crowds the context the
    // agent needs to recover with; the ceiling is deliberately not tight.
    expect(text.length / 4).toBeLessThan(200);
    expect(text.length / 4).toBeGreaterThan(60);
  });

  it('survives a reason with no evidence at all', () => {
    // Every substitution has a fallback: a reason from an `onDecision` hook may
    // carry nothing, and a refusal that reads "undefined calls" is worse than
    // a vague one.
    const text = renderTripText({ code: 'LOOP_EXACT_REPEAT', message: 'hook said so' }, undefined);

    expect(text).not.toContain('undefined');
    expect(text).toContain('several calls');
  });

  it.each(ALL_CODES)('%s never leaks the word undefined when evidence is missing', (code) => {
    expect(renderTripText({ code, message: 'no evidence' }, undefined)).not.toContain('undefined');
  });

  it('names the report path when there is one, and the trip id otherwise', () => {
    expect(renderTripText(reason('BUDGET_CALLS'), '/tmp/r.json')).toContain(
      'Trip report: /tmp/r.json',
    );
    expect(renderTripText(reason('BUDGET_CALLS'), undefined)).not.toContain('Trip report:');
  });
});

describe('primaryReason', () => {
  it('prefers the reason the report names as the trigger', () => {
    // Not the first recorded one: a half-open breaker records BREAKER_OPEN
    // before the budget guard trips, and the budget is what actually broke.
    const picked = primaryReason({
      action: 'deny',
      reasons: [reason('BREAKER_OPEN'), reason('BUDGET_CALLS')],
      wouldTrip: false,
      callId: '01J',
      report: report('BUDGET_CALLS'),
    });

    expect(picked?.code).toBe('BUDGET_CALLS');
  });

  it('falls back to the last reason when there is no report', () => {
    const picked = primaryReason(decision('BREAKER_OPEN'));

    expect(picked?.code).toBe('BREAKER_OPEN');
  });

  it('falls back to the last reason when the report names one that is not listed', () => {
    const picked = primaryReason({
      action: 'deny',
      reasons: [reason('POLICY_DENY')],
      wouldTrip: false,
      callId: '01J',
      report: report('LOOP_SEMANTIC'),
    });

    expect(picked?.code).toBe('POLICY_DENY');
  });

  it('is undefined for a decision with no reasons', () => {
    expect(
      primaryReason({ action: 'allow', reasons: [], wouldTrip: false, callId: '01J' }),
    ).toBeUndefined();
  });
});

describe('buildTripResult', () => {
  it('is an isError result, never a protocol error', () => {
    const result = buildTripResult({ decision: decision('LOOP_SEMANTIC') });

    expect(result.isError).toBe(true);
    // MRTR: a refusal is a *complete* answer, not an input_required round trip
    // for a client driver to auto-fulfil.
    expect(result.resultType).toBe('complete');
  });

  it('carries the machine-readable trip in structuredContent', () => {
    const result = buildTripResult({
      decision: decision('LOOP_SEMANTIC', { report: report('LOOP_SEMANTIC') }),
      reportPath: '.agentfuse/reports/01J0TRIP.json',
    });

    expect(result.structuredContent).toEqual({
      agentfuse: {
        trip: {
          code: 'LOOP_SEMANTIC',
          breaker: 'open',
          windowScore: 0.9137,
          reportId: '01J0TRIP',
          reportPath: '.agentfuse/reports/01J0TRIP.json',
        },
      },
    });
  });

  it('stamps the trip onto _meta under the reserved AgentFuse key', () => {
    const result = buildTripResult({
      decision: decision('BUDGET_USD', { report: report('BUDGET_USD') }),
    });

    expect(result._meta?.[TRIP_META_KEY]).toEqual({ code: 'BUDGET_USD', reportId: '01J0TRIP' });
  });

  it('omits windowScore for a trip that has no score', () => {
    const result = buildTripResult({ decision: decision('BUDGET_CALLS') });
    const trip = (result.structuredContent as { agentfuse: { trip: Record<string, unknown> } })
      .agentfuse.trip;

    expect('windowScore' in trip).toBe(false);
  });

  it('omits reportId and reportPath when there is neither', () => {
    const result = buildTripResult({ decision: decision('POLICY_DENY') });
    const trip = (result.structuredContent as { agentfuse: { trip: Record<string, unknown> } })
      .agentfuse.trip;

    expect(trip).toEqual({ code: 'POLICY_DENY', breaker: 'open' });
    expect(result._meta?.[TRIP_META_KEY]).toEqual({ code: 'POLICY_DENY' });
  });

  it('reads the breaker phase from the report when there is one', () => {
    const withReport = report('LOOP_CYCLE');
    const result = buildTripResult({
      decision: decision('LOOP_CYCLE', {
        report: { ...withReport, breaker: { ...withReport.breaker, phase: 'half_open' } },
      }),
    });
    const trip = (result.structuredContent as { agentfuse: { trip: { breaker: string } } })
      .agentfuse.trip;

    expect(trip.breaker).toBe('half_open');
  });

  it('derives the phase from the action when there is no report', () => {
    const denied = buildTripResult({ decision: decision('BREAKER_OPEN', { action: 'deny' }) });
    const gated = buildTripResult({
      decision: decision('POLICY_APPROVAL', { action: 'require_approval' }),
    });

    expect(
      (denied.structuredContent as { agentfuse: { trip: { breaker: string } } }).agentfuse.trip
        .breaker,
    ).toBe('open');
    expect(
      (gated.structuredContent as { agentfuse: { trip: { breaker: string } } }).agentfuse.trip
        .breaker,
    ).toBe('half_open');
  });

  it('keeps structuredContent object-shaped, so the SDK’s projection is the identity', () => {
    // If it were an array or a primitive, `projectCallToolResult` would append
    // a JSON text block — and on the legacy era wrap it in `{result: …}`. The
    // proxy never calls that function precisely because a forwarded upstream
    // result has already been projected once.
    const result = buildTripResult({ decision: decision('LOOP_SEMANTIC') });

    expect(Array.isArray(result.structuredContent)).toBe(false);
    expect(typeof result.structuredContent).toBe('object');
  });

  it('still explains a block that arrived with no reasons at all', () => {
    // `onDecision` is a public escape hatch and ADR-004 lets a hook raise the
    // action while returning no reasons. Throwing here would hand the agent a
    // JSON-RPC error instead of a refusal it can read — the one failure this
    // whole module exists to prevent.
    const result = buildTripResult({
      decision: { action: 'deny', reasons: [], wouldTrip: false, callId: '01J' },
    });
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? '';

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      agentfuse: { trip: { code: 'POLICY_DENY', breaker: 'open' } },
    });
    expect(text).toContain('will be blocked too');
  });

  it('names the approval variant when the hook asked for approval instead', () => {
    const result = buildTripResult({
      decision: { action: 'require_approval', reasons: [], wouldTrip: false, callId: '01J' },
    });

    expect(result.structuredContent).toMatchObject({
      agentfuse: { trip: { code: 'POLICY_APPROVAL', breaker: 'half_open' } },
    });
  });
});

describe('renderTripDiagnostic', () => {
  it('is core’s renderer, not a second implementation', () => {
    const rendered = renderTripDiagnostic(report('LOOP_SEMANTIC'));

    // Pinned to core's layout deliberately: one renderer means the CLI, the
    // Control Plane and these snapshots cannot drift apart within a release.
    expect(rendered).toContain('AgentFuse · circuit tripped');
    expect(rendered).toContain('tool-I/O floor estimate, not LLM usage');
    expect(rendered).toMatchSnapshot();
  });
});

describe('the FakeClock core ships', () => {
  it('is importable, which is how these fixtures stay deterministic', () => {
    // Guards against core's testing surface moving: the snapshots above use
    // fixed ids and timestamps for the same reason.
    expect(new FakeClock(1_000).now()).toBe(1_000);
  });
});
