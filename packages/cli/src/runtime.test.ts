import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type EmbeddingProvider, NoopTelemetrySink } from '@agentfuse/core';
import { HashingProvider, ScriptedApprovalGateway } from '@agentfuse/core/testing';
import { DIAGNOSTIC_PREFIX } from '@agentfuse/proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendCommand } from './approvals/socket.js';
import { loadPolicy } from './config.js';
import type { EmbeddingsLoader } from './embeddings.js';
import type { CliError } from './errors.js';
import { type CliContext, StringWriter } from './io.js';
import {
  createRuntime,
  currentUid,
  DEFAULT_CLOSE_TIMEOUT_MS,
  wantsApproval,
  withMode,
  withTimeout,
} from './runtime.js';
import type { FetchLike } from './telemetry/exporter.js';

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

function context(env: Readonly<Record<string, string>> = {}): CliContext {
  return { argv: [], stdout, stderr, env, cwd: root };
}

/**
 * A policy that asks for approval on a tool, with the semantic layer off.
 *
 * `mode: enforce` is what makes the engine resolve approvals at all, and the
 * gateway table in `approvals/index.ts` is only consulted under it.
 */
const APPROVAL_POLICY =
  'version: 1\nmode: enforce\nloop_detection:\n  semantic:\n    provider: none\ntools:\n  - match: "shell__*"\n    action: require_approval\n';

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

describe('currentUid', () => {
  it('reports the id when the platform has one', () => {
    expect(currentUid(() => ({ uid: 501 }))).toBe(501);
  });

  it('reports nothing on Windows, where uid is -1', () => {
    expect(currentUid(() => ({ uid: -1 }))).toBeUndefined();
  });

  it('reports nothing when there is no passwd entry, as in a container', () => {
    // `--user 1234:1234` with no matching entry: `userInfo` throws. Refusing to
    // start over it would be the wrong call — the ownership check simply cannot
    // be made, and the socket layer skips it.
    expect(
      currentUid(() => {
        throw new Error('uid not found');
      }),
    ).toBeUndefined();
  });
});

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
      // Injected so the suite never reaches for a collector that may or may not
      // be listening on the developer's machine.
      telemetry: { fetch: async () => new Response('{}', { status: 200 }) },
    });

    // A warning and several events went somewhere, and none of it here.
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
  it('says so, and fails closed, when the approval channel cannot be opened', async () => {
    // No HOME and no XDG_RUNTIME_DIR: there is nowhere to put the socket. The
    // run continues — a broken approval channel is stricter than the policy
    // asked for, and refusing to start would take the user's MCP server down
    // rather than protect anything.
    const runtime = await createRuntime({
      loaded: policyFile(APPROVAL_POLICY),
      context: context(),
    });

    expect(stderr.text).toContain('cli approval channel could not be opened');
    expect(stderr.text).toContain('fail closed');
    expect(runtime.approvals).toBeUndefined();
    expect(runtime.approvalSocket).toBeUndefined();

    await runtime.close();
  });

  it('binds the socket and reports it when there is somewhere to put it', async () => {
    const socket = join(root, 'a.sock');
    const runtime = await createRuntime({
      loaded: policyFile(APPROVAL_POLICY),
      context: context({ AGENTFUSE_APPROVAL_SOCKET: socket }),
    });

    expect(runtime.approvals).toBeDefined();
    expect(runtime.approvalSocket).toBe(socket);
    expect(existsSync(socket)).toBe(true);
    expect(events()).toContain('approval_gateway');
    expect(stderr.text).not.toContain('could not be opened');

    // And the socket is gone again afterwards: a wrap that exits leaving one
    // behind is the stale path the next one has to reason about.
    await runtime.close();
    expect(existsSync(socket)).toBe(false);
  });

  it('does not open a channel in warn mode, where nobody is ever asked', async () => {
    const socket = join(root, 'a.sock');
    const runtime = await createRuntime({
      loaded: policyFile(
        'version: 1\nmode: warn\nloop_detection:\n  semantic:\n    provider: none\ntools:\n  - match: "*"\n    action: require_approval\n',
      ),
      context: context({ AGENTFUSE_APPROVAL_SOCKET: socket }),
    });

    expect(runtime.approvals).toBeUndefined();
    expect(existsSync(socket)).toBe(false);
    // Silently: wanting approvals off and finding them off is not a shortfall.
    // The machine line still says why, the way the semantic table's rows do.
    expect(stderr.text).not.toContain('warning');
    expect(events()).toContain('approval_gateway_off');

    await runtime.close();
  });

  it('does not open a channel for a policy that never asks', async () => {
    const socket = join(root, 'a.sock');
    const runtime = await createRuntime({
      loaded: policyFile(
        'version: 1\nmode: enforce\nbudgets:\n  on_exceeded: halt\nloop_detection:\n  on_trip: halt\n  semantic:\n    provider: none\n',
      ),
      context: context({ AGENTFUSE_APPROVAL_SOCKET: socket }),
    });

    expect(runtime.approvals).toBeUndefined();
    expect(existsSync(socket)).toBe(false);

    await runtime.close();
  });

  it('answers `approve --reset` out of the engine it built', async () => {
    const socket = join(root, 'a.sock');
    const runtime = await createRuntime({
      loaded: policyFile(APPROVAL_POLICY),
      context: context({ AGENTFUSE_APPROVAL_SOCKET: socket }),
    });

    // A session the engine knows about, and one it does not. The difference is
    // the whole value of the answer: a reset that reports success for a session
    // this wrap never had leaves a circuit open while somebody believes they
    // closed it.
    runtime.engine.ports.sessions.create('01SESSION', Date.now());

    const known = await sendCommand(socket, {
      v: 1,
      type: 'reset',
      sessionId: '01SESSION',
      reason: 'false positive',
    });
    expect(known).toMatchObject({ ok: true, phase: 'closed' });

    const unknown = await sendCommand(socket, {
      v: 1,
      type: 'reset',
      sessionId: '01NOPE',
      reason: 'x',
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('no session 01NOPE');

    await runtime.close();
  });

  it('leaves an injected gateway alone and binds nothing', async () => {
    const socket = join(root, 'a.sock');
    const injected = new ScriptedApprovalGateway('approved');
    const runtime = await createRuntime({
      loaded: policyFile(APPROVAL_POLICY),
      context: context({ AGENTFUSE_APPROVAL_SOCKET: socket }),
      approvals: injected,
    });

    expect(runtime.approvals).toBe(injected);
    expect(runtime.engine.ports.approvals).toBe(injected);
    expect(existsSync(socket)).toBe(false);

    await runtime.close();
  });

  it('warns and carries on when the OTLP endpoint cannot be used', async () => {
    const runtime = await createRuntime({
      loaded: policyFile(TELEMETRY_POLICY('not a url')),
      context: context(),
      loadEmbeddings: missing,
    });

    // Loud, but not fatal. A typo in an endpoint must not take down the wrap
    // and leave the agent with no fuse in front of it.
    expect(stderr.text).toContain('cannot be used');
    expect(events()).toContain('telemetry_unavailable');
    expect(runtime.telemetry).toBeUndefined();

    await runtime.close();
  });
});

/** A policy with telemetry switched on and pointed at `endpoint`. */
const TELEMETRY_POLICY = (endpoint: string): string =>
  `version: 1\nloop_detection:\n  semantic:\n    provider: none\ntelemetry:\n  enabled: true\n  otlp_endpoint: ${endpoint}\n  service_name: test-service\n`;

describe('the telemetry port', () => {
  /** Records every export instead of opening a socket. */
  function recorder(): { calls: { url: string; body: unknown }[]; fetch: FetchLike } {
    const calls: { url: string; body: unknown }[] = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response('{}', { status: 200 });
      },
    };
  }

  it('is core’s no-op sink unless the policy asks for it', async () => {
    const seen = recorder();
    const runtime = await createRuntime({
      loaded: policyFile('version: 1\nloop_detection:\n  semantic:\n    provider: none\n'),
      context: context(),
      telemetry: { fetch: seen.fetch },
    });

    // Off by default, per umbrella ADR-003: no sink, no queue, no timer, and
    // nothing said about it on stderr either.
    expect(runtime.telemetry).toBeUndefined();
    expect(runtime.engine.ports.telemetry).toBeInstanceOf(NoopTelemetrySink);
    expect(events()).not.toContain('telemetry_enabled');

    const decision = await runtime.engine.beforeCall({
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: {},
    });
    runtime.engine.afterCall(decision.callId, {
      isError: false,
      resultSummary: 'ok',
      resultBytes: 2,
    });
    await runtime.close();

    expect(seen.calls).toEqual([]);
  });

  it('is the OTLP sink when it is enabled, and says where it is pointed', async () => {
    const seen = recorder();
    const runtime = await createRuntime({
      loaded: policyFile(TELEMETRY_POLICY('http://127.0.0.1:4318')),
      context: context(),
      telemetry: { fetch: seen.fetch },
    });

    expect(runtime.telemetry).toBeDefined();
    expect(runtime.engine.ports.telemetry).toBe(runtime.telemetry);
    expect(stderr.text).toContain('"endpoint":"http://127.0.0.1:4318"');
    expect(stderr.text).toContain('"service":"test-service"');

    await runtime.close();
  });

  it('flushes what a session produced when the runtime closes', async () => {
    const seen = recorder();
    const runtime = await createRuntime({
      loaded: policyFile(TELEMETRY_POLICY('http://127.0.0.1:4318')),
      context: context(),
      telemetry: { fetch: seen.fetch },
    });

    const decision = await runtime.engine.beforeCall({
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    });
    runtime.engine.afterCall(decision.callId, {
      isError: false,
      resultSummary: 'ok',
      resultBytes: 2,
    });
    await runtime.close();

    expect(seen.calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:4318/v1/traces',
      'http://127.0.0.1:4318/v1/logs',
    ]);
    expect(events()).toContain('telemetry_stats');
  });

  it('keeps exporting under --quiet', async () => {
    const seen = recorder();
    const runtime = await createRuntime({
      loaded: policyFile(TELEMETRY_POLICY('http://127.0.0.1:4318')),
      context: context(),
      quiet: true,
      telemetry: { fetch: seen.fetch },
    });

    const decision = await runtime.engine.beforeCall({
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: {},
    });
    runtime.engine.afterCall(decision.callId, {
      isError: false,
      resultSummary: 'ok',
      resultBytes: 2,
    });
    await runtime.close();

    // `--quiet` is about the operator's terminal, not their collector.
    expect(stderr.text).toBe('');
    expect(seen.calls.length).toBeGreaterThan(0);
  });

  it('gives the sink the inbound traceparent of a call still in flight', async () => {
    const seen = recorder();
    const runtime = await createRuntime({
      loaded: policyFile(TELEMETRY_POLICY('http://127.0.0.1:4318')),
      context: context(),
      telemetry: { fetch: seen.fetch },
    });

    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const decision = await runtime.engine.beforeCall({
      sessionId: 'S1',
      serverName: 'fs',
      toolName: 'read_file',
      args: {},
      traceparent,
    });
    runtime.engine.afterCall(decision.callId, {
      isError: false,
      resultSummary: 'ok',
      resultBytes: 2,
    });
    await runtime.close();

    const spans = seen.calls
      .filter((call) => call.url.endsWith('/v1/traces'))
      .flatMap((call) => {
        const body = call.body as {
          resourceSpans: { scopeSpans: { spans: Record<string, string>[] }[] }[];
        };
        return body.resourceSpans.flatMap((entry) =>
          entry.scopeSpans.flatMap((scope) => scope.spans),
        );
      });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.traceId).toBe('a'.repeat(32));
    expect(spans[0]?.parentSpanId).toBe('b'.repeat(16));
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
