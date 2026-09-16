/**
 * Tier 1 — the engine's own cost, over `InMemoryTransport`.
 *
 * Three topologies, all in one process, all speaking real MCP:
 *
 * ```
 * (a) direct   client ⇄ pair ⇄ noop server
 * (b) rules    client ⇄ pair ⇄ bridge+guard ⇄ client' ⇄ pair ⇄ noop server
 * (c) semantic the same, with the real local embedder on the queue
 * ```
 *
 * The difference between (a) and (b) is therefore one extra in-process hop plus
 * everything `beforeCall`/`afterCall` do. That hop is not an artefact to be
 * subtracted away: a proxy *is* an extra hop, and a number that excluded it
 * would not be the number PRD §6 is budgeting.
 *
 * What this tier cannot see is serialisation across a pipe, which is why there
 * is a second tier.
 */

import type { EmbeddingProvider } from '@agentfuse/core';
import {
  FuseEngine,
  type FusePolicy,
  NoopTelemetrySink,
  parsePolicy,
  RecordingTelemetrySink,
  SemanticLoopDetector,
  type TelemetrySink,
} from '@agentfuse/core';
import { createBridge, createToolCallGuard } from '@agentfuse/proxy';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';

/**
 * A ~256-byte answer carrying the request's own path back. Matches
 * `bench/latency/noop-server.mjs` exactly, including why it varies: a tool that
 * answered identically every time would pin the semantic rule's staleness term
 * at 1.0, trip the breaker, and turn the benchmark into a measurement of
 * trip-report construction.
 */
const FILLER = 'ok '.repeat(80);
function payload(args: unknown): string {
  const path = (args as { path?: unknown } | undefined)?.path;
  return `${typeof path === 'string' ? path : 'none'} ${FILLER}`.slice(0, 256);
}

/** The in-process twin of the stdio fixture. */
function noopServer(): Server {
  const server = new Server(
    { name: 'noop', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: 'Answers immediately.' },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [{ name: 'noop', description: 'Answers immediately.', inputSchema: { type: 'object' } }],
  }));
  server.setRequestHandler('tools/call', (request) => ({
    content: [{ type: 'text', text: payload(request.params.arguments) }],
  }));
  return server;
}

/**
 * The policy the proxied configurations run under.
 *
 * `mode: warn`, which is the product's own default and the mode a latency
 * benchmark has to use: in `enforce` a trip would start denying calls and the
 * run would stop measuring anything. The budgets are raised out of reach for
 * the same reason — a session halted at call 200 for spending would truncate
 * the sample, and the cost of a budget check is already in every call that
 * comes before it.
 */
function benchPolicy(semantic: boolean): FusePolicy {
  return parsePolicy({
    version: 1,
    mode: 'warn',
    budgets: {
      max_calls: 1_000_000,
      max_duration: '24h',
      max_tokens_estimated: 1_000_000_000,
      max_usd_estimated: 1_000_000,
    },
    loop_detection: semantic ? {} : { semantic: { enabled: false, provider: 'none' } },
  });
}

/** One connected topology, ready to be called. */
export interface Rig {
  call(index: number): Promise<unknown>;
  close(): Promise<void>;
  /** Only present for (c): how much of the queue's work got done. */
  stats?(): Record<string, number>;
}

/** Which telemetry sink the engine carries. */
export type TelemetryMode = 'off' | 'on';

function sinkFor(mode: TelemetryMode): TelemetrySink {
  // `RecordingTelemetrySink` keeps every event, which is the *upper* bound on
  // what a sink costs on the hot path: the shipped OTLP sink builds a record
  // and pushes it onto a bounded queue whose draining happens on a timer. If
  // the difference between this and `Noop` is invisible, the shipped one's is
  // too. The real exporter, socket included, is measured in tier 2.
  return mode === 'on' ? new RecordingTelemetrySink() : new NoopTelemetrySink();
}

/** Arguments that never repeat, so no loop rule fires during the measurement. */
export function callArgs(index: number): Record<string, unknown> {
  return { path: `src/module-${index}.ts`, offset: index * 16 };
}

/** (a) — the client talks to the server with nothing in between. */
export async function directRig(): Promise<Rig> {
  const server = noopServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bench', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return {
    call: (index) => client.callTool({ name: 'noop', arguments: callArgs(index) }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** How a proxied rig is built. */
export interface ProxiedOptions {
  readonly telemetry: TelemetryMode;
  /** Present only for configuration (c). */
  readonly provider?: EmbeddingProvider | undefined;
}

/** (b) and (c) — the breaker in front of the same server. */
export async function proxiedRig(options: ProxiedOptions): Promise<Rig> {
  const server = noopServer();
  const [upstreamA, upstreamB] = InMemoryTransport.createLinkedPair();
  const upstream = new Client({ name: 'agentfuse', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(upstreamB), upstream.connect(upstreamA)]);

  const engine = new FuseEngine(benchPolicy(options.provider !== undefined), {
    telemetry: sinkFor(options.telemetry),
  });
  const detector =
    options.provider === undefined
      ? undefined
      : new SemanticLoopDetector({
          host: engine,
          provider: options.provider,
          clock: engine.ports.clock,
        }).attach();

  const guard = createToolCallGuard({
    engine,
    serverName: 'noop',
    sessionId: 'bench-session',
  });
  const bridge = createBridge({
    client: upstream,
    serverInfo: upstream.getServerVersion() ?? { name: 'noop', version: '1.0.0' },
    capabilities: upstream.getServerCapabilities(),
    instructions: upstream.getInstructions(),
    onToolCall: guard.gate,
  });

  const [downstreamA, downstreamB] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bench', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([bridge.server.connect(downstreamB), client.connect(downstreamA)]);

  return {
    call: (index) => client.callTool({ name: 'noop', arguments: callArgs(index) }),
    ...(detector !== undefined
      ? {
          stats: () => {
            const stats = detector.stats;
            return {
              offered: stats.offered,
              embedded: stats.embedded,
              droppedSampling: stats.droppedSampling,
              droppedOverflow: stats.droppedOverflow,
              depth: stats.depth,
            };
          },
        }
      : undefined),
    close: async () => {
      await client.close();
      await bridge.close();
      await upstream.close();
      await server.close();
      // The detector is deliberately not closed: it shares the provider with
      // every other configuration in the run, and `EmbeddingQueue.close()`
      // releases it.
      detector?.forget('bench-session');
    },
  };
}
