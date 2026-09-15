import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EmbeddingProvider } from '@agentfuse/core';
import { HashingProvider } from '@agentfuse/core/testing';
import { DIAGNOSTIC_PREFIX } from '@agentfuse/proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy } from './config.js';
import type { EmbeddingsLoader } from './embeddings.js';
import type { CliError } from './errors.js';
import { type CliContext, StringWriter } from './io.js';
import {
  createRuntime,
  DEFAULT_CLOSE_TIMEOUT_MS,
  wantsApproval,
  withMode,
  withTimeout,
} from './runtime.js';

let root: string;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-runtime-'));
  stdout = new StringWriter();
  stderr = new StringWriter();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

function context(): CliContext {
  return { argv: [], stdout, stderr, env: {}, cwd: root };
}

/** A policy file plus the loaded form of it. */
function policyFile(contents: string) {
  write('fusepolicy.yaml', contents);
  return loadPolicy({ cwd: root });
}

/** The loader shape for a package that is not there. */
const missing: EmbeddingsLoader = async () => {
  throw new Error("Cannot find package '@agentfuse/embeddings-local'");
};

/** A loader that supplies a provider, standing in for phase 4. */
const providing =
  (provider: EmbeddingProvider): EmbeddingsLoader =>
  async () => ({ createEmbeddingProvider: async () => provider });

/** Every diagnostic event name written so far. */
function events(): string[] {
  return stderr.lines
    .filter((line) => line.startsWith(DIAGNOSTIC_PREFIX))
    .flatMap((line) => {
      try {
        const payload: unknown = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length).trim());
        const event = (payload as { event?: unknown }).event;
        return typeof event === 'string' ? [event] : [];
      } catch {
        return [];
      }
    });
}

describe('withMode', () => {
  it('leaves the policy alone when there is nothing to change', () => {
    const { policy } = policyFile('version: 1\nmode: warn\n');

    expect(withMode(policy, undefined)).toBe(policy);
    expect(withMode(policy, 'warn')).toBe(policy);
  });

  it('overrides the mode without touching anything else', () => {
    const { policy } = policyFile('version: 1\nmode: warn\nbudgets:\n  max_calls: 7\n');

    const overridden = withMode(policy, 'enforce');

    expect(overridden.mode).toBe('enforce');
    expect(overridden.budgets.max_calls).toBe(7);
    expect(policy.mode).toBe('warn');
  });
});

describe('wantsApproval', () => {
  it.each([
    ['a budget', 'version: 1\nbudgets:\n  on_exceeded: require_approval\n'],
    ['a loop trip', 'version: 1\nloop_detection:\n  on_trip: require_approval\n'],
    ['a tool rule', 'version: 1\ntools:\n  - match: "shell__*"\n    action: require_approval\n'],
    [
      'a per-rule loop override',
      'version: 1\ntools:\n  - match: "shell__*"\n    action: allow\n    loop_detection:\n      on_trip: require_approval\n',
    ],
  ])('finds it asked for by %s', (_label, contents) => {
    expect(wantsApproval(policyFile(contents).policy)).toBe(true);
  });

  it('is false for a policy that never asks', () => {
    expect(
      wantsApproval(
        policyFile('version: 1\nbudgets:\n  on_exceeded: halt\nloop_detection:\n  on_trip: halt\n')
          .policy,
      ),
    ).toBe(false);
  });
});

describe('createRuntime', () => {
  const OFF = 'version: 1\nloop_detection:\n  semantic:\n    provider: none\n';

  it('injects the CLI`s tokenizer and cost model, and core`s own clock and ids', async () => {
    const runtime = await createRuntime({ loaded: policyFile(OFF), context: context() });

    expect(runtime.engine.ports.tokenizer).toBe(runtime.tokenizer);
    expect(runtime.tokenizer.id).toBe('gpt-tokenizer:o200k_base');
    // Core's adapters, not second copies of them.
    expect(runtime.engine.ports.clock.constructor.name).toBe('SystemClock');
    expect(runtime.engine.ports.ids.constructor.name).toBe('UlidGenerator');
    expect(runtime.engine.ports.sessions.constructor.name).toBe('InMemorySessionStore');

    await runtime.close();
  });

  it('prices from the policy`s own table', async () => {
    const runtime = await createRuntime({
      loaded: policyFile(`${OFF}pricing:\n  input_per_mtok_usd: 10\n  output_per_mtok_usd: 20\n`),
      context: context(),
    });

    expect(runtime.engine.ports.cost.estimateUsd({ input: 1_000_000, output: 0 })).toBeCloseTo(10);

    await runtime.close();
  });

  it('resolves report.dir against the policy file', async () => {
    const loaded = policyFile(`${OFF}report:\n  dir: trips\n`);

    const runtime = await createRuntime({ loaded, context: context() });

    expect(runtime.reports.dir).toBe(join(root, 'trips'));

    await runtime.close();
  });

  it('applies --mode, and the override changes the policy sha the report will carry', async () => {
    const loaded = policyFile(OFF);
    const warnRuntime = await createRuntime({ loaded, context: context() });
    const enforceRuntime = await createRuntime({ loaded, context: context(), mode: 'enforce' });

    expect(warnRuntime.policy.mode).toBe('warn');
    expect(enforceRuntime.policy.mode).toBe('enforce');
    expect(enforceRuntime.engine.policy.sha256).not.toBe(warnRuntime.engine.policy.sha256);

    await warnRuntime.close();
    await enforceRuntime.close();
  });

  it('writes nothing to stdout, ever', async () => {
    // In wrap mode stdout is the agent's JSON-RPC stream.
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nmode: warn\ntelemetry:\n  enabled: true\n'),
      context: context(),
      loadEmbeddings: missing,
    });

    // Two warnings and several events went somewhere, and none of it here.
    expect(stderr.text).not.toBe('');
    expect(stdout.text).toBe('');

    await runtime.close();
  });

  it('says where the policy came from, once, on stderr', async () => {
    const runtime = await createRuntime({ loaded: policyFile(OFF), context: context() });

    expect(events()).toContain('policy_loaded');
    expect(stderr.text).toContain('"origin":"search"');
    expect(stderr.text).toContain(join(root, 'fusepolicy.yaml'));

    await runtime.close();
  });

  it('is silent under --quiet', async () => {
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nmode: warn\ntelemetry:\n  enabled: true\n'),
      context: context(),
      quiet: true,
      loadEmbeddings: missing,
    });

    expect(stderr.text).toBe('');
    expect(runtime.quiet).toBe(true);

    await runtime.close();
  });
});

describe('the warnings a runtime gives at startup', () => {
  it('says approvals fail closed until phase 7 lands', async () => {
    const runtime = await createRuntime({
      loaded: policyFile(
        'version: 1\nmode: enforce\nloop_detection:\n  semantic:\n    provider: none\ntools:\n  - match: "shell__*"\n    action: require_approval\n',
      ),
      context: context(),
    });

    expect(stderr.text).toContain('asks for human approval');
    expect(stderr.text).toContain('fail closed');

    await runtime.close();
  });

  it('does not warn about approvals in warn mode, where none are asked', async () => {
    const runtime = await createRuntime({
      loaded: policyFile(
        'version: 1\nmode: warn\nloop_detection:\n  semantic:\n    provider: none\ntools:\n  - match: "*"\n    action: require_approval\n',
      ),
      context: context(),
    });

    expect(stderr.text).not.toContain('asks for human approval');

    await runtime.close();
  });

  it('says telemetry is not exported yet when it was asked for', async () => {
    const runtime = await createRuntime({
      loaded: policyFile(`${'version: 1\ntelemetry:\n  enabled: true\n'}`),
      context: context(),
      loadEmbeddings: missing,
    });

    expect(stderr.text).toContain('OTLP export is not in this build yet');

    await runtime.close();
  });
});

describe('the semantic layer', () => {
  it('is attached when a provider is available, and scores off the hot path', async () => {
    const provider = new HashingProvider(64);
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\n'),
      context: context(),
      loadEmbeddings: providing(provider),
    });

    expect(runtime.detector).toBeDefined();
    expect(events()).toContain('semantic_attached');

    // Phase 3's wiring, end to end: a completed call reaches the detector
    // through `onRecordComplete` without the decision having waited for it.
    const decision = await runtime.engine.beforeCall({
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    });
    runtime.engine.afterCall(decision.callId, {
      isError: false,
      resultSummary: 'contents',
      resultBytes: 8,
    });
    await runtime.detector?.drain();

    expect(runtime.detector?.stats.offered).toBe(1);
    expect(runtime.detector?.stats.embedded).toBe(1);

    await runtime.close();
  });

  it('is not attached at all when the policy turns it off', async () => {
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nloop_detection:\n  semantic:\n    enabled: false\n'),
      context: context(),
      loadEmbeddings: missing,
    });

    expect(runtime.detector).toBeUndefined();
    expect(events()).toContain('semantic_off');
    // Not a warning: this was asked for.
    expect(stderr.text).not.toContain('warning:');

    await runtime.close();
  });

  it('warns and runs on at full rule strength when the package is missing in warn mode', async () => {
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nmode: warn\n'),
      context: context(),
      loadEmbeddings: missing,
    });

    expect(runtime.detector).toBeUndefined();
    expect(stderr.text).toContain('warning:');
    expect(events()).toContain('semantic_unavailable');

    // ADR-001: no crippleware. The deterministic rules must still trip, at the
    // configured threshold, with no model anywhere in sight.
    const call = {
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    };
    for (let i = 0; i < 2; i += 1) {
      const decision = await runtime.engine.beforeCall(call);
      runtime.engine.afterCall(decision.callId, {
        isError: false,
        resultSummary: 'same',
        resultBytes: 4,
      });
    }
    const third = await runtime.engine.beforeCall(call);

    expect(third.reasons.map((reason) => reason.code)).toContain('LOOP_EXACT_REPEAT');
    expect(third.wouldTrip).toBe(true);

    await runtime.close();
  });

  it('refuses to start when the package is missing in enforce mode', async () => {
    let caught: CliError | undefined;
    try {
      await createRuntime({
        loaded: policyFile('version: 1\nmode: enforce\n'),
        context: context(),
        loadEmbeddings: missing,
      });
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toContain('is not installed');
    expect(caught?.exitCode).toBe(4);
  });

  it('is told to forget a session when one ends', async () => {
    // Phase 3's note: the detector cannot see a session leave the store.
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\n'),
      context: context(),
      loadEmbeddings: providing(new HashingProvider(64)),
    });

    const decision = await runtime.engine.beforeCall({
      sessionId: 'S9',
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    });
    runtime.engine.afterCall(decision.callId, {
      isError: false,
      resultSummary: 'x',
      resultBytes: 1,
    });
    await runtime.detector?.drain();
    expect(runtime.detector?.stats.sessions).toBe(1);

    runtime.onSessionEnd(runtime.engine.endSession('S9'));

    expect(runtime.detector?.stats.sessions).toBe(0);

    await runtime.close();
  });

  it('survives a session ending with no detector attached', async () => {
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nloop_detection:\n  semantic:\n    provider: none\n'),
      context: context(),
    });

    expect(() => runtime.onSessionEnd(runtime.engine.endSession('nobody'))).not.toThrow();

    await runtime.close();
  });
});

describe('the writeReport hook the runtime hands the proxy', () => {
  it('writes a report under report.dir and returns the path', async () => {
    const runtime = await createRuntime({
      loaded: policyFile(
        'version: 1\nmode: enforce\nloop_detection:\n  semantic:\n    provider: none\n  exact_repeat:\n    count: 2\nreport:\n  dir: trips\n',
      ),
      context: context(),
    });

    const call = {
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    };
    const first = await runtime.engine.beforeCall(call);
    runtime.engine.afterCall(first.callId, {
      isError: false,
      resultSummary: 'same',
      resultBytes: 4,
    });
    const tripped = await runtime.engine.beforeCall(call);

    expect(tripped.report).toBeDefined();
    const path = runtime.writeReport(tripped);

    expect(path).toBeDefined();
    expect(path?.startsWith(join(root, 'trips'))).toBe(true);
    expect(existsSync(path as string)).toBe(true);
    // The path the agent is shown is the path the CLI returned, and reading it
    // back is what `agentfuse report` does.
    expect(runtime.reports.read(path as string).trigger.code).toBe('LOOP_EXACT_REPEAT');

    await runtime.close();
  });

  it('reports a failed write on stderr instead of throwing', async () => {
    const loaded = policyFile(
      'version: 1\nloop_detection:\n  semantic:\n    provider: none\nreport:\n  dir: /proc/agentfuse-cannot-write-here\n',
    );
    const runtime = await createRuntime({ loaded, context: context() });

    const path = runtime.writeReport({
      action: 'deny',
      reasons: [],
      wouldTrip: false,
      callId: 'C',
      report: {
        reportVersion: 1,
        kind: 'trip',
        tripId: 'T',
        sessionId: 'S',
        trippedAt: '2026-09-15T00:00:00.000Z',
        mode: 'warn',
        trigger: { code: 'POLICY_DENY', message: 'no' },
        breaker: { phase: 'open', cooldown: { calls: 3, durationMs: 1 } },
        budgets: {
          durationMs: 0,
          calls: 0,
          tokensEstimated: { args: 0, results: 0, note: 'n' },
          usdEstimated: 0,
          limits: { durationMs: 1, calls: 1, tokensEstimated: 1, usdEstimated: 1 },
        },
        recentCalls: [],
        policy: { sha256: 'x', version: 1 },
        agentfuse: { version: '0.0.0' },
      },
    });

    expect(path).toBeUndefined();
    expect(events()).toContain('report_write_failed');

    await runtime.close();
  });
});

describe('the --hook flag', () => {
  it('registers the hook on the engine', async () => {
    write('hook.mjs', 'export default () => ({ action: "deny" });\n');
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nloop_detection:\n  semantic:\n    provider: none\n'),
      context: context(),
      hook: './hook.mjs',
    });

    const decision = await runtime.engine.beforeCall({
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: {},
    });

    expect(decision.action).toBe('deny');
    expect(events()).toContain('hook_loaded');

    await runtime.close();
  });

  it('fails before anything is built when the hook file is not there', async () => {
    await expect(
      createRuntime({
        loaded: policyFile('version: 1\nloop_detection:\n  semantic:\n    provider: none\n'),
        context: context(),
        hook: './nope.mjs',
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('closing', () => {
  it('logs the semantic counters, because queue failures are not telemetry events', async () => {
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\n'),
      context: context(),
      loadEmbeddings: providing(new HashingProvider(64)),
    });

    await runtime.close();

    expect(events()).toContain('semantic_stats');
    expect(stderr.text).toContain('"offered":0');
    expect(stderr.text).toContain('"failures":0');
  });

  it('is safe to call twice', async () => {
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\n'),
      context: context(),
      loadEmbeddings: providing(new HashingProvider(64)),
    });

    await runtime.close();
    stderr.clear();
    await runtime.close();

    expect(stderr.text).toBe('');
  });

  it('does nothing but return when there is no detector', async () => {
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nloop_detection:\n  semantic:\n    provider: none\n'),
      context: context(),
    });

    await runtime.close();

    expect(events()).not.toContain('semantic_stats');
  });

  it('gives up on a provider that will not let go, rather than hanging the shutdown', async () => {
    const wedged: EmbeddingProvider = {
      id: 'wedged',
      dims: 8,
      embed: async (texts) => texts.map(() => new Float32Array(8)),
      close: () => new Promise(() => undefined),
    };
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\n'),
      context: context(),
      loadEmbeddings: providing(wedged),
    });

    await runtime.close({ timeoutMs: 5 });

    expect(events()).toContain('semantic_close_timeout');
  });

  it('does not take the process down when the provider rejects on close', async () => {
    const rude: EmbeddingProvider = {
      id: 'rude',
      dims: 8,
      embed: async (texts) => texts.map(() => new Float32Array(8)),
      close: () => Promise.reject(new Error('already gone')),
    };
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\n'),
      context: context(),
      loadEmbeddings: providing(rude),
    });

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(events()).not.toContain('semantic_close_timeout');
  });

  it('does not leave the work unhandled when the timeout budget is zero', async () => {
    // `timeoutMs: 0` means "do not wait", and the close already started; a
    // dropped rejection here would be an unhandled one.
    const rude: EmbeddingProvider = {
      id: 'rude',
      dims: 8,
      embed: async (texts) => texts.map(() => new Float32Array(8)),
      close: () => Promise.reject(new Error('already gone')),
    };
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\n'),
      context: context(),
      loadEmbeddings: providing(rude),
    });

    await runtime.close({ timeoutMs: 0 });

    expect(events()).toContain('semantic_close_timeout');
    // Let a microtask turn pass so an unhandled rejection would have surfaced.
    await Promise.resolve();
  });

  it('has a default budget rather than trusting the provider', async () => {
    expect(DEFAULT_CLOSE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('withTimeout', () => {
  it('waits for work that finishes, and does not report a timeout', async () => {
    let timedOut = false;

    await withTimeout(Promise.resolve('ok'), 1_000, () => {
      timedOut = true;
    });

    expect(timedOut).toBe(false);
  });

  it('treats a rejection as finished rather than propagating it', async () => {
    let timedOut = false;

    await expect(
      withTimeout(Promise.reject(new Error('gone')), 1_000, () => {
        timedOut = true;
      }),
    ).resolves.toBeUndefined();
    expect(timedOut).toBe(false);
  });

  it('reports a timeout and returns while the work is still running', async () => {
    let timedOut = false;

    await withTimeout(new Promise(() => undefined), 5, () => {
      timedOut = true;
    });

    expect(timedOut).toBe(true);
  });
});
