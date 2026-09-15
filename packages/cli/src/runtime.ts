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
 * hook, the report directory and the semantic layer are all decided before it
 * is called, and `close()` takes them down again.
 *
 * Nothing in this file touches a transport, spawns a process or opens a socket.
 * That boundary is what makes the runtime testable without either.
 */

import {
  attachSemanticLoopDetector,
  type Decision,
  type DecisionHook,
  FuseEngine,
  type FusePolicy,
  type PolicyMode,
  type SemanticLoopDetector,
  type SessionSummary,
} from '@agentfuse/core';
import { Diagnostics } from '@agentfuse/proxy';
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
  /** Shuts the semantic layer down. Safe to call twice. */
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

/** Whether a policy asks for human approval anywhere. */
export function wantsApproval(policy: FusePolicy): boolean {
  return (
    policy.budgets.on_exceeded === 'require_approval' ||
    policy.loop_detection.on_trip === 'require_approval' ||
    policy.tools.some(
      (rule) =>
        rule.action === 'require_approval' || rule.loop_detection?.on_trip === 'require_approval',
    )
  );
}

/** Builds the engine, the report store and the semantic layer. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { loaded, context } = options;
  const quiet = options.quiet ?? false;
  const policy = withMode(loaded.policy, options.mode);

  const diagnostics = new Diagnostics({ quiet, sink: context.stderr });
  const warn = (lines: readonly string[]): void => {
    if (quiet) return;
    writeNotice(context.stderr, 'warning', lines);
  };

  const reports = new FileReportStore({
    dir: resolveFromPolicy(loaded, policy.report.dir),
    onError: (error) => diagnostics.emit('report_write_failed', { message: messageOf(error) }),
  });

  const tokenizer = new GptTokenizer();
  const engine = new FuseEngine(policy, {
    tokenizer,
    cost: costModelFor(policy.pricing),
  });

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

  // Phase 7 owns the approval flow. Until it lands, core's default gateway
  // denies — which is the right failure direction but a surprising one to
  // discover from a blocked call rather than from a line at startup.
  if (policy.mode === 'enforce' && wantsApproval(policy)) {
    warn([
      'This policy asks for human approval, and the approval gateway is not in this build yet.',
      'Approvals therefore fail closed: a call that needs one is denied without anybody being asked.',
      'Until then, use action: deny for what you want blocked and action: warn for what you want observed.',
    ]);
  }

  if (policy.telemetry.enabled) {
    warn([
      'telemetry.enabled is true, and OTLP export is not in this build yet.',
      'Nothing is being exported; decisions are still reported on stderr and in the trip reports.',
    ]);
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
    tokenizer,
    writeReport: reports.hook,
    onSessionEnd: (summary) => {
      detector?.forget(summary.sessionId);
    },
    close: async (closeOptions) => {
      if (closed) return;
      closed = true;
      if (detector === undefined) return;

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
