import { describe, expect, it } from 'vitest';
import { DenyAllApprovalGateway, ScriptedApprovalGateway } from './adapters/approval.js';
import { FakeClock } from './adapters/clock.js';
import { RecordingTelemetrySink } from './adapters/telemetry.js';
import { CounterIdGenerator } from './adapters/ulid.js';
import type { CallOutcome, Decision, TripCode } from './domain/index.js';
import { FuseEngine } from './engine.js';
import { parsePolicy } from './policy/compile.js';
import type { ApprovalGateway } from './ports/index.js';

const SESSION = 'session-1';

interface Harness {
  engine: FuseEngine;
  clock: FakeClock;
  telemetry: RecordingTelemetrySink;
}

function harness(document: Record<string, unknown> = {}, approvals?: ApprovalGateway): Harness {
  const clock = new FakeClock();
  const telemetry = new RecordingTelemetrySink();
  const engine = new FuseEngine(parsePolicy({ version: 1, ...document }), {
    clock,
    ids: new CounterIdGenerator(),
    telemetry,
    ...(approvals ? { approvals } : undefined),
  });
  return { engine, clock, telemetry };
}

const OK: CallOutcome = { isError: false, resultSummary: 'ok', resultBytes: 2 };

function failure(signature: string): CallOutcome {
  return { isError: true, errorSignature: signature, resultSummary: 'boom', resultBytes: 4 };
}

/** Runs one call end to end and returns the decision. */
async function call(
  h: Harness,
  args: unknown,
  options: { tool?: string; outcome?: CallOutcome; advanceMs?: number } = {},
): Promise<Decision> {
  const decision = await h.engine.beforeCall({
    sessionId: SESSION,
    serverName: 'fs',
    toolName: options.tool ?? 'read_file',
    args,
  });
  h.clock.advance(options.advanceMs ?? 5);
  if (decision.action !== 'deny') h.engine.afterCall(decision.callId, options.outcome ?? OK);
  return decision;
}

function codes(decision: Decision): TripCode[] {
  return decision.reasons.map((reason) => reason.code);
}

describe('acceptance A — enforce mode halts a three-call loop', () => {
  it('trips on the third identical call and denies everything after', async () => {
    const h = harness({ mode: 'enforce' });

    const first = await call(h, { path: '/a' });
    expect(first.action).toBe('allow');
    expect(first.wouldTrip).toBe(false);

    const second = await call(h, { path: '/a' });
    expect(second.action).toBe('allow');

    const third = await call(h, { path: '/a' });
    expect(third.action).toBe('deny');
    expect(codes(third)).toContain('LOOP_EXACT_REPEAT');
    expect(third.report).toBeDefined();
    expect(third.report?.trigger.code).toBe('LOOP_EXACT_REPEAT');
    expect(third.report?.breaker.phase).toBe('open');
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('open');

    const fourth = await call(h, { path: '/a' });
    expect(fourth.action).toBe('deny');
    expect(codes(fourth)).toEqual(['BREAKER_OPEN']);
    expect(fourth.report).toBeUndefined();
  });

  it('reports the loop through telemetry as enforced', async () => {
    const h = harness({ mode: 'enforce' });
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });

    const loops = h.telemetry.ofType('loop_detection');
    expect(loops).toHaveLength(1);
    expect(loops[0]?.enforced).toBe(true);
    expect(loops[0]?.threshold).toBe(3);
  });
});

describe('acceptance B — warn mode measures instead of breaking', () => {
  it('forwards every call, flags the ones enforce would have stopped', async () => {
    const h = harness();

    const first = await call(h, { path: '/a' });
    const second = await call(h, { path: '/a' });
    expect([first.action, second.action]).toEqual(['allow', 'allow']);
    expect([first.wouldTrip, second.wouldTrip]).toEqual([false, false]);

    const third = await call(h, { path: '/a' });
    expect(third.action).toBe('warn');
    expect(third.wouldTrip).toBe(true);
    expect(codes(third)).toContain('LOOP_EXACT_REPEAT');
    expect(third.report).toBeDefined();
    expect(third.report?.mode).toBe('warn');

    // The machine still runs underneath: the breaker really did open, the call
    // was just forwarded anyway. That is what makes a warn-mode run a usable
    // measurement of the false-positive rate.
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('open');

    const fourth = await call(h, { path: '/a' });
    expect(fourth.action).toBe('warn');
    expect(fourth.wouldTrip).toBe(true);
    expect(codes(fourth)).toEqual(['BREAKER_OPEN']);
  });

  it('records the loop as not enforced', async () => {
    const h = harness();
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    expect(h.telemetry.ofType('loop_detection')[0]?.enforced).toBe(false);
  });
});

describe('loop rules', () => {
  it('R1 doubles the threshold for a rule declared idempotent', async () => {
    const h = harness({
      mode: 'enforce',
      tools: [{ match: '*', action: 'allow', idempotent: true }],
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await call(h, { path: '/a' })).action).toBe('allow');
    }
    expect((await call(h, { path: '/a' })).action).toBe('deny');
  });

  it('R1 ignores a server idempotency hint unless the policy trusts hints', async () => {
    /** Repeats an identical hinted call and returns each decision's action. */
    async function hinted(h: Harness, times: number): Promise<string[]> {
      const actions: string[] = [];
      for (let i = 0; i < times; i += 1) {
        const decision = await h.engine.beforeCall({
          sessionId: SESSION,
          serverName: 'fs',
          toolName: 'read_file',
          args: { path: '/a' },
          annotations: { idempotentHint: true },
        });
        actions.push(decision.action);
        if (decision.action !== 'deny') h.engine.afterCall(decision.callId, OK);
        h.clock.advance(5);
      }
      return actions;
    }

    // The server says "repeating me is safe". By default that claim buys it
    // nothing: the server is the thing being metered.
    expect(await hinted(harness({ mode: 'enforce' }), 3)).toEqual(['allow', 'allow', 'deny']);

    const trusting = harness({ mode: 'enforce', annotations: { trust_hints: true } });
    expect(await hinted(trusting, 5)).toEqual(['allow', 'allow', 'allow', 'allow', 'allow']);
    expect((await hinted(trusting, 1))[0]).toBe('deny');
  });

  it('R2 trips when the same tool keeps failing the same way', async () => {
    const h = harness({ mode: 'enforce' });
    for (const path of ['/a', '/b', '/c']) {
      const decision = await call(h, { path }, { outcome: failure('code:ENOENT') });
      expect(decision.action).toBe('allow');
    }
    const fourth = await call(h, { path: '/d' });
    expect(fourth.action).toBe('deny');
    expect(codes(fourth)).toContain('LOOP_ERROR_REPEAT');
  });

  it('R2 does not punish an agent that switches tools after failing', async () => {
    const h = harness({ mode: 'enforce' });
    for (const path of ['/a', '/b', '/c']) {
      await call(h, { path }, { outcome: failure('code:ENOENT') });
    }
    expect((await call(h, { path: '/d' }, { tool: 'list_dir' })).action).toBe('allow');
  });

  it('R2 needs the same error, not just any error', async () => {
    const h = harness({ mode: 'enforce' });
    await call(h, { path: '/a' }, { outcome: failure('code:ENOENT') });
    await call(h, { path: '/b' }, { outcome: failure('code:EACCES') });
    await call(h, { path: '/c' }, { outcome: failure('code:ENOENT') });
    expect((await call(h, { path: '/d' })).action).toBe('allow');
  });

  it('R3 catches A-B-A-B before either half reaches the repeat threshold', async () => {
    const h = harness({ mode: 'enforce' });
    await call(h, { path: '/a' });
    await call(h, { path: '/b' });
    await call(h, { path: '/a' });
    const fourth = await call(h, { path: '/b' });
    expect(fourth.action).toBe('deny');
    expect(codes(fourth)).toContain('LOOP_CYCLE');
    expect(fourth.reasons[0]?.evidence?.period).toBe(2);
  });

  it('paging through results is progress, not a loop', async () => {
    const h = harness({ mode: 'enforce' });
    for (const cursor of ['a1b2c3d4e5f60718', 'b2c3d4e5f6071829', 'c3d4e5f60718293a', null]) {
      const decision = await call(h, { path: '/docs', cursor }, { tool: 'list_dir' });
      expect(decision.action).toBe('allow');
    }
  });
});

describe('policy rules', () => {
  it('denies a matched rule and stops the chain', async () => {
    const h = harness({
      mode: 'enforce',
      tools: [{ match: 'fs__read_file', action: 'deny', note: 'no reads' }],
    });
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('deny');
    expect(decision.matchedRule).toBe('tools[0]');
    expect(codes(decision)).toEqual(['POLICY_DENY']);
    expect(decision.reasons[0]?.message).toContain('no reads');
  });

  it('flags a warn rule without stopping the call', async () => {
    const h = harness({ mode: 'enforce', tools: [{ match: '*', action: 'warn' }] });
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('warn');
    expect(decision.wouldTrip).toBe(false);
    expect(codes(decision)).toEqual(['POLICY_WARN']);
  });
});

describe('budgets', () => {
  it('announces 50, 80 and 100 percent exactly once per dimension', async () => {
    const h = harness({
      mode: 'enforce',
      budgets: { max_calls: 10, on_exceeded: 'warn' },
      loop_detection: { on_trip: 'warn' },
    });
    for (let i = 0; i < 14; i += 1) await call(h, { i });

    const events = h.telemetry.ofType('budget_event').filter((e) => e.dimension === 'calls');
    expect(events.map((e) => Math.round(e.ratio * 100) / 100)).toEqual([0.5, 0.8, 1]);
  });

  it('halts the session when the policy says so', async () => {
    const h = harness({
      mode: 'enforce',
      budgets: { max_calls: 2, on_exceeded: 'halt' },
    });
    await call(h, { i: 1 });
    await call(h, { i: 2 });
    const third = await call(h, { i: 3 });
    expect(third.action).toBe('deny');
    expect(codes(third)).toContain('BUDGET_CALLS');
    expect(third.report?.trigger.code).toBe('BUDGET_CALLS');
    expect(third.report?.budgets.tokensEstimated.note).toContain('not LLM usage');
  });

  it('meters wall clock, not summed tool time', async () => {
    const h = harness({ mode: 'enforce', budgets: { max_duration: '1m', on_exceeded: 'halt' } });
    await call(h, { i: 1 });
    h.clock.advance(60_000);
    const decision = await call(h, { i: 2 });
    expect(codes(decision)).toContain('BUDGET_DURATION');
  });

  it('asks for a human when the policy says require_approval', async () => {
    const gateway = new ScriptedApprovalGateway('approved');
    const h = harness(
      { mode: 'enforce', budgets: { max_calls: 1, on_exceeded: 'require_approval' } },
      gateway,
    );
    await call(h, { i: 1 });
    const second = await call(h, { i: 2 });
    expect(second.action).toBe('allow');
    expect(codes(second)).toContain('BUDGET_CALLS');
    expect(gateway.requests).toHaveLength(1);
  });

  it('halts on the estimated token budget, and says the number is an estimate', async () => {
    const h = harness({
      mode: 'enforce',
      budgets: { max_tokens_estimated: 10, on_exceeded: 'halt' },
    });
    await call(
      h,
      { path: '/a' },
      { outcome: { isError: false, resultSummary: 'x', resultBytes: 400 } },
    );
    const decision = await call(h, { path: '/b' });
    expect(codes(decision)).toContain('BUDGET_TOKENS');
    expect(decision.reasons.at(-1)?.message).toContain('~');
    expect(decision.reasons.at(-1)?.evidence?.estimate).toBe(true);
  });

  it('halts on the estimated dollar budget', async () => {
    const h = harness({
      mode: 'enforce',
      budgets: { max_usd_estimated: 0.000001, on_exceeded: 'halt' },
    });
    await call(h, { path: '/a' });
    const decision = await call(h, { path: '/b' });
    expect(codes(decision)).toContain('BUDGET_USD');
    expect(decision.reasons.at(-1)?.message).toContain('$');
  });

  it('keeps counting tokens and dollars', async () => {
    const h = harness({ mode: 'enforce' });
    await call(
      h,
      { path: '/a' },
      { outcome: { isError: false, resultSummary: 'x', resultBytes: 4096 } },
    );
    const summary = h.engine.endSession(SESSION);
    expect(summary.tokensEstimated.args).toBeGreaterThan(0);
    expect(summary.tokensEstimated.results).toBeGreaterThan(100);
    expect(summary.usdEstimated).toBeGreaterThan(0);
    expect(summary.tokensEstimated.note).toContain('floor estimate');
  });
});

describe('approvals', () => {
  const approvalPolicy = { mode: 'enforce', tools: [{ match: '*', action: 'require_approval' }] };

  it('forwards an approved call', async () => {
    const gateway = new ScriptedApprovalGateway('approved');
    const h = harness(approvalPolicy, gateway);
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('allow');
    expect(codes(decision)).toEqual(['POLICY_APPROVAL']);
    expect(gateway.requests[0]?.argsPreview).toBe('{"path":"/a"}');
    expect(gateway.requests[0]?.timeoutMs).toBe(120_000);
  });

  it('denies a rejected call', async () => {
    const h = harness(approvalPolicy, new ScriptedApprovalGateway('denied'));
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('deny');
    expect(codes(decision)).toEqual(['POLICY_APPROVAL', 'APPROVAL_DENIED']);
  });

  it('denies an unanswered call by default', async () => {
    const h = harness(approvalPolicy, new ScriptedApprovalGateway('timeout'));
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('deny');
    expect(codes(decision)).toEqual(['POLICY_APPROVAL', 'APPROVAL_TIMEOUT']);
  });

  it('forwards an unanswered call when the policy says to', async () => {
    const h = harness(
      { ...approvalPolicy, approvals: { on_timeout: 'allow' } },
      new ScriptedApprovalGateway('timeout'),
    );
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('allow');
    expect(codes(decision)).toEqual(['POLICY_APPROVAL', 'APPROVAL_TIMEOUT']);
  });

  it('treats a gateway that throws as a refusal', async () => {
    const gateway: ApprovalGateway = {
      requestApproval: () => Promise.reject(new Error('no tty')),
    };
    const h = harness(approvalPolicy, gateway);
    expect((await call(h, { path: '/a' })).action).toBe('deny');
  });

  it('denies by default when no gateway is configured', async () => {
    const h = harness(approvalPolicy);
    expect(h.engine.ports.approvals).toBeInstanceOf(DenyAllApprovalGateway);
    expect((await call(h, { path: '/a' })).action).toBe('deny');
  });

  it('redacts the preview when the policy asks', async () => {
    const gateway = new ScriptedApprovalGateway('approved');
    const h = harness({ ...approvalPolicy, report: { redact_args: true } }, gateway);
    await call(h, { path: '/secret' });
    expect(gateway.requests[0]?.argsPreview).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never asks a human in warn mode', async () => {
    const gateway = new ScriptedApprovalGateway('denied');
    const h = harness({ tools: [{ match: '*', action: 'require_approval' }] }, gateway);
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('warn');
    expect(decision.wouldTrip).toBe(true);
    expect(gateway.requests).toHaveLength(0);
  });
});

describe('breaker recovery', () => {
  it('cools down into half-open and closes after enough approvals', async () => {
    const gateway = new ScriptedApprovalGateway('approved');
    const h = harness(
      { mode: 'enforce', loop_detection: { cooldown: { calls: 2, duration: '1m' } } },
      gateway,
    );

    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    expect((await call(h, { path: '/a' })).action).toBe('deny');

    // Still inside the cooldown window.
    expect((await call(h, { path: '/b' })).action).toBe('deny');

    h.clock.advance(60_000);
    const probe = await call(h, { path: '/b' });
    expect(probe.action).toBe('allow');
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('half_open');

    const second = await call(h, { path: '/c' });
    expect(second.action).toBe('allow');
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('closed');
    // The history that tripped it is gone, so it cannot immediately re-trip.
    expect(h.engine.ports.sessions.get(SESSION)?.window).toHaveLength(1);
  });

  it('falls back to open when a human denies the probe', async () => {
    const gateway = new ScriptedApprovalGateway(['denied']);
    const h = harness(
      { mode: 'enforce', loop_detection: { cooldown: { duration: '1m' } } },
      gateway,
    );
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    h.clock.advance(60_000);

    const probe = await call(h, { path: '/b' });
    expect(probe.action).toBe('deny');
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('open');
  });

  it('closes on an explicit reset and keeps the budget counters', async () => {
    const h = harness({ mode: 'enforce' });
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });

    h.engine.resetBreaker(SESSION);
    const session = h.engine.ports.sessions.get(SESSION);
    expect(session?.breaker.phase).toBe('closed');
    expect(session?.window).toHaveLength(0);
    expect(session?.counters.calls).toBe(2);

    expect((await call(h, { path: '/a' })).action).toBe('allow');
  });

  it('ignores a reset for a session it has never seen', () => {
    const h = harness();
    expect(() => h.engine.resetBreaker('nope')).not.toThrow();
  });

  it('recovers in warn mode without a human, because a forwarded call is the probe', async () => {
    const h = harness({
      loop_detection: { on_trip: 'require_approval', cooldown: { calls: 2, duration: '1m' } },
    });
    await call(h, { path: '/a' });
    await call(h, { path: '/a' });
    const trip = await call(h, { path: '/a' });
    expect(trip.action).toBe('warn');
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('half_open');

    await call(h, { path: '/b' });
    await call(h, { path: '/c' });
    expect(h.engine.ports.sessions.get(SESSION)?.breaker.phase).toBe('closed');
  });
});

describe('the semantic seam', () => {
  it('acts on a trip the async layer left behind, on the next call', async () => {
    const h = harness({ mode: 'enforce' });
    await call(h, { path: '/a' });

    h.engine.markPendingTrip(SESSION, { code: 'LOOP_SEMANTIC', message: 'windows converged' });
    h.engine.markPendingTrip(SESSION, { code: 'LOOP_CYCLE', message: 'ignored, first wins' });

    const decision = await call(h, { path: '/b' });
    expect(decision.action).toBe('deny');
    expect(codes(decision)).toEqual(['LOOP_SEMANTIC']);
    expect(decision.report?.trigger.code).toBe('LOOP_SEMANTIC');
    expect(h.engine.ports.sessions.get(SESSION)?.pendingTrip).toBeUndefined();
  });

  it('ignores a pending trip for a session that no longer exists', () => {
    const h = harness();
    expect(() =>
      h.engine.markPendingTrip('nope', { code: 'LOOP_SEMANTIC', message: 'x' }),
    ).not.toThrow();
    expect(() => h.engine.markDegraded('nope')).not.toThrow();
  });

  it('records load shedding on the session summary', async () => {
    const h = harness();
    await call(h, { path: '/a' });
    h.engine.markDegraded(SESSION);
    expect(h.engine.endSession(SESSION).degraded).toBe(true);
  });

  it('notifies completed-call listeners', async () => {
    const h = harness();
    const seen: string[] = [];
    h.engine.onRecordComplete((record) => seen.push(record.toolName));
    await call(h, { path: '/a' });
    expect(seen).toEqual(['read_file']);
  });
});

describe('onDecision hooks', () => {
  it('can change the action and append reasons', async () => {
    const h = harness({ mode: 'enforce' });
    h.engine.onDecision(({ decision }) =>
      decision.action === 'allow'
        ? { action: 'warn', reasons: [{ code: 'POLICY_WARN', message: 'from the hook' }] }
        : undefined,
    );
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('warn');
    expect(decision.reasons.at(-1)?.message).toBe('from the hook');
  });

  it('cannot rewrite the arguments', async () => {
    const h = harness({ mode: 'enforce' });
    let mutationThrew = false;
    h.engine.onDecision(({ call: view }) => {
      try {
        (view.args as Record<string, unknown>).path = '/etc/shadow';
      } catch {
        mutationThrew = true;
      }
      return { action: 'warn', reasons: [] };
    });

    const decision = await h.engine.beforeCall({
      sessionId: SESSION,
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: '/a' },
    });

    expect(mutationThrew).toBe(true);
    expect(decision.action).toBe('warn');
    const record = h.engine.ports.sessions.get(SESSION)?.inFlight.get(decision.callId);
    expect(record?.args).toEqual({ path: '/a' });
  });

  it('ignores an args field on the result', async () => {
    const h = harness({ mode: 'enforce' });
    h.engine.onDecision(() => ({ action: 'allow', args: { path: '/etc/shadow' } }) as never);
    const decision = await h.engine.beforeCall({
      sessionId: SESSION,
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: '/a' },
    });
    const record = h.engine.ports.sessions.get(SESSION)?.inFlight.get(decision.callId);
    expect(record?.args).toEqual({ path: '/a' });
  });

  it('contains a hook that throws and reports it as a hook error', async () => {
    const h = harness({ mode: 'enforce' });
    h.engine.onDecision(() => {
      throw new Error('hook exploded');
    });
    h.engine.onDecision(() => ({ action: 'warn' }));

    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('warn');
    expect(h.telemetry.ofType('policy_decision')[0]?.hookError).toBe('hook exploded');
  });

  it('ignores a nonsense return value', async () => {
    const h = harness({ mode: 'enforce' });
    h.engine.onDecision(() => 'nope' as never);
    h.engine.onDecision(() => ({ action: 'explode' }) as never);
    h.engine.onDecision(() => ({ reasons: ['not a reason'] }) as never);
    const decision = await call(h, { path: '/a' });
    expect(decision.action).toBe('allow');
    expect(decision.reasons).toEqual([]);
  });
});

describe('sessions', () => {
  it('summarises a finished session', async () => {
    const h = harness({ mode: 'enforce' });
    await call(h, { path: '/a' }, { advanceMs: 100 });
    await call(h, { path: '/b' }, { outcome: failure('code:ENOENT'), advanceMs: 100 });

    const summary = h.engine.endSession(SESSION);
    expect(summary.calls).toBe(2);
    expect(summary.errorCalls).toBe(1);
    expect(summary.durationMs).toBe(200);
    expect(summary.breakerPhase).toBe('closed');
    expect(h.engine.ports.sessions.get(SESSION)).toBeUndefined();
  });

  it('returns a zeroed summary for a session it never saw', () => {
    const summary = harness().engine.endSession('ghost');
    expect(summary.calls).toBe(0);
    expect(summary.durationMs).toBe(0);
    expect(summary.trips).toEqual([]);
  });

  it('sweeps idle sessions', async () => {
    const h = harness({ session: { idle_timeout: '1m' } });
    await call(h, { path: '/a' });
    expect(h.engine.sweepIdleSessions()).toEqual([]);
    h.clock.advance(60_000);
    expect(h.engine.sweepIdleSessions()).toEqual([SESSION]);
    expect(h.engine.sweepIdleSessions()).toEqual([]);
  });

  it('drops the call index when a session is swept', async () => {
    const h = harness({ session: { idle_timeout: '1m' } });
    const decision = await h.engine.beforeCall({
      sessionId: SESSION,
      serverName: 'fs',
      toolName: 'read_file',
      args: {},
    });
    h.clock.advance(60_000);
    h.engine.sweepIdleSessions();
    expect(() => h.engine.afterCall(decision.callId, OK)).not.toThrow();
  });

  it('ignores an outcome for a call it does not know', () => {
    const h = harness();
    expect(() => h.engine.afterCall('nope', OK)).not.toThrow();
  });

  it('keeps sessions apart', async () => {
    const h = harness({ mode: 'enforce' });
    for (let i = 0; i < 3; i += 1) {
      await h.engine.beforeCall({
        sessionId: 'other',
        serverName: 'fs',
        toolName: 'read_file',
        args: { path: '/a' },
      });
    }
    expect((await call(h, { path: '/a' })).action).toBe('allow');
  });

  it('emits one tool_call event per completed call', async () => {
    const h = harness();
    await call(h, { path: '/a' }, { outcome: failure('code:ENOENT'), advanceMs: 7 });
    const events = h.telemetry.ofType('tool_call');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      serverName: 'fs',
      toolName: 'read_file',
      isError: true,
      errorSignature: 'code:ENOENT',
      durationMs: 7,
    });
  });

  it('does not leave a denied call in flight', async () => {
    const h = harness({ mode: 'enforce', tools: [{ match: '*', action: 'deny' }] });
    const decision = await call(h, { path: '/a' });
    expect(h.engine.ports.sessions.get(SESSION)?.inFlight.size).toBe(0);
    expect(decision.action).toBe('deny');
  });

  it('aborts a pending approval when the session ends', async () => {
    const gateway: ApprovalGateway = {
      requestApproval: (_req, signal) =>
        // Waits for a human who never answers, and gives up when told to.
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('denied'));
        }),
    };
    const h = harness(
      { mode: 'enforce', tools: [{ match: '*', action: 'require_approval' }] },
      gateway,
    );

    const pending = h.engine.beforeCall({
      sessionId: SESSION,
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: '/a' },
    });
    h.engine.endSession(SESSION);
    expect((await pending).action).toBe('deny');
  });

  it('aborts a pending approval when the breaker is reset', async () => {
    const gateway: ApprovalGateway = {
      requestApproval: (_req, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('denied'));
        }),
    };
    const h = harness(
      { mode: 'enforce', tools: [{ match: '*', action: 'require_approval' }] },
      gateway,
    );

    const pending = h.engine.beforeCall({
      sessionId: SESSION,
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: '/a' },
    });
    h.engine.resetBreaker(SESSION);
    expect((await pending).action).toBe('deny');
  });
});

describe('ports and defaults', () => {
  it('fills in every default port', () => {
    const engine = new FuseEngine(parsePolicy({ version: 1 }));
    expect(engine.ports.clock.now()).toBeGreaterThan(0);
    expect(engine.ports.ids.next()).toHaveLength(26);
    expect(engine.ports.tokenizer.id).toBe('heuristic:bytes/4');
    expect(engine.ports.cost.estimateUsd({ input: 1_000_000, output: 0 })).toBeCloseTo(3);
    expect(() => engine.ports.telemetry.emit({} as never)).not.toThrow();
  });

  it('exposes the compiled policy', () => {
    const engine = new FuseEngine(parsePolicy({ version: 1 }));
    expect(engine.policy.sha256).toHaveLength(64);
  });
});
