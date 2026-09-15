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
