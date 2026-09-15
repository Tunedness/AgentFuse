/**
 * Wrap mode: AgentFuse between an agent and one stdio MCP server.
 *
 * This is the MVP's primary mode and the one ADR-006 calls exact: **one child
 * process = one downstream connection = one session.** The session id is a ULID
 * from the engine's own `IdGenerator`, minted when the connection opens and
 * retired when the pipe closes. No heuristics, no gaps.
 *
 * ## stdout and stderr
 *
 * The child is spawned `stdio: ['pipe', 'pipe', 'inherit']`, which the SDK's
 * `StdioClientTransport` does for us when `stderr` is left at its default. That
 * matters more than it looks: stdio MCP servers log everything to stderr, and a
 * proxy that buffered, re-prefixed or line-split that output would make
 * AgentFuse look like the thing that broke the server. Inheriting the fd means
 * the bytes never enter this process at all — the strongest possible form of
 * "untouched".
 *
 * In the other direction, **nothing but protocol frames is ever written to
 * stdout.** One `console.log` corrupts the JSON-RPC stream for every message
 * after it, and a client that sees a parse error blames the server. AgentFuse's
 * own output goes to stderr through {@link Diagnostics}, prefixed and
 * rate-limited, and silenced entirely by `--quiet`. `boundary.test.ts` fails
 * the build if any file in this package reaches for stdout or `console`.
 *
 * ## Era transparency
 *
 * `serveStdio` owns the era decision for the downstream connection — it is the
 * only public way to serve the modern era, because binding an instance to a
 * 2026-07-28 revision needs SDK internals. It hands the era to the factory, and
 * the factory negotiates the upstream connection to match: a legacy downstream
 * gets a legacy upstream, a modern downstream gets an upstream pinned to
 * 2026-07-28. That is what "era-transparent" means operationally, and
 * {@link assertSameEra} checks it rather than trusting it.
 *
 * One consequence worth knowing: on a modern opening `serveStdio` may build a
 * probe instance and discard it if the client falls back to `initialize`, so
 * the child can be spawned twice for one connection in that fallback case. The
 * teardown on {@link Server.onclose} makes the discarded one clean up after
 * itself.
 */

import type { SessionSummary } from '@agentfuse/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type {
  ClientCapabilities,
  Implementation,
  Server,
  Transport,
} from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Bridge, createBridge } from './bridge.js';
import { Diagnostics } from './diagnostics.js';
import { assertSameEra, eraOfConnection, FIRST_MODERN_PROTOCOL_VERSION } from './era.js';
import { createToolCallGuard, type ToolCallGuardOptions } from './tools-call.js';

/**
 * The client capabilities AgentFuse declares to the guarded server.
 *
 * A deliberate over-declaration, and the one honest compromise in this file.
 * The proxy has to answer the downstream `initialize` with the *upstream's*
 * capabilities, so the upstream connection must be established first — before
 * the real client has told us what it supports. Declaring nothing would make
 * sampling, elicitation and roots permanently unavailable through the proxy;
 * declaring what the proxy can *relay* keeps them working for the overwhelming
 * majority of clients, which declare all three.
 *
 * The failure mode when a client declares less: the guarded server may attempt
 * a push the real client cannot serve, and gets a capability error from the
 * downstream `Server` instead of not trying. Override with
 * {@link StdioWrapOptions.clientCapabilities} when the real client's set is
 * known — which is what the CLI will do.
 */
export const RELAYABLE_CLIENT_CAPABILITIES: ClientCapabilities = {
  sampling: {},
  elicitation: {},
  roots: {},
};

/** Identity AgentFuse presents upstream when the caller supplies none. */
const DEFAULT_CLIENT_INFO: Implementation = { name: 'agentfuse', version: '0.0.0' };

/** How a {@link wrapStdioServer} behaves. */
export interface StdioWrapOptions
  extends Pick<
    ToolCallGuardOptions,
    'engine' | 'serverName' | 'annotationsFor' | 'writeReport' | 'onSessionEnd'
  > {
  /** The executable to run. */
  readonly command: string;
  /** Arguments for it. */
  readonly args?: readonly string[];
  /**
   * Environment for the child.
   *
   * Defaults to the parent's, minus unset variables — **not** to the SDK's
   * `getDefaultEnvironment()` allowlist. A wrapper that silently dropped the
   * API key a server needs would look like AgentFuse breaking the server, which
   * is the failure this whole file is organised around avoiding.
   */
  readonly env?: Record<string, string>;
  /** Working directory for the child. Inherited when omitted. */
  readonly cwd?: string;
  /** Identity to present to the guarded server. */
  readonly clientInfo?: Implementation;
  /** Capabilities to declare upstream. See {@link RELAYABLE_CLIENT_CAPABILITIES}. */
  readonly clientCapabilities?: ClientCapabilities;
  /** Silences AgentFuse's own stderr output. What `--quiet` sets. */
  readonly quiet?: boolean;
  /** Bring your own diagnostics sink. Defaults to stderr. */
  readonly diagnostics?: Diagnostics;
  /** Downstream transport. Defaults to this process's stdio. */
  readonly transport?: Transport;
  /** Per-request timeout for forwarded requests, in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Out-of-band error reporting. */
  readonly onError?: (error: Error) => void;
}

/** A running wrap. */
export interface StdioWrapHandle {
  /** Tears down the connection, the child process and the session. */
  close(): Promise<void>;
  /** The session id of the live connection, once one has opened (ADR-006). */
  readonly sessionId: string | undefined;
  /** The bridge of the live connection, for tests and for the CLI's status output. */
  readonly bridge: Bridge | undefined;
}

/** The parent environment with unset variables dropped. */
function inheritedEnvironment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Puts AgentFuse between this process's stdio and one child MCP server.
 *
 * Returns as soon as the downstream transport is listening; the child is
 * spawned when the agent opens the connection, so a wrap nobody talks to never
 * starts a process.
 */
export function wrapStdioServer(options: StdioWrapOptions): StdioWrapHandle {
  const diagnostics = options.diagnostics ?? new Diagnostics({ quiet: options.quiet ?? false });
  const report = (error: Error): void => {
    diagnostics.emit('error', { message: error.message });
    options.onError?.(error);
  };

  let live: { bridge: Bridge; sessionId: string; endSession: () => SessionSummary } | undefined;

  const teardown = (instance: NonNullable<typeof live>): void => {
    if (live === instance) live = undefined;
    // Order matters: end the session first so its totals are computed while the
    // engine still has the record, then drop the connections.
    const summary = instance.endSession();
    diagnostics.emit('session_end', {
      sessionId: summary.sessionId,
      calls: summary.calls,
      errorCalls: summary.errorCalls,
      durationMs: summary.durationMs,
      // ADR-007: an estimate carries its caveat in the name, everywhere.
      tokensEstimated: summary.tokensEstimated.total,
      usdEstimated: Number(summary.usdEstimated.toFixed(6)),
      breaker: summary.breakerPhase,
      degraded: summary.degraded,
    });
    instance.bridge.close().catch(report);
  };

  const handle: StdioServerHandle = serveStdio(
    async ({ era }): Promise<Server> => {
      const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, {
        capabilities: options.clientCapabilities ?? RELAYABLE_CLIENT_CAPABILITIES,
        // Era transparency: the downstream era, decided by the entry above,
        // selects how the upstream connection negotiates. `pin` rather than
        // `auto` on the modern side, because `auto` is allowed to fall back to
        // the legacy handshake and that would put an era boundary inside the
        // proxy — the one thing ADR-005 rules out.
        versionNegotiation:
          era === 'modern' ? { mode: { pin: FIRST_MODERN_PROTOCOL_VERSION } } : { mode: 'legacy' },
        // An `input_required` result belongs to the agent's client, not to the
        // proxy's: auto-fulfilling it here would answer with the proxy's own
        // (empty) elicitation handlers.
        inputRequired: { autoFulfill: false },
      });
      client.onerror = report;

      await client.connect(
        new StdioClientTransport({
          command: options.command,
          args: [...(options.args ?? [])],
          env: options.env ?? inheritedEnvironment(),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : undefined),
          // The default, restated because it is load-bearing: the child's
          // stderr is the parent's fd, so its bytes never pass through this
          // process and cannot be mangled by it.
          stderr: 'inherit',
        }),
      );

      assertSameEra(
        era,
        eraOfConnection(client),
        `upstream=${options.serverName} command=${options.command}`,
      );

      const sessionId = options.engine.ports.ids.next();
      const guard = createToolCallGuard({
        engine: options.engine,
        serverName: options.serverName,
        sessionId,
        diagnostics,
        ...(options.annotationsFor !== undefined
          ? { annotationsFor: options.annotationsFor }
          : undefined),
        ...(options.writeReport !== undefined ? { writeReport: options.writeReport } : undefined),
        ...(options.onSessionEnd !== undefined
          ? { onSessionEnd: options.onSessionEnd }
          : undefined),
      });

      const upstreamInfo = client.getServerVersion();
      const bridge = createBridge({
        client,
        // Mirrored, not invented: the agent negotiates against the real
        // server's identity, capabilities and instructions, and only the
        // `tools/call` answers differ from talking to it directly.
        serverInfo: upstreamInfo ?? { name: options.serverName, version: '0.0.0' },
        capabilities: client.getServerCapabilities(),
        instructions: client.getInstructions(),
        onToolCall: guard.gate,
        onError: report,
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : undefined),
      });

      const instance = { bridge, sessionId, endSession: guard.endSession };
      live = instance;
      let torn = false;
      bridge.server.onclose = () => {
        if (torn) return;
        torn = true;
        teardown(instance);
      };

      diagnostics.emit('session_start', {
        sessionId,
        era,
        server: options.serverName,
        upstream: upstreamInfo?.name ?? options.command,
        protocolVersion: client.getNegotiatedProtocolVersion(),
      });

      return bridge.server;
    },
    {
      ...(options.transport !== undefined ? { transport: options.transport } : undefined),
      onerror: report,
    },
  );

  return {
    get sessionId() {
      return live?.sessionId;
    },
    get bridge() {
      return live?.bridge;
    },
    close: async () => {
      await handle.close();
      const instance = live;
      if (instance !== undefined) {
        live = undefined;
        await instance.bridge.close();
      }
    },
  };
}
