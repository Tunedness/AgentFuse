import { CounterIdGenerator, FakeClock } from '@agentfuse/core';
import {
  BAGGAGE_META_KEY,
  CLIENT_INFO_META_KEY,
  TRACEPARENT_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { GuardedToolCall } from './bridge.js';
import {
  clientAddressKey,
  describeSessionRegime,
  SESSION_BAGGAGE_KEY,
  SessionKeyResolver,
  sessionIdResolverFor,
  traceIdOf,
} from './http-serve.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const IDLE_MS = 600_000;

function resolverFor(
  key: 'auto' | 'connection' | 'traceparent' | `baggage:${string}`,
  clock = new FakeClock(1_700_000_000_000),
): { resolver: SessionKeyResolver; clock: FakeClock } {
  return {
    resolver: new SessionKeyResolver({
      key,
      idleTimeoutMs: IDLE_MS,
      clock,
      ids: new CounterIdGenerator('sess'),
    }),
    clock,
  };
}

describe('traceIdOf', () => {
  it('extracts the trace id from a well-formed traceparent', () => {
    expect(traceIdOf(TRACEPARENT)).toBe(TRACE_ID);
  });

  it('rejects an all-zero trace id, which the spec calls invalid', () => {
    // Accepting it would merge every badly-instrumented caller into one
    // session, and therefore one budget.
    expect(traceIdOf(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
  });

  it.each([
    ['too few fields', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'],
    ['a short trace id', '00-4bf92f35-00f067aa0ba902b7-01'],
    ['upper-case hex', `00-${TRACE_ID.toUpperCase()}-00f067aa0ba902b7-01`],
    ['not hex at all', '00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(traceIdOf(value)).toBeUndefined();
  });

  it('is undefined for an absent header', () => {
    expect(traceIdOf(undefined)).toBeUndefined();
  });
});

describe('clientAddressKey', () => {
  it('is stable for the same caller from the same place', () => {
    const first = clientAddressKey({ name: 'claude-code', version: '4.1.0' }, '203.0.113.7');
    const second = clientAddressKey({ name: 'claude-code', version: '4.1.0' }, '203.0.113.7');

    expect(first).toBe(second);
  });

  it('separates two callers from the same address', () => {
    const a = clientAddressKey({ name: 'claude-code' }, '203.0.113.7');
    const b = clientAddressKey({ name: 'some-other-agent' }, '203.0.113.7');

    expect(a).not.toBe(b);
  });

  it('separates the same caller from two addresses', () => {
    const a = clientAddressKey({ name: 'claude-code' }, '203.0.113.7');
    const b = clientAddressKey({ name: 'claude-code' }, '198.51.100.4');

    expect(a).not.toBe(b);
  });

  it('cannot be confused by a name that looks like two fields', () => {
    // NUL-separated for the same reason core's fingerprint is: a name or an
    // address may contain the obvious separators, and NUL cannot.
    const a = clientAddressKey({ name: 'a', version: 'b' }, 'c');
    const b = clientAddressKey({ name: 'a' }, 'b c');

    expect(a).not.toBe(b);
  });

  it('is undefined when there is nothing to hash', () => {
    expect(clientAddressKey(undefined, undefined)).toBeUndefined();
  });

  it('works from an address alone', () => {
    expect(clientAddressKey(undefined, '203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the auto ladder', () => {
  it('takes the traceparent first', () => {
    const { resolver } = resolverFor('auto');

    const resolution = resolver.resolve({
      meta: {
        [TRACEPARENT_META_KEY]: TRACEPARENT,
        [BAGGAGE_META_KEY]: `${SESSION_BAGGAGE_KEY}=from-baggage`,
      },
      mcpSessionId: 'from-header',
    });

    expect(resolution).toEqual({ sessionId: TRACE_ID, source: 'traceparent', exact: true });
  });

  it('takes the chained baggage member second', () => {
    const { resolver } = resolverFor('auto');

    const resolution = resolver.resolve({
      meta: { [BAGGAGE_META_KEY]: `userId=alice,${SESSION_BAGGAGE_KEY}=01JCHAINED` },
      mcpSessionId: 'from-header',
    });

    // The cross-tool contract: the outermost proxy resolves the session and
    // injects this member, and the inner ones adopt it. A transport-level id
    // the outer proxy does not control must not outrank it.
    expect(resolution).toEqual({ sessionId: '01JCHAINED', source: 'baggage', exact: true });
  });

  it('takes Mcp-Session-Id third', () => {
    const { resolver } = resolverFor('auto');

    const resolution = resolver.resolve({ mcpSessionId: 'legacy-http-session' });

    expect(resolution).toEqual({
      sessionId: 'legacy-http-session',
      source: 'mcp-session-id',
      exact: true,
    });
  });

  it('falls back to the client-plus-address guess last, and says it is a guess', () => {
    const { resolver } = resolverFor('auto');

    const resolution = resolver.resolve({
      clientInfo: { name: 'claude-code' },
      remoteAddress: '203.0.113.7',
    });

    expect(resolution?.source).toBe('client-address');
    // Two agents behind one NAT running the same client build share a session
    // and therefore a budget. ADR-006 says this is documented as best effort
    // rather than presented as a guarantee.
    expect(resolution?.exact).toBe(false);
  });

  it('reads clientInfo out of _meta when the caller did not pass it separately', () => {
    const { resolver } = resolverFor('auto');

    const resolution = resolver.resolve({
      meta: { [CLIENT_INFO_META_KEY]: { name: 'claude-code', version: '4.1.0' } },
      remoteAddress: '203.0.113.7',
    });

    expect(resolution?.source).toBe('client-address');
  });

  it('gives the same caller the same session id across requests', () => {
    const { resolver } = resolverFor('auto');
    const input = { clientInfo: { name: 'claude-code' }, remoteAddress: '203.0.113.7' };

    const first = resolver.resolve(input);
    const second = resolver.resolve(input);

    expect(second?.sessionId).toBe(first?.sessionId);
    expect(resolver.size).toBe(1);
  });

  it('gives two callers two sessions', () => {
    const { resolver } = resolverFor('auto');

    const a = resolver.resolve({ clientInfo: { name: 'a' }, remoteAddress: '203.0.113.7' });
    const b = resolver.resolve({ clientInfo: { name: 'b' }, remoteAddress: '203.0.113.7' });

    expect(a?.sessionId).not.toBe(b?.sessionId);
    expect(resolver.size).toBe(2);
  });

  it('resolves to nothing when the request carries no identity at all', () => {
    const { resolver } = resolverFor('auto');

    // Not a fresh id: metering a call against a session that exists only for
    // that call turns every budget into no budget.
    expect(resolver.resolve({})).toBeUndefined();
  });
});

describe('a configured session.key', () => {
  it('uses the traceparent and nothing else', () => {
    const { resolver } = resolverFor('traceparent');

    expect(resolver.resolve({ meta: { [TRACEPARENT_META_KEY]: TRACEPARENT } })?.sessionId).toBe(
      TRACE_ID,
    );
    // Strict: a request with no traceparent is not quietly downgraded to the
    // guess the operator opted out of.
    expect(resolver.resolve({ mcpSessionId: 'ignored' })).toBeUndefined();
  });

  it('uses the named baggage member and nothing else', () => {
    const { resolver } = resolverFor('baggage:x-task-id');

    const resolution = resolver.resolve({
      meta: {
        [BAGGAGE_META_KEY]: 'x-task-id=task-42',
        [TRACEPARENT_META_KEY]: TRACEPARENT,
      },
    });

    expect(resolution).toEqual({ sessionId: 'task-42', source: 'baggage', exact: true });
    expect(resolver.resolve({ meta: { [BAGGAGE_META_KEY]: 'other=1' } })).toBeUndefined();
  });

  it('uses the transport connection and nothing else', () => {
    const { resolver } = resolverFor('connection');

    expect(resolver.resolve({ mcpSessionId: 'mcp-1' })).toEqual({
      sessionId: 'mcp-1',
      source: 'mcp-session-id',
      exact: true,
    });
    // The modern revision has no Mcp-Session-Id at all, which is why this
    // setting cannot be the default.
    expect(resolver.resolve({ meta: { [TRACEPARENT_META_KEY]: TRACEPARENT } })).toBeUndefined();
  });
});

describe('the bottom rung’s memory', () => {
  it('forgets a caller that has been idle past the timeout', () => {
    const { resolver, clock } = resolverFor('auto');
    const input = { clientInfo: { name: 'claude-code' }, remoteAddress: '203.0.113.7' };
    const first = resolver.resolve(input);

    clock.advance(IDLE_MS + 1);
    const second = resolver.resolve(input);

    // A long-running gateway would otherwise accumulate one entry per client
    // that ever connected.
    expect(second?.sessionId).not.toBe(first?.sessionId);
    expect(resolver.size).toBe(1);
  });

  it('keeps a caller that is still active', () => {
    const { resolver, clock } = resolverFor('auto');
    const input = { clientInfo: { name: 'claude-code' }, remoteAddress: '203.0.113.7' };
    const first = resolver.resolve(input);

    clock.advance(IDLE_MS - 1);
    const second = resolver.resolve(input);
    clock.advance(IDLE_MS - 1);
    const third = resolver.resolve(input);

    // Each resolve refreshes the binding, so a steady stream of calls never
    // rolls the session over mid-task.
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(third?.sessionId).toBe(first?.sessionId);
  });

  it('sweeps idle bindings and reports how many went', () => {
    const { resolver, clock } = resolverFor('auto');
    resolver.resolve({ clientInfo: { name: 'a' }, remoteAddress: '1' });
    resolver.resolve({ clientInfo: { name: 'b' }, remoteAddress: '2' });

    clock.advance(IDLE_MS);

    expect(resolver.sweep()).toBe(2);
    expect(resolver.size).toBe(0);
  });

  it('sweeps nothing when nothing is idle', () => {
    const { resolver } = resolverFor('auto');
    resolver.resolve({ clientInfo: { name: 'a' }, remoteAddress: '1' });

    expect(resolver.sweep()).toBe(0);
    expect(resolver.size).toBe(1);
  });

  it('forgets everything on teardown', () => {
    const { resolver } = resolverFor('auto');
    resolver.resolve({ clientInfo: { name: 'a' }, remoteAddress: '1' });
    resolver.clear();

    expect(resolver.size).toBe(0);
  });

  it('holds no bindings when the exact rungs answer', () => {
    const { resolver } = resolverFor('auto');
    resolver.resolve({ meta: { [TRACEPARENT_META_KEY]: TRACEPARENT } });
    resolver.resolve({ mcpSessionId: 'mcp-1' });

    // Nothing to remember: an exact key is derivable from every request.
    expect(resolver.size).toBe(0);
  });
});

describe('describeSessionRegime', () => {
  it('says plainly which regime produced the answer', () => {
    // ADR-006's consequence clause: a budget that is exact in one mode and
    // heuristic in another must never look the same in a report.
    expect(describeSessionRegime({ sessionId: 'x', source: 'traceparent', exact: true })).toContain(
      'exact',
    );
    expect(describeSessionRegime({ sessionId: 'x', source: 'baggage', exact: true })).toContain(
      'chained from an outer proxy',
    );
    expect(
      describeSessionRegime({ sessionId: 'x', source: 'mcp-session-id', exact: true }),
    ).toContain('legacy era only');
    expect(
      describeSessionRegime({ sessionId: 'x', source: 'client-address', exact: false }),
    ).toContain('not a guarantee');
  });

  it('says so when nothing resolved', () => {
    expect(describeSessionRegime(undefined)).toContain('session unresolved');
  });
});

describe('sessionIdResolverFor', () => {
  /** The slice of a guarded call the resolver reads. */
  function callWith(meta: Record<string, unknown> | undefined): GuardedToolCall {
    return { meta } as GuardedToolCall;
  }

  it('reads the ladder off a guarded call’s _meta', () => {
    const { resolver } = resolverFor('auto');
    const resolve = sessionIdResolverFor(resolver);

    expect(resolve(callWith({ [TRACEPARENT_META_KEY]: TRACEPARENT }))).toBe(TRACE_ID);
  });

  it('lets the caller supply the rungs _meta cannot carry', () => {
    const { resolver } = resolverFor('auto');
    const resolve = sessionIdResolverFor(resolver, () => ({ remoteAddress: '203.0.113.7' }));

    // A web-standard Request has no remote address; in Node it lives on the
    // socket, and behind a load balancer in a header the operator nominates.
    expect(resolve(callWith({ [CLIENT_INFO_META_KEY]: { name: 'claude-code' } }))).toMatch(/^sess/);
  });

  it('is undefined when the ladder resolves nothing, which the guard reads as “use the connection”', () => {
    const { resolver } = resolverFor('traceparent');
    const resolve = sessionIdResolverFor(resolver);

    expect(resolve(callWith(undefined))).toBeUndefined();
  });
});
