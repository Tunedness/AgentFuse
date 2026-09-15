/**
 * Everything `wrap` and `serve` need, assembled once.
 *
 * The engine is pure and takes its edges as ports; this is where the CLI's
 * adapters get plugged in. Three of them belong to the CLI because they are the
 * three things core is not allowed to do:
 *
 * - **`Tokenizer`** — `gpt-tokenizer`, `o200k_base`. See `tokenizer.ts` for why
 *   not `bytes/4`.
 * - **`CostModel`** — core's own `TableCostModel`, fed from the policy's
 *   `pricing` block. Re-used rather than rewritten.
 * - **report writing** — the filesystem. `report.dir` is the CLI's, because the
 *   proxy does no file I/O at all.
 *
 * `Clock`, `IdGenerator` and `SessionStore` are left to core's defaults
 * (`SystemClock`, `UlidGenerator`, `InMemorySessionStore`): those adapters
 * already exist there and writing second copies here would only create two
 * places for the same bug.
 *
 * The semantic layer is attached here or not at all, following the table in
 * `embeddings.ts`. Phase 3 left two instructions that this file carries out:
 * call `detector.forget(sessionId)` once a session has ended, because the
 * detector cannot see a session leave the store, and read `SemanticLoopStats`
 * yourself — queue failures are deliberately not `TelemetrySink` events, since
 * umbrella ADR-003 fixes that schema at four event types and "the embedding
 * backend is sick" is none of them.
 *
 * ## The seam this leaves for `wrap` and `serve`
 *
 * A {@link Runtime} is the argument set the proxy's serving entries take, and
 * nothing more. `wrapStdioServer` wants `engine`, `serverName`, `diagnostics`,
 * `writeReport` and `onSessionEnd`; the last two are the hooks the proxy left
 * open and they are fields here, already bound. A serving command's own job is
 * therefore the transport and the child process — the policy, the ports, the
 * hook, the report directory, the approval channel and the semantic layer are
 * all decided before it is called, and `close()` takes them down again.
 *
 * ## Why the approval socket is opened here
 *
 * The engine takes its {@link ApprovalGateway} as a constructor port, so the
 * channel has to exist before the engine does — which rules out a serving
 * command opening it and handing it over. It is also derived from the policy in
 * exactly the way the embedding provider is (`approvals.gateways`, the
 * timeout, the webhook block), and that resolution already lives here. So the
 * socket is bound in `createRuntime` and released by `close()`, and `wrap` and
 * `serve` need no line about approvals at all.
 *
 * The consequence is that this file does touch the filesystem and does bind a
 * listener. Both are injectable: `RuntimeOptions.approvals` replaces the whole
 * channel, and `AGENTFUSE_APPROVAL_SOCKET` moves the path, so the runtime is
 * still testable without going near a real `$HOME`.
 */

import { userInfo } from 'node:os';
import {
  type ApprovalGateway,
  attachSemanticLoopDetector,
  type Decision,
  type DecisionHook,
  FuseEngine,
  type FusePolicy,
  type PolicyMode,
  type SemanticLoopDetector,
  type SessionSummary,
} from '@agentfuse/core';
import type { Diagnostics, StdioWrapOptions } from '@agentfuse/proxy';
import { type ApprovalResolution, resolveApprovalGateway } from './approvals/index.js';
import { type LoadedPolicy, resolveFromPolicy } from './config.js';
import {
  type EmbeddingsLoader,
  resolveEmbeddingProvider,
  semanticRequestOf,
} from './embeddings.js';
import { messageOf } from './errors.js';
import { loadDecisionHook, type ModuleLoader } from './hook.js';
import { type CliContext, writeNotice } from './io.js';
import { FileReportStore } from './reports.js';
import { ObservedDiagnostics } from './telemetry/diagnostics.js';
import { type ResolveTelemetryOptions, resolveTelemetry } from './telemetry/index.js';
import type { OtlpTelemetrySink } from './telemetry/sink.js';
import { costModelFor, GptTokenizer } from './tokenizer.js';

/**
 * How long {@link Runtime.close} waits for the embedding layer to let go.
 *
 * `SemanticLoopDetector.close()` awaits the batch in flight and then the
 * provider's own `close()`, so a wedged model wedges that await. A proxy being
 * shut down has to actually shut down, and an unscored tail of the window
 * costs nothing at that point.
 */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/** How a {@link Runtime} is built. */
export interface RuntimeOptions {
  readonly loaded: LoadedPolicy;
  readonly context: CliContext;
  /** `--quiet`. Silences AgentFuse's own stderr, including the warnings here. */
  readonly quiet?: boolean;
  /** `--mode`, overriding the policy's own. */
  readonly mode?: PolicyMode | undefined;
  /** `--hook`. */
  readonly hook?: string | undefined;
  /**
   * Replaces the approval channel outright.
   *
   * Production leaves this alone: the channel is derived from
   * `approvals.gateways` by `approvals/index.ts`, which is where the decision
   * table lives. This is how a test drives a blocked call without binding a
   * socket, and how an embedder that already has a human in the loop supplies
   * their own.
   */
  readonly approvals?: ApprovalGateway | undefined;
  /**
   * Telemetry seams: an injected `fetch`, clock, id source and batching knobs.
   *
   * Never set in production — the endpoint and the on/off switch come from the
   * policy, exactly like every other row of a decision table in this package.
   */
  readonly telemetry?: Omit<ResolveTelemetryOptions, 'policy' | 'onDiagnostic'> | undefined;
  /** Injected for tests. */
  readonly loadEmbeddings?: EmbeddingsLoader | undefined;
  /** Injected for tests. */
  readonly loadHookModule?: ModuleLoader | undefined;
}

/** The assembled machine. */
export interface Runtime {
  readonly engine: FuseEngine;
  /** The policy actually in force, after any `--mode` override. */
  readonly policy: FusePolicy;
  /** Where `report.dir` resolved to, and the reader for it. */
  readonly reports: FileReportStore;
  /** AgentFuse's own stderr. Already carries `--quiet`. */
  readonly diagnostics: Diagnostics;
  /** Whether diagnostics are silenced. */
  readonly quiet: boolean;
  /** `undefined` when the semantic layer is off or unavailable. */
  readonly detector: SemanticLoopDetector | undefined;
  /**
   * The OTLP sink, when `telemetry.enabled` is true and the endpoint is usable.
   *
   * `undefined` is the default and means the engine keeps core's
   * `NoopTelemetrySink`: nothing is queued, no timer is armed and no socket is
   * ever opened. See the table in `telemetry/index.ts`.
   */
  readonly telemetry: OtlpTelemetrySink | undefined;
  /**
   * The approval channel in force.
   *
   * `undefined` means the engine keeps core's `DenyAllApprovalGateway`, which
   * is the right direction and the normal state of a `warn`-mode run: see the
   * table in `approvals/index.ts`.
   */
  readonly approvals: ApprovalGateway | undefined;
  /** The bound approval socket, when there is one. Named in every prompt. */
  readonly approvalSocket: string | undefined;
  readonly tokenizer: GptTokenizer;
  /**
   * `ToolCallGuardOptions.writeReport`, bound.
   *
   * Hand it straight to `wrapStdioServer` or `createToolCallGuard`: the proxy
   * does no file I/O, and the path it shows the agent is whatever this returns.
   */
  readonly writeReport: (decision: Decision) => string | undefined;
  /**
   * `ToolCallGuardOptions.onSessionEnd`, bound.
   *
   * The proxy calls this after `engine.endSession()`, with the summary. Phase
   * 3's note lands here: the detector cannot observe a session leaving the
   * store, so it is told, and would otherwise hold that window until the LRU
   * bound pushed it out.
   */
  readonly onSessionEnd: (summary: SessionSummary) => void;
  /**
   * `ToolCallGuardOptions.traceparentFor`, bound — or `undefined`.
   *
   * `undefined` whenever there is no OTLP sink, which is the default and every
   * `telemetry.enabled: false` run: the proxy then forwards the agent's
   * `traceparent` verbatim, exactly as it did before this existed. With a sink
   * it returns the span that call was already given, so the guarded server's
   * work is a child of AgentFuse's span rather than a sibling of it.
   */
  readonly traceparentFor: StdioWrapOptions['traceparentFor'];
  /** Releases the semantic layer and the approval socket. Safe to call twice. */
  close(options?: { readonly timeoutMs?: number }): Promise<void>;
}

/**
 * Applies `--mode`.
 *
 * Returns the argument unchanged when there is nothing to change, so the
 * common path does not copy a document for no reason. An override that does
 * land changes the compiled policy's `sha256`, and deliberately: a trip report
 * has to identify the policy that was in force, not the file it came from.
 */
export function withMode(policy: FusePolicy, mode: PolicyMode | undefined): FusePolicy {
  if (mode === undefined || mode === policy.mode) return policy;
  return { ...policy, mode };
}

/**
 * Whether a policy asks for human approval anywhere.
 *
 * Defined next to the gateway decision table it feeds, and re-exported here
 * because this is where it was first needed and where callers look for it.
 */
export { wantsApproval } from './approvals/index.js';

/**
 * This user's numeric id, where the platform has one.
 *
 * Used to prove the approval socket and its directory belong to us.
 * `undefined` twice over: on Windows, where `uid` is reported as `-1` and there
 * is nothing of the sort to compare; and inside a container run with an
 * arbitrary `--user`, where `userInfo` throws because the uid has no passwd
 * entry. Neither is a reason to refuse to start — they are reasons the
 * ownership check cannot be made, and the socket layer skips it.
 *
 * The reader is a parameter so both of those are a test rather than a comment.
 */
export function currentUid(read: () => { readonly uid: number } = userInfo): number | undefined {
  try {
    const uid = read().uid;
    return uid >= 0 ? uid : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the engine, the report store and the semantic layer. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { loaded, context } = options;
  const quiet = options.quiet ?? false;
  const policy = withMode(loaded.policy, options.mode);

  // The single `Diagnostics` of a run, with the OTLP sink hung off it as a
  // second reader. Phase 6b's rule holds — one instance, one rate-limit window
  // — and the observer is a holder rather than an argument because the sink
  // needs somewhere to report a failed export, which is this same object.
  let observe: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  const diagnostics: Diagnostics = new ObservedDiagnostics(
    { quiet, sink: context.stderr },
    (event, fields) => observe?.(event, fields),
  );
  const warn = (lines: readonly string[]): void => {
    if (quiet) return;
    writeNotice(context.stderr, 'warning', lines);
  };

  const reports = new FileReportStore({
    dir: resolveFromPolicy(loaded, policy.report.dir),
    onError: (error) => diagnostics.emit('report_write_failed', { message: messageOf(error) }),
  });

  // Before the engine, because the engine takes the gateway as a port. An
  // injected gateway skips the table entirely, so a test never binds a socket
  // it did not ask for.
  const approvals: ApprovalResolution =
    options.approvals === undefined
      ? await resolveApprovalGateway({
          policy,
          env: context.env,
          diagnostics,
          // Deliberately `context.stderr` and not the `warn` above: a pending
          // prompt is the policy's own question and is not silenced by
          // `--quiet`. See `approvals/cli-gateway.ts`.
          stderr: context.stderr,
          warn,
          uid: currentUid(),
          // Distinguishes this process's fallback socket from another wrap's,
          // and is informative in `ls`. Read-only ambient state, like
          // `process.env`, which is why it is not on `ProcessHost`.
          suffix: String(process.pid),
        })
      : {
          kind: 'ready',
          gateway: options.approvals,
          sources: ['injected'],
          socketPath: undefined,
          bindHost: () => undefined,
          close: async () => undefined,
        };

  // Before the engine too: the sink is a constructor port, like the gateway.
  const telemetry = resolveTelemetry({
    ...options.telemetry,
    policy,
    onDiagnostic: (event, fields) => diagnostics.emit(event, fields),
  });
  if (telemetry.kind === 'degraded') {
    warn(telemetry.warning);
    diagnostics.emit('telemetry_unavailable', { endpoint: policy.telemetry.otlp_endpoint });
  }
  const sink = telemetry.kind === 'ready' ? telemetry.sink : undefined;

  const tokenizer = new GptTokenizer();
  const engine = new FuseEngine(policy, {
    tokenizer,
    cost: costModelFor(policy.pricing),
    ...(approvals.kind === 'ready' ? { approvals: approvals.gateway } : undefined),
    ...(sink !== undefined ? { telemetry: sink } : undefined),
  });

  if (telemetry.kind === 'ready') {
    // Late, for the same reason the approval host is: the sink existed before
    // the engine did. The lookup reads the inbound `traceparent` off the
    // in-flight record, which is the only place it lives — the proxy puts it
    // there through `beforeCall` and forwards it upstream itself.
    telemetry.sink.bindCallLookup(
      (sessionId, callId) =>
        engine.ports.sessions.get(sessionId)?.inFlight.get(callId)?.traceparent,
    );
    observe = (event, fields) => telemetry.sink.observeDiagnostic(event, fields);
    diagnostics.emit('telemetry_enabled', {
      endpoint: telemetry.endpoint,
      service: policy.telemetry.service_name,
    });
  }

  if (approvals.kind === 'ready') {
    // Late, and it has to be: the socket was listening before the engine
    // existed. `resetBreaker` reports the resulting phase so the person who
    // typed `approve --reset` is told what actually happened — and `undefined`
    // for a session this wrap has never had, rather than a false success.
    approvals.bindHost({
      resetBreaker: (sessionId) => {
        const session = engine.ports.sessions.get(sessionId);
        if (session === undefined) return undefined;
        engine.resetBreaker(sessionId);
        return engine.ports.sessions.get(sessionId)?.breaker.phase;
      },
    });
  } else {
    diagnostics.emit('approval_gateway_off', { reason: approvals.reason });
  }

  diagnostics.emit('policy_loaded', {
    path: loaded.path,
    origin: loaded.origin,
    mode: policy.mode,
    sha256: engine.policy.sha256.slice(0, 12),
    reportDir: reports.dir,
    tokenizer: tokenizer.id,
  });

  if (options.hook !== undefined) {
    const hook: DecisionHook = await loadDecisionHook(
      options.hook,
      context.cwd,
      options.loadHookModule,
    );
    engine.onDecision(hook);
    diagnostics.emit('hook_loaded', { hook: options.hook });
  }

  const resolution = await resolveEmbeddingProvider({
    request: semanticRequestOf(engine.policy),
    mode: policy.mode,
    ...(options.loadEmbeddings !== undefined ? { load: options.loadEmbeddings } : undefined),
  });

  let attached: SemanticLoopDetector | undefined;
  if (resolution.kind === 'ready') {
    attached = attachSemanticLoopDetector({
      host: engine,
      provider: resolution.provider,
      clock: engine.ports.clock,
      telemetry: engine.ports.telemetry,
    });
    diagnostics.emit('semantic_attached', {
      provider: resolution.provider.id,
      dims: resolution.provider.dims,
    });
  } else if (resolution.kind === 'degraded') {
    warn(resolution.warning);
    diagnostics.emit('semantic_unavailable', { mode: policy.mode });
  } else {
    diagnostics.emit('semantic_off', { reason: resolution.reason });
  }

  const detector = attached;
  let closed = false;

  return {
    engine,
    policy,
    reports,
    diagnostics,
    quiet,
    detector,
    telemetry: sink,
    approvals: approvals.kind === 'ready' ? approvals.gateway : undefined,
    approvalSocket: approvals.kind === 'ready' ? approvals.socketPath : undefined,
    tokenizer,
    writeReport: reports.hook,
    onSessionEnd: (summary) => {
      detector?.forget(summary.sessionId);
    },
    // Bound to the sink or not bound at all: the decision minted the span, and
    // the guard asks for it by call id just before it forwards.
    traceparentFor:
      sink === undefined ? undefined : (_call, decision) => sink.traceparentFor(decision.callId),
    close: async (closeOptions) => {
      if (closed) return;
      closed = true;
      // First, and unconditionally: the socket is a file on disk, and a wrap
      // that exited without removing it leaves the next one a stale path to
      // reason about.
      if (approvals.kind === 'ready') await approvals.close();
      // Last, and also unconditionally: the exporter flushes what is queued and
      // writes its counters, and it has to see the lines written on the way out
      // (`semantic_stats`, `wrap_end`) before it goes.
      const flush = async (): Promise<void> => {
        await sink?.shutdown();
      };
      if (detector === undefined) {
        await flush();
        return;
      }

      const stats = detector.stats;
      // Queue failures are deliberately not telemetry events (umbrella ADR-003
      // fixes that schema at four types), so the host logs them. A run whose
      // embeddings mostly failed produced a weaker report than its numbers
      // suggest, and that has to be visible somewhere.
      diagnostics.emit('semantic_stats', {
        offered: stats.offered,
        embedded: stats.embedded,
        droppedOverflow: stats.droppedOverflow,
        droppedSampling: stats.droppedSampling,
        batches: stats.batches,
        failures: stats.failures,
        skipped: stats.skipped,
        trips: stats.trips,
        sampling: stats.sampling,
        depth: stats.depth,
      });

      const timeoutMs = closeOptions?.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
      await withTimeout(detector.close(), timeoutMs, () =>
        diagnostics.emit('semantic_close_timeout', { timeoutMs }),
      );
      await flush();
    },
  };
}

/**
 * Awaits a promise, giving up after `ms`. Never rejects, and never leaves the
 * work unhandled.
 *
 * The handler is attached before the race and in the give-up path too: the
 * work has already started by the time this is called, so dropping the
 * reference without one turns a provider that rejects during shutdown into an
 * unhandled rejection, which on Node 20 and later ends the process.
 *
 * Exported for its own test rather than for use: the package's only public
 * entry is `index.ts`, and `EmbeddingQueue.close()` swallows a provider's
 * rejection before this ever sees it, so the rejecting path is reachable from
 * a test and from nowhere else.
 */
export async function withTimeout(
  work: Promise<unknown>,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  const settled = work.then(
    () => 'done' as const,
    // A provider that cannot close cleanly has nothing left to break.
    () => 'done' as const,
  );
  if (ms <= 0) {
    onTimeout();
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    // Unreferenced, so a shutdown that finishes first is not held open by a
    // timer nobody is waiting for any more.
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    if ((await Promise.race([settled, expiry])) === 'timeout') onTimeout();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
