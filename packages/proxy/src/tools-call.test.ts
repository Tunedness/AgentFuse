import {
  CounterIdGenerator,
  type Decision,
  FakeClock,
  FuseEngine,
  InMemorySessionStore,
  parsePolicy,
  RecordingTelemetrySink,
  type SessionSummary,
} from '@agentfuse/core';
import { TRACEPARENT_META_KEY } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Diagnostics } from './diagnostics.js';
import { createHarness, createServedHarness, type Harness } from './testing/scenarios.js';
import { createToolCallGuard } from './tools-call.js';
import { TRIP_META_KEY } from './trip-result.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const SESSION = 'session-under-test';

/** A sink that records what AgentFuse would have written to stderr. */
class RecordingSink {
  readonly lines: string[] = [];

  write(chunk: string): void {
    this.lines.push(chunk);
  }
}

/**
 * An engine wired entirely to injectable ports, so nothing here is timing-dependent.
 *
 * The policy argument is `unknown` because `parsePolicy` takes the *input*
 * document — a partial whose defaults are still to be filled — while `FusePolicy`
 * is what comes out the other side, fully defaulted. Annotating the input with
 * the output type is the mistake that makes every fixture need a cast.
 */
function engineFor(policy: unknown): {
  engine: FuseEngine;
  clock: FakeClock;
  telemetry: RecordingTelemetrySink;
} {
  const clock = new FakeClock(1_700_000_000_000);
  const telemetry = new RecordingTelemetrySink();
  const engine = new FuseEngine(parsePolicy(policy), {
    clock,
    ids: new CounterIdGenerator('id'),
    sessions: new InMemorySessionStore(),
    telemetry,
  });
  return { engine, clock, telemetry };
}

/** Enforce mode with a two-call exact-repeat threshold: trips on the second call. */
function repeatTrippingPolicy(): unknown {
  return {
    version: 1,
    mode: 'enforce',
    loop_detection: { exact_repeat: { count: 2 } },
  };
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('a call the engine allows', () => {
  it('reaches the guarded server and is recorded', async () => {
    const { engine } = engineFor({ version: 1 });
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    const result = await harness.client.callTool({ name: 'echo', arguments: { a: 1 } });

    expect(result.content).toEqual([{ type: 'text', text: '{"a":1}' }]);
    expect(harness.log.toolCalls).toHaveLength(1);
    expect(guard.endSession().calls).toBe(1);
  });

  it('records an upstream isError result as an error outcome', async () => {
    const { engine } = engineFor({ version: 1 });
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'boom' });
    const summary = guard.endSession();

    expect(summary.calls).toBe(1);
    expect(summary.errorCalls).toBe(1);
  });

  it('records an upstream throw as an error outcome rather than losing the call', async () => {
    const { engine } = engineFor({ version: 1 });
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    await expect(harness.client.callTool({ name: 'throw' })).rejects.toThrow();
    const summary = guard.endSession();

    // A record left in flight is a leak, and a call counter that misses the
    // failures understates what the agent actually did.
    expect(summary.calls).toBe(1);
    expect(summary.errorCalls).toBe(1);
  });

  it('records a cancelled call rather than leaving it in flight', async () => {
    const { engine } = engineFor({ version: 1 });
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });
    const controller = new AbortController();

    const pending = harness.client.callTool({ name: 'hang' }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(guard.endSession().calls).toBe(1);
  });

  it('passes the request’s traceparent to the engine', async () => {
    const { engine } = engineFor({
      version: 1,
      mode: 'enforce',
      loop_detection: { exact_repeat: { count: 2 } },
    });
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({
      name: 'echo',
      arguments: {},
      _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
    });
    const blocked = await harness.client.callTool({
      name: 'echo',
      arguments: {},
      _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
    });

    // The trip report is where it surfaces: copied from the request, never
    // invented.
    const trip = (blocked.structuredContent as { agentfuse: { trip: { reportId?: string } } })
      .agentfuse.trip;
    expect(trip.reportId).toBeDefined();
    expect(blocked.isError).toBe(true);
  });

  it('summarises a structured-only result, so the semantic layer has something to see', async () => {
    const { engine } = engineFor({
      version: 1,
      mode: 'enforce',
      loop_detection: { exact_repeat: { count: 2 } },
    });
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    const first = await harness.client.callTool({ name: 'structured' });
    const summary = guard.endSession();

    // A tool with no text block would otherwise be summarised as the empty
    // string, and every one of its calls would look identical to the semantic
    // layer.
    expect(first.structuredContent).toEqual({ rows: 3, cursor: 'next' });
    expect(summary.calls).toBe(1);
    expect(summary.tokensEstimated.results).toBeGreaterThan(0);
  });

  it('consults the annotations catalogue when the host supplies one', async () => {
    const asked: string[] = [];
    const { engine } = engineFor({
      version: 1,
      mode: 'enforce',
      annotations: { trust_hints: true },
      loop_detection: { exact_repeat: { count: 2 } },
    });
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      annotationsFor: (toolName) => {
        asked.push(toolName);
        return { idempotentHint: true };
      },
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    await harness.client.callTool({ name: 'echo', arguments: {} });
    const third = await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(asked).toEqual(['echo', 'echo', 'echo']);
    // `idempotentHint` doubles the exact-repeat threshold from 2 to 4, so the
    // third identical call is still forwarded.
    expect(third.isError).toBeUndefined();
  });
});

describe('a call the engine blocks', () => {
  it('comes back as an isError result, not a JSON-RPC error', async () => {
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });

    // The promise resolves. A rejection would be a transport failure as far as
    // the agent's client is concerned, and the model would never read the text.
    expect(blocked.isError).toBe(true);
    expect(harness.log.toolCalls).toHaveLength(1);
  });

  it('tells the agent that retrying unchanged will also be blocked', async () => {
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });
    const text = (blocked.content?.[0] as { text?: string } | undefined)?.text ?? '';

    expect(text).toContain('will be blocked too');
    expect(text).toContain('AgentFuse circuit breaker OPEN');
    expect(text).toContain('Do this instead:');
  });

  it('carries the trip in structuredContent and in _meta', async () => {
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(blocked.structuredContent).toMatchObject({
      agentfuse: { trip: { code: 'LOOP_EXACT_REPEAT', breaker: 'open' } },
    });
    expect(blocked._meta?.[TRIP_META_KEY]).toMatchObject({ code: 'LOOP_EXACT_REPEAT' });
  });

  it('never forwards the call', async () => {
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    await harness.client.callTool({ name: 'echo', arguments: {} });
    await harness.client.callTool({ name: 'echo', arguments: {} });

    // One forwarded call, then the breaker. The guarded server never sees the
    // repeats, which is the entire product.
    expect(harness.log.toolCalls).toHaveLength(1);
  });

  it('names the report path the host wrote', async () => {
    const { engine } = engineFor(repeatTrippingPolicy());
    const written: Decision[] = [];
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      writeReport: (decision) => {
        written.push(decision);
        return '/tmp/agentfuse/01J.json';
      },
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });
    const text = (blocked.content?.[0] as { text?: string } | undefined)?.text ?? '';

    // The proxy does no file I/O of its own; the path in the result is whatever
    // the host handed back.
    expect(written).toHaveLength(1);
    expect(text).toContain('Trip report: /tmp/agentfuse/01J.json');
  });

  it('writes core’s rendered report to stderr and nothing to stdout', async () => {
    const sink = new RecordingSink();
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      diagnostics: new Diagnostics({ sink }),
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    await harness.client.callTool({ name: 'echo', arguments: {} });
    const written = sink.lines.join('');

    expect(written).toContain('[agentfuse] {"event":"trip_report"');
    expect(written).toContain('AgentFuse · circuit tripped');
    expect(written).toContain('[agentfuse] {"event":"blocked"');
  });

  it('is silent when quiet', async () => {
    const sink = new RecordingSink();
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      diagnostics: new Diagnostics({ sink, quiet: true }),
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(sink.lines).toEqual([]);
    // Quiet silences AgentFuse's own output, never the agent's answer.
    expect(blocked.isError).toBe(true);
  });

  it('fails closed on a hook that raises the action after the gateway ran', async () => {
    const { engine } = engineFor({ version: 1, mode: 'enforce' });
    engine.onDecision(() => ({ action: 'require_approval' }));
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: guard.gate });

    const result = await harness.client.callTool({ name: 'echo', arguments: {} });

    // There is nobody left to ask by this point, so the call does not happen.
    expect(result.isError).toBe(true);
    expect(harness.log.toolCalls).toHaveLength(0);
  });
});

describe('warn mode', () => {
  it('forwards the call and records that enforce would have tripped', async () => {
    const sink = new RecordingSink();
    const { engine } = engineFor({
      version: 1,
      loop_detection: { exact_repeat: { count: 2 } },
    });
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      diagnostics: new Diagnostics({ sink }),
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const second = await harness.client.callTool({ name: 'echo', arguments: {} });

    // Warn mode is how an operator measures their false-positive rate before
    // turning enforcement on, so the call has to go through and the near-miss
    // has to be countable.
    expect(second.isError).toBeUndefined();
    expect(harness.log.toolCalls).toHaveLength(2);
    expect(sink.lines.join('')).toContain('"event":"would_trip"');
  });
});

describe('the session lifecycle', () => {
  it('reports totals and notifies the host, which is where forget() is wired', async () => {
    const summaries: SessionSummary[] = [];
    const { engine } = engineFor({ version: 1 });
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      onSessionEnd: (summary) => summaries.push(summary),
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const summary = guard.endSession();

    expect(summary.sessionId).toBe(SESSION);
    expect(summary.calls).toBe(1);
    // Phase 3's note: the semantic detector cannot see a session leave the
    // store, so a host that runs it calls `detector.forget(sessionId)` here.
    expect(summaries).toEqual([summary]);
  });

  it('honours a per-call session resolver, which is the HTTP ladder’s seam', async () => {
    const { engine } = engineFor({
      version: 1,
      mode: 'enforce',
      loop_detection: { exact_repeat: { count: 2 } },
    });
    let current = 'session-a';
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: 'connection-session',
      resolveSessionId: () => current,
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    current = 'session-b';
    const other = await harness.client.callTool({ name: 'echo', arguments: {} });

    // Two identical calls in two sessions are not a repeat. If the resolver
    // were ignored, the second would have tripped.
    expect(other.isError).toBeUndefined();
  });

  it('falls back to the connection session when the resolver has no answer', async () => {
    const { engine } = engineFor({
      version: 1,
      mode: 'enforce',
      loop_detection: { exact_repeat: { count: 2 } },
    });
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: 'connection-session',
      resolveSessionId: () => undefined,
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const second = await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(second.isError).toBe(true);
  });
});

describe('a call a human was asked about', () => {
  /** Enforce mode where the second identical call goes to a human. */
  function askingPolicy(): unknown {
    return {
      version: 1,
      mode: 'enforce',
      loop_detection: {
        exact_repeat: { count: 2 },
        on_trip: 'require_approval',
        semantic: { enabled: false },
      },
    };
  }

  /** An engine whose approvals are answered by a script. */
  function askedEngine(verdict: 'approved' | 'denied', reason: string): FuseEngine {
    return new FuseEngine(parsePolicy(askingPolicy()), {
      clock: new FakeClock(1_700_000_000_000),
      ids: new CounterIdGenerator('id'),
      sessions: new InMemorySessionStore(),
      approvals: { requestApproval: async () => ({ verdict, reason }) },
    });
  }

  it('has its report written even when the answer was yes', async () => {
    // ADR-009: "why was this call allowed" is exactly what an audit asks, so
    // the artifact that answers it is persisted for an approval too — until
    // now only a refusal produced a file.
    const written: Decision[] = [];
    const guard = createToolCallGuard({
      engine: askedEngine('approved', 'the retry is intentional'),
      serverName: 'scenario',
      sessionId: SESSION,
      writeReport: (decision) => {
        written.push(decision);
        return '/reports/one.json';
      },
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const allowed = await harness.client.callTool({ name: 'echo', arguments: {} });

    // Forwarded, because the human said yes — and recorded, because they were
    // asked at all.
    expect(allowed.isError).toBeUndefined();
    expect(written).toHaveLength(1);
    expect(written[0]?.approval).toEqual({
      verdict: 'approved',
      reason: 'the retry is intentional',
    });
    expect(written[0]?.report?.approval?.reason).toBe('the retry is intentional');
  });

  it('carries the reason into the report of a refusal as well', async () => {
    const written: Decision[] = [];
    const guard = createToolCallGuard({
      engine: askedEngine('denied', 'that is production'),
      serverName: 'scenario',
      sessionId: SESSION,
      writeReport: (decision) => {
        written.push(decision);
        return '/reports/one.json';
      },
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(blocked.isError).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]?.report?.approval).toEqual({
      verdict: 'denied',
      reason: 'that is production',
    });
  });

  it('writes nothing for a trip nobody was asked about', async () => {
    // The widening is narrow: a plain refusal still writes exactly one report,
    // and a forwarded call with no approval writes none.
    const written: Decision[] = [];
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      writeReport: (decision) => {
        written.push(decision);
        return '/reports/one.json';
      },
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    expect(written).toHaveLength(0);

    await harness.client.callTool({ name: 'echo', arguments: {} });
    expect(written).toHaveLength(1);
    expect(written[0]?.approval).toBeUndefined();
  });
});

describe('the traceparent the guarded server is forwarded', () => {
  /** The host's span: same trace as the agent's, a span id of its own. */
  const OURS = '00-4bf92f3577b34da6a3ce929d0e0e4736-0123456789abcdef-01';

  /** The `_meta` the scenario server saw on the last `tools/call`. */
  function lastMeta(): Record<string, unknown> {
    return (harness?.log.metas.at(-1) ?? {}) as Record<string, unknown>;
  }

  it('is the host’s span when the hook names one', async () => {
    const { engine } = engineFor({ version: 1 });
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      traceparentFor: () => OURS,
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({
      name: 'echo',
      arguments: {},
      _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
    });

    // The point of the seam: the guarded server's work is a child of the
    // proxy's span, not a sibling of it.
    expect(lastMeta()[TRACEPARENT_META_KEY]).toBe(OURS);
  });

  it('is added even when the agent sent no context at all', async () => {
    const { engine } = engineFor({ version: 1 });
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      traceparentFor: () => OURS,
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(lastMeta()[TRACEPARENT_META_KEY]).toBe(OURS);
  });

  it('sees the decision it is about, which is where the span id comes from', async () => {
    const { engine } = engineFor({ version: 1 });
    const seen: { tool?: string; callId?: string } = {};
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      traceparentFor: (call, decision) => {
        seen.tool = call.request.params.name;
        seen.callId = decision.callId;
        return undefined;
      },
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });

    // The host mints the span while the decision is emitted, so the hook is
    // read after `beforeCall` and is handed the call id to look it up by.
    expect(seen.tool).toBe('echo');
    expect(seen.callId).toBe('id000000000000000000000001');
  });

  it('leaves the agent’s bytes untouched with no hook and with an undecided one', async () => {
    // The regression that would hurt: telemetry off, or a call with no span,
    // has to look exactly like it did before the seam existed.
    const { engine } = engineFor({ version: 1 });
    const unhooked = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createHarness({ onToolCall: unhooked.gate });

    await harness.client.callTool({
      name: 'echo',
      arguments: {},
      _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
    });
    const withoutHook = lastMeta();
    await harness.close();

    const hooked = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: 'second-session',
      traceparentFor: () => undefined,
    });
    harness = await createHarness({ onToolCall: hooked.gate });

    await harness.client.callTool({
      name: 'echo',
      arguments: {},
      _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
    });

    expect(withoutHook[TRACEPARENT_META_KEY]).toBe(TRACEPARENT);
    expect(lastMeta()).toEqual(withoutHook);
  });

  it('is not consulted for a call the engine blocked', async () => {
    const { engine } = engineFor(repeatTrippingPolicy());
    let asked = 0;
    const guard = createToolCallGuard({
      engine,
      serverName: 'scenario',
      sessionId: SESSION,
      traceparentFor: () => {
        asked += 1;
        return OURS;
      },
    });
    harness = await createHarness({ onToolCall: guard.gate });

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });

    // Nothing was forwarded, so there is no outbound request to re-parent.
    expect(blocked.isError).toBe(true);
    expect(asked).toBe(1);
  });
});

describe('the refusal crosses both eras intact', () => {
  it.each(['legacy', 'modern'] as const)('in the %s era', async (era) => {
    const { engine } = engineFor(repeatTrippingPolicy());
    const guard = createToolCallGuard({ engine, serverName: 'scenario', sessionId: SESSION });
    harness = await createServedHarness({ era, onToolCall: guard.gate });

    expect(harness.client.getProtocolEra()).toBe(era);

    await harness.client.callTool({ name: 'echo', arguments: {} });
    const blocked = await harness.client.callTool({ name: 'echo', arguments: {} });

    // The whole result as the agent's client hands it over, snapshotted per
    // era. The 2026 revision adds `_meta` keys of its own (serverInfo) and
    // discriminates `resultType` off the wire, so the two are not identical —
    // which is exactly why both are pinned.
    expect(blocked).toMatchSnapshot();
    expect(blocked.isError).toBe(true);
    expect((blocked.content?.[0] as { text?: string } | undefined)?.text).toContain(
      'will be blocked too',
    );
    expect(blocked._meta?.[TRIP_META_KEY]).toMatchObject({ code: 'LOOP_EXACT_REPEAT' });
    expect(blocked.structuredContent).toMatchObject({
      agentfuse: { trip: { code: 'LOOP_EXACT_REPEAT', breaker: 'open' } },
    });
  });
});
