import { Client } from '@modelcontextprotocol/client';
import {
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  type Progress,
  TRACEPARENT_META_KEY,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridge } from './bridge.js';
import {
  ANY_RESULT,
  createHarness,
  createScenarioServer,
  type Harness,
  SCENARIO_CAPABILITIES,
  SCENARIO_INFO,
} from './testing/scenarios.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('the mirrored handshake', () => {
  it('presents the upstream server’s identity, capabilities and instructions', async () => {
    harness = await createHarness();

    // Not invented: the agent negotiates against the real server, and the only
    // thing that differs from talking to it directly is what `tools/call`
    // answers when the breaker is open.
    expect(harness.client.getServerVersion()).toEqual(SCENARIO_INFO);
    expect(harness.client.getServerCapabilities()).toEqual(SCENARIO_CAPABILITIES);
    expect(harness.client.getInstructions()).toContain('Scenario server');
  });

  it('lands both sides in the same era', async () => {
    harness = await createHarness();

    expect(harness.client.getProtocolEra()).toBe('legacy');
    expect(harness.bridge.client.getProtocolEra()).toBe('legacy');
  });
});

describe('the explicit handlers', () => {
  it('forwards tools/list verbatim, cursor and all', async () => {
    harness = await createHarness();

    const result = await harness.client.listTools({ cursor: 'page-2' });

    expect(result.tools.map((tool) => tool.name)).toContain('echo');
    expect(result.nextCursor).toBe('after:page-2');
  });

  it('forwards tools/call and returns the upstream result', async () => {
    harness = await createHarness();

    const result = await harness.client.callTool({ name: 'echo', arguments: { a: 1 } });

    expect(result.content).toEqual([{ type: 'text', text: '{"a":1}' }]);
    expect(harness.log.toolCalls[0]?.name).toBe('echo');
  });

  it('surfaces an upstream isError result as an isError result', async () => {
    harness = await createHarness();

    const result = await harness.client.callTool({ name: 'boom' });

    // An upstream failure is the upstream's answer, not the proxy's; wrapping
    // it in a protocol error would change what the agent sees.
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toMatchObject({ type: 'text' });
  });

  it('surfaces an upstream throw as a rejection', async () => {
    harness = await createHarness();

    await expect(harness.client.callTool({ name: 'throw' })).rejects.toThrow(
      /scenario server refuses/,
    );
  });

  it('routes tools/call through the gate even when the upstream declares no tools capability', async () => {
    // A server that serves tools without declaring them is violating the spec,
    // but the fallback must not turn that into an unguarded hole.
    const seen: string[] = [];
    harness = await createHarness({
      capabilities: { resources: {} },
      onToolCall: (call) => {
        seen.push(call.request.params.name);
        return call.forward();
      },
    });

    const result = await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(seen).toEqual(['echo']);
    expect(result.content).toEqual([{ type: 'text', text: '{}' }]);
  });
});

describe('the fallback seams', () => {
  it('passes a spec method the proxy has no handler for straight through', async () => {
    harness = await createHarness();

    const result = await harness.client.listResources();

    expect(result.resources).toEqual([{ uri: 'file:///scenario', name: 'scenario' }]);
    expect(harness.log.methods).toContain('resources/list');
  });

  it('passes a method no spec defines straight through', async () => {
    harness = await createHarness();

    const result = await harness.client.request({ method: 'acme/search', params: {} }, ANY_RESULT);

    // Proof it reached the far end rather than being answered locally.
    expect(result).toEqual({ reachedScenarioServer: 'acme/search' });
  });

  it('installs no handler of its own for server/discover', async () => {
    harness = await createHarness();

    // The proxy does not intercept the modern era's mandatory probe: whoever
    // owns the era owns the answer. `assertCanSetRequestHandler` throws only if
    // a handler is already registered, so this is the direct assertion that the
    // bridge left the slot free for the serving entry (`serveStdio` installs it
    // and answers from the mirrored capabilities).
    expect(() => {
      harness?.bridge.server.assertCanSetRequestHandler('server/discover');
    }).not.toThrow();
  });

  it('cannot be asked to carry server/discover across a legacy connection', async () => {
    harness = await createHarness();

    // Recorded because it contradicts the phase brief, which expected
    // `server/discover` to travel through the fallback. The installed SDK gates
    // outbound spec methods by era *locally*: on a legacy connection the
    // request dies before any transport sees it. Era transparency is therefore
    // not "forward everything and hope" — it is "both sides on the same era",
    // which is what ADR-005 already says. Thrown synchronously, before the
    // promise even exists — the gate runs ahead of the transport.
    expect(() =>
      harness?.client.request({ method: 'server/discover', params: {} }, ANY_RESULT),
    ).toThrow(/not supported by the negotiated protocol version/);
  });

  it('passes a notification from the agent upstream', async () => {
    harness = await createHarness();
    const seen: string[] = [];
    harness.scenario.fallbackNotificationHandler = async (notification) => {
      seen.push(notification.method);
    };

    await harness.client.notification({ method: 'notifications/acme/ping', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(seen).toEqual(['notifications/acme/ping']);
  });

  it('passes a notification from the guarded server downstream', async () => {
    harness = await createHarness();
    const seen: string[] = [];
    harness.client.fallbackNotificationHandler = async (notification) => {
      seen.push(notification.method);
    };

    await harness.scenario.notification({ method: 'notifications/tools/list_changed' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(seen).toEqual(['notifications/tools/list_changed']);
  });

  it('passes a server-to-client request downstream, which is why the topology is one pair', async () => {
    harness = await createHarness();
    harness.client.setRequestHandler('roots/list', () => ({
      roots: [{ uri: 'file:///workspace', name: 'workspace' }],
    }));

    const roots = await harness.scenario.listRoots();

    // In the legacy era the server pushes this without naming the caller, so a
    // shared upstream connection could not decide who to ask.
    expect(roots.roots).toEqual([{ uri: 'file:///workspace', name: 'workspace' }]);
  });
});

describe('clientInfo forwarding', () => {
  it('tells the guarded server who the real caller is', async () => {
    harness = await createHarness({ clientInfo: { name: 'claude-code', version: '4.1.0' } });

    await harness.client.callTool({ name: 'echo', arguments: {} });

    // Without this the upstream sees "agentfuse" and any behaviour it varies by
    // client is reasoning about the proxy instead of the agent.
    expect(harness.log.metas[0]?.[CLIENT_INFO_META_KEY]).toEqual({
      name: 'claude-code',
      version: '4.1.0',
    });
  });

  it('forwards it on a passthrough request too, not only on tools/call', async () => {
    const metas: Record<string, unknown>[] = [];
    const { server: scenario } = createScenarioServer();
    scenario.fallbackRequestHandler = async (request, ctx) => {
      // Merged, because the SDK lifts the reserved `io.modelcontextprotocol/*`
      // keys out of `_meta` before a handler sees them.
      metas.push({
        ...(request.params as { _meta?: Record<string, unknown> } | undefined)?._meta,
        ...(ctx.mcpReq.envelope as Record<string, unknown> | undefined),
      });
      return { ok: true };
    };

    const [upA, upB] = InMemoryTransport.createLinkedPair();
    const upstream = new Client({ name: 'agentfuse', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([scenario.connect(upB), upstream.connect(upA)]);
    const bridge = createBridge({
      client: upstream,
      serverInfo: SCENARIO_INFO,
      capabilities: upstream.getServerCapabilities(),
      onToolCall: (call) => call.forward(),
    });
    const [downA, downB] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'other-agent', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([bridge.server.connect(downB), client.connect(downA)]);

    await client.request({ method: 'acme/anything', params: {} }, ANY_RESULT);

    expect(metas[0]).toMatchObject({
      [CLIENT_INFO_META_KEY]: { name: 'other-agent', version: '1.0.0' },
    });

    await client.close();
    await bridge.close();
    await scenario.close();
  });

  it('forwards a traceparent without inventing one', async () => {
    harness = await createHarness();

    await harness.client.callTool({
      name: 'echo',
      arguments: {},
      _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
    });
    await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(harness.log.metas[0]?.[TRACEPARENT_META_KEY]).toBe(TRACEPARENT);
    // A fabricated traceparent would silently graft a fake span onto a real
    // trace, which is worse than no trace at all.
    expect(harness.log.metas[1]?.[TRACEPARENT_META_KEY]).toBeUndefined();
  });
});

describe('progress', () => {
  it('round-trips a progressToken and leaves the maps empty', async () => {
    harness = await createHarness();
    const seen: Progress[] = [];

    const result = await harness.client.callTool(
      { name: 'slow' },
      { onprogress: (progress) => seen.push(progress) },
    );

    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(seen.map((progress) => progress.progress)).toEqual([1, 2]);
    expect(seen.map((progress) => progress.message)).toEqual(['step 1', 'step 2']);
    // The leak test: a settled request must leave no entry behind, or a process
    // designed to run for the length of an agent session grows without bound.
    expect(harness.bridge.remap.size).toBe(0);
  });

  it('does not forward the agent’s own token upstream', async () => {
    harness = await createHarness();

    await harness.client.callTool({ name: 'slow' }, { onprogress: () => {} });

    const upstreamToken = (harness.log.metas[0] as { progressToken?: unknown } | undefined)
      ?.progressToken;
    // The SDK mints its own token for the outbound leg. An echo of the agent's
    // would be answered by the upstream client's dispatcher with "unknown
    // token" and dropped.
    expect(upstreamToken).toBeDefined();
    expect(upstreamToken).not.toBe('agent-token');
  });

  it('leaves the maps empty after a call that asked for no progress', async () => {
    harness = await createHarness();

    await harness.client.callTool({ name: 'echo', arguments: {} });

    expect(harness.bridge.remap.size).toBe(0);
  });

  it('leaves the maps empty after an upstream error', async () => {
    harness = await createHarness();

    await expect(harness.client.callTool({ name: 'throw' })).rejects.toThrow();

    expect(harness.bridge.remap.size).toBe(0);
  });

  it('leaves the maps empty after many concurrent calls', async () => {
    harness = await createHarness();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        harness?.client.callTool({ name: 'echo', arguments: { index } }),
      ),
    );

    expect(harness.bridge.remap.size).toBe(0);
  });
});

describe('cancellation', () => {
  it('propagates an abort downstream to upstream', async () => {
    harness = await createHarness();
    const controller = new AbortController();

    const pending = harness.client.callTool({ name: 'hang' }, { signal: controller.signal });
    // Let the request reach the far end before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error('the user changed their mind'));

    await expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The chain: downstream `notifications/cancelled` → the proxy Server's own
    // handler aborts the request handler → the chained signal aborts the
    // forwarded `client.request` → the upstream Client emits its own
    // `notifications/cancelled` with *its* request id. The id translation is a
    // consequence of passing one signal through, not a map the proxy keeps.
    expect(harness.log.methods).toContain('tools/call:aborted');
    expect(harness.bridge.remap.size).toBe(0);
  });
});

describe('teardown', () => {
  it('closes both halves and is safe to call twice', async () => {
    const built = await createHarness();

    await built.bridge.close();
    await built.bridge.close();

    expect(built.bridge.server.transport).toBeUndefined();
    expect(built.bridge.client.transport).toBeUndefined();
    await built.client.close();
    await built.scenario.close();
  });

  it('drops the in-flight bookkeeping on close', async () => {
    const built = await createHarness();
    built.bridge.remap.begin(99, 7);

    await built.bridge.close();

    expect(built.bridge.remap.size).toBe(0);
    await built.client.close();
    await built.scenario.close();
  });
});

describe('an upstream that answers tools/call with nonsense', () => {
  it('is reported rather than passed on as a CallToolResult', async () => {
    // Unreachable through an SDK `Server`, which normalises every `tools/call`
    // result into the shape the spec requires before it reaches the wire. It is
    // reachable from a hand-rolled peer, and a proxy that handed the engine a
    // result-shaped object with no `content` would produce a nonsense outcome
    // record for it — so the guard stays, and it is driven here from a stub.
    const stub = {
      request: async () => ({ nowhereNearAResult: true }),
      notification: async () => {},
      close: async () => {},
      fallbackRequestHandler: undefined,
      fallbackNotificationHandler: undefined,
    } as unknown as Client;

    const bridge = createBridge({
      client: stub,
      serverInfo: SCENARIO_INFO,
      capabilities: { tools: {} },
      onToolCall: (call) => call.forward(),
    });
    const [downA, downB] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-agent', version: '1' }, { capabilities: {} });
    await Promise.all([bridge.server.connect(downB), client.connect(downA)]);

    await expect(client.callTool({ name: 'echo' })).rejects.toThrow(/not a CallToolResult/);

    await client.close();
    await bridge.close();
  });
});
