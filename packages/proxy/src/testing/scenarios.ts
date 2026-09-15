/**
 * Scenario servers and the two-hop harness the integration tests run on.
 *
 * ```
 * [test client] ⇄ InMemoryTransport pair ⇄ [proxy] ⇄ InMemoryTransport pair ⇄ [scenario server]
 * ```
 *
 * Two linked pairs, not one: the point of the proxy is that there are two
 * connections with two numbering spaces, and a harness with one pair could not
 * catch a token or a request id leaking from one into the other — which is the
 * class of bug these tests exist for.
 *
 * Not exported from the package. It is test scaffolding, and publishing it
 * would make every scenario here part of the public contract.
 */

import { Client } from '@modelcontextprotocol/client';
import {
  type CallToolResult,
  type ClientCapabilities,
  type Implementation,
  InMemoryTransport,
  Server,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Bridge, createBridge, type ToolCallGate } from '../bridge.js';

/** Identity the scenario servers present. */
export const SCENARIO_INFO: Implementation = { name: 'scenario', version: '1.2.3' };

/** What every scenario server advertises, so the mirrored set is interesting. */
export const SCENARIO_CAPABILITIES: ServerCapabilities = {
  tools: {},
  resources: {},
  prompts: {},
  logging: {},
};

/** A tool the echo server exposes. */
const ECHO_TOOLS = [
  { name: 'echo', description: 'Returns its arguments.', inputSchema: { type: 'object' as const } },
  {
    name: 'slow',
    description: 'Reports progress twice.',
    inputSchema: { type: 'object' as const },
  },
  { name: 'hang', description: 'Never answers.', inputSchema: { type: 'object' as const } },
  { name: 'boom', description: 'Answers with isError.', inputSchema: { type: 'object' as const } },
  {
    name: 'throw',
    description: 'Throws a JSON-RPC error.',
    inputSchema: { type: 'object' as const },
  },
] as const;

/** What a scenario server recorded about the traffic it received. */
export interface ScenarioLog {
  /** Every `tools/call` params object, as it arrived upstream. */
  readonly toolCalls: Record<string, unknown>[];
  /** Every method that reached the server, in order. */
  readonly methods: string[];
  /** Every `_meta` the server saw on a `tools/call`, envelope merged in. */
  readonly metas: (Record<string, unknown> | undefined)[];
}

/**
 * A server that covers every behaviour the proxy has to survive.
 *
 * One server rather than four, because the interesting assertions are about one
 * *connection* carrying a mixture: a progress stream and a cancellation and a
 * plain call on the same wire is exactly where a leaky remap shows up.
 */
export function createScenarioServer(): { server: Server; log: ScenarioLog } {
  const log: ScenarioLog = { toolCalls: [], methods: [], metas: [] };
  const server = new Server(SCENARIO_INFO, {
    capabilities: SCENARIO_CAPABILITIES,
    instructions: 'Scenario server. Answers everything, usefully or otherwise.',
  });

  server.setRequestHandler('tools/list', (request) => {
    log.methods.push('tools/list');
    return {
      tools: [...ECHO_TOOLS],
      ...(request.params?.cursor !== undefined
        ? { nextCursor: `after:${request.params.cursor}` }
        : undefined),
    };
  });

  server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
    log.methods.push('tools/call');
    log.toolCalls.push({ ...request.params });
    log.metas.push({
      ...(request.params._meta as Record<string, unknown> | undefined),
      ...(ctx.mcpReq.envelope as Record<string, unknown> | undefined),
    });

    switch (request.params.name) {
      case 'slow': {
        const token = (request.params._meta as { progressToken?: unknown } | undefined)
          ?.progressToken;
        for (const step of [1, 2]) {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress: step, total: 2, message: `step ${step}` },
          });
        }
        return { content: [{ type: 'text', text: 'done' }] };
      }
      case 'hang':
        return new Promise<CallToolResult>((_resolve, reject) => {
          ctx.mcpReq.signal.addEventListener(
            'abort',
            () => {
              log.methods.push('tools/call:aborted');
              reject(new Error('upstream saw the abort'));
            },
            { once: true },
          );
        });
      case 'boom':
        return { isError: true, content: [{ type: 'text', text: 'ENOENT: no such file /tmp/a' }] };
      case 'throw':
        throw new Error('scenario server refuses');
      default:
        return {
          content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }],
        };
    }
  });

  server.setRequestHandler('resources/list', () => {
    log.methods.push('resources/list');
    return { resources: [{ uri: 'file:///scenario', name: 'scenario' }] };
  });

  // Everything else — including methods no spec defines — is answered by
  // echoing the method back, so a passthrough test can prove the request
  // actually reached the far end rather than being answered locally.
  server.fallbackRequestHandler = async (request) => {
    log.methods.push(request.method);
    return { reachedScenarioServer: request.method };
  };

  return { server, log };
}

/** A proxy plus the two clients around it, all connected. */
export interface Harness {
  /** The agent's end. */
  readonly client: Client;
  /** The proxy. */
  readonly bridge: Bridge;
  /** What the scenario server saw. */
  readonly log: ScenarioLog;
  /** The scenario server itself, for pushing notifications downstream. */
  readonly scenario: Server;
  close(): Promise<void>;
}

/** How a harness is built. */
export interface HarnessOptions {
  /** The guarded `tools/call` path. Defaults to forwarding everything. */
  readonly onToolCall?: ToolCallGate;
  /** Capabilities the agent declares. */
  readonly clientCapabilities?: ClientCapabilities;
  /** Identity the agent declares. */
  readonly clientInfo?: Implementation;
  /** Overrides the mirrored capabilities, for the tool-less-upstream case. */
  readonly capabilities?: ServerCapabilities;
  /** Out-of-band errors from either half. */
  readonly onError?: (error: Error) => void;
}

/** Builds `[test client] ⇄ proxy ⇄ [scenario server]`, connected and ready. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { server: scenario, log } = createScenarioServer();

  const [upstreamA, upstreamB] = InMemoryTransport.createLinkedPair();
  const upstream = new Client(
    { name: 'agentfuse', version: '0.0.0' },
    { capabilities: { sampling: {}, elicitation: {}, roots: {} } },
  );
  await Promise.all([scenario.connect(upstreamB), upstream.connect(upstreamA)]);

  const bridge = createBridge({
    client: upstream,
    serverInfo: upstream.getServerVersion() ?? SCENARIO_INFO,
    capabilities: options.capabilities ?? upstream.getServerCapabilities(),
    instructions: upstream.getInstructions(),
    onToolCall: options.onToolCall ?? ((call) => call.forward()),
    ...(options.onError !== undefined ? { onError: options.onError } : undefined),
  });

  const [downstreamA, downstreamB] = InMemoryTransport.createLinkedPair();
  const client = new Client(options.clientInfo ?? { name: 'test-agent', version: '9.9.9' }, {
    capabilities: options.clientCapabilities ?? { roots: {}, sampling: {}, elicitation: {} },
  });
  await Promise.all([bridge.server.connect(downstreamB), client.connect(downstreamA)]);

  return {
    client,
    bridge,
    log,
    scenario,
    close: async () => {
      await client.close();
      await bridge.close();
      await scenario.close();
    },
  };
}

/** A result schema that accepts anything, for probing non-spec methods. */
export const ANY_RESULT = {
  '~standard': {
    version: 1 as const,
    vendor: 'agentfuse-test',
    validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
  },
};

/**
 * The same harness, but with both legs driven through `serveStdio` over
 * in-memory transports, so it can be run in either era.
 *
 * Why `serveStdio` rather than a plain `Server` on each end: a low-level
 * `Server` cannot serve the modern era at all. Its inbound dispatch resolves
 * the wire codec from `_negotiatedProtocolVersion`, which stays unset (and
 * therefore legacy) until something binds it — and the only things that bind it
 * are `initialize` and the SDK-internal `setNegotiatedProtocolVersion` that the
 * serving entries call. Adding `2026-07-28` to `supportedProtocolVersions` is
 * not enough: the `server/discover` handler gets installed, but the request is
 * refused as "method not found" before reaching it, because the legacy codec
 * does not define the method. `serveStdio` is the public way through, and it
 * takes a caller-supplied transport, which is what makes this harness possible.
 */
export async function createServedHarness(options: {
  readonly era: 'legacy' | 'modern';
  readonly onToolCall?: ToolCallGate;
  readonly clientInfo?: Implementation;
}): Promise<Harness> {
  const { server: scenario, log } = createScenarioServer();
  const negotiation =
    options.era === 'modern'
      ? ({ mode: { pin: '2026-07-28' } } as const)
      : ({ mode: 'legacy' } as const);

  const [upstreamA, upstreamB] = InMemoryTransport.createLinkedPair();
  const upstreamEntry = serveStdio(() => scenario, { transport: upstreamB });
  const upstream = new Client(
    { name: 'agentfuse', version: '0.0.0' },
    { capabilities: { sampling: {}, elicitation: {}, roots: {} }, versionNegotiation: negotiation },
  );
  await upstream.connect(upstreamA);

  const bridge = createBridge({
    client: upstream,
    serverInfo: upstream.getServerVersion() ?? SCENARIO_INFO,
    capabilities: upstream.getServerCapabilities(),
    instructions: upstream.getInstructions(),
    onToolCall: options.onToolCall ?? ((call) => call.forward()),
  });

  const [downstreamA, downstreamB] = InMemoryTransport.createLinkedPair();
  const downstreamEntry = serveStdio(() => bridge.server, { transport: downstreamB });
  const client = new Client(options.clientInfo ?? { name: 'test-agent', version: '9.9.9' }, {
    capabilities: { roots: {} },
    versionNegotiation: negotiation,
  });
  await client.connect(downstreamA);

  return {
    client,
    bridge,
    log,
    scenario,
    close: async () => {
      await client.close();
      await downstreamEntry.close();
      await bridge.close();
      await upstreamEntry.close();
    },
  };
}
