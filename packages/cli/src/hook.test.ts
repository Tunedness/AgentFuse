import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CounterIdGenerator,
  FakeClock,
  FuseEngine,
  parsePolicy,
  RecordingTelemetrySink,
} from '@agentfuse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { loadDecisionHook } from './hook.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfuse-hook-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a hook module and returns its path. */
function hookFile(name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

/** An engine in enforce mode with a `deny` rule for `shell__*`. */
function engineWith(): { engine: FuseEngine; telemetry: RecordingTelemetrySink } {
  const clock = new FakeClock();
  const telemetry = new RecordingTelemetrySink();
  const engine = new FuseEngine(
    parsePolicy({
      version: 1,
      mode: 'enforce',
      tools: [
        { match: 'shell__*', action: 'deny' },
        { match: '*', action: 'allow' },
      ],
    }),
    { clock, ids: new CounterIdGenerator(), telemetry },
  );
  return { engine, telemetry };
}

describe('loading a hook module', () => {
  it('takes a default export', async () => {
    const path = hookFile('default.mjs', 'export default () => ({ action: "deny" });\n');

    const hook = await loadDecisionHook(path, root);

    expect(typeof hook).toBe('function');
  });

  it('takes a named `onDecision` export', async () => {
    const path = hookFile('named.mjs', 'export const onDecision = () => ({ action: "deny" });\n');

    expect(typeof (await loadDecisionHook(path, root))).toBe('function');
  });

  it('prefers the default export when a module has both', async () => {
    const path = hookFile(
      'both.mjs',
      'export default () => ({ action: "deny" });\nexport const onDecision = () => ({ action: "allow" });\n',
    );

    const hook = await loadDecisionHook(path, root);

    expect(
      hook({
        decision: { action: 'allow', reasons: [], wouldTrip: false, callId: 'C' },
        call: {
          id: 'C',
          sessionId: 'S',
          serverName: 'fs',
          toolName: 'read_file',
          args: {},
          argsNormalized: '{}',
          fingerprint: 'f',
          annotations: undefined,
        },
        session: { sessionId: 'S', calls: 0, durationMs: 0, breakerPhase: 'closed' },
      }),
    ).toEqual({ action: 'deny' });
  });

  it('resolves a relative specifier against the working directory it was typed in', async () => {
    hookFile('relative.mjs', 'export default () => undefined;\n');

    expect(typeof (await loadDecisionHook('./relative.mjs', root))).toBe('function');
  });

  it('says so when the file is not there', async () => {
    await expect(loadDecisionHook('./missing.mjs', root)).rejects.toThrow(
      /--hook names does not exist/,
    );
  });

  it('names both accepted spellings when the module exports neither', async () => {
    const path = hookFile('empty.mjs', 'export const unrelated = 1;\n');

    // A hook that silently does not run is indistinguishable from a policy
    // that allows everything, which is the failure worth an error message.
    try {
      await loadDecisionHook(path, root);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const hints = (error as CliError).hints.join(' ');
      expect(hints).toContain('export default');
      expect(hints).toContain('onDecision');
    }
  });

  it('refuses a module that is not a function export', async () => {
    const path = hookFile('object.mjs', 'export default { action: "deny" };\n');

    await expect(loadDecisionHook(path, root)).rejects.toThrow(/exports no function/);
  });

  it('explains a module that will not load', async () => {
    const path = hookFile('broken.mjs', 'this is not javascript(((\n');

    try {
      await loadDecisionHook(path, root);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliError).message).toContain('could not be loaded');
      expect((error as CliError).hints.join(' ')).toContain('ES module');
      expect((error as CliError).cause).toBeDefined();
    }
  });

  it('reports a loader that rejects with something that is not an Error', async () => {
    const path = hookFile('rude.mjs', 'export default () => undefined;\n');

    try {
      await loadDecisionHook(path, root, () => Promise.reject('top-level throw'));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliError).hints.join(' ')).toContain('top-level throw');
    }
  });

  it('loads through an injected loader, and imports by file URL', async () => {
    const path = hookFile('url.mjs', 'export default () => undefined;\n');
    const seen: string[] = [];

    await loadDecisionHook(path, root, async (url) => {
      seen.push(url);
      return { default: () => undefined };
    });

    expect(seen).toEqual([pathToFileURL(path).href]);
  });
});

describe('what a hook may do, wired onto the engine', () => {
  const call = {
    sessionId: 'S1',
    serverName: 'fs',
    toolName: 'read_file',
    args: { path: 'a.ts' },
  };

  it('raises the action', async () => {
    const { engine } = engineWith();
    const path = hookFile(
      'raise.mjs',
      `export default ({ call }) =>
         call.toolName === 'read_file'
           ? { action: 'deny', reasons: [{ code: 'POLICY_DENY', message: 'not during a freeze' }] }
           : undefined;\n`,
    );
    engine.onDecision(await loadDecisionHook(path, root));

    const decision = await engine.beforeCall(call);

    expect(decision.action).toBe('deny');
    expect(decision.reasons.map((reason) => reason.message)).toContain('not during a freeze');
  });

  it('lowers the action', async () => {
    const { engine } = engineWith();
    const path = hookFile(
      'lower.mjs',
      `export default ({ decision }) =>
         decision.action === 'deny'
           ? { action: 'allow', reasons: [{ code: 'POLICY_WARN', message: 'on-call override' }] }
           : undefined;\n`,
    );
    engine.onDecision(await loadDecisionHook(path, root));

    const decision = await engine.beforeCall({ ...call, serverName: 'shell', toolName: 'rm' });

    expect(decision.action).toBe('allow');
    expect(decision.reasons.map((reason) => reason.code)).toContain('POLICY_WARN');
  });

  it('is a no-op when it throws, and the throw is recorded', async () => {
    // Core implements this; the CLI wires it rather than reimplementing it.
    const { engine, telemetry } = engineWith();
    const path = hookFile('throws.mjs', 'export default () => { throw new Error("boom"); };\n');
    engine.onDecision(await loadDecisionHook(path, root));

    const decision = await engine.beforeCall(call);

    expect(decision.action).toBe('allow');
    expect(telemetry.ofType('policy_decision')[0]?.hookError).toBe('boom');
  });

  it('cannot modify the arguments', async () => {
    // ADR-004: the hook decides whether a call happens, never what it says.
    // Rewriting an agent's requests is McpGuard's territory.
    const { engine } = engineWith();
    const path = hookFile(
      'rewrite.mjs',
      `export default ({ call }) => {
         let mutated = false;
         try {
           call.args.path = '/etc/passwd';
           mutated = call.args.path === '/etc/passwd';
         } catch {
           mutated = false;
         }
         return { action: 'allow', reasons: [{ code: 'POLICY_WARN', message: 'mutated=' + mutated }] };
       };\n`,
    );
    engine.onDecision(await loadDecisionHook(path, root));

    const decision = await engine.beforeCall(call);

    // The view is a frozen deep copy, so the write cannot land …
    expect(decision.reasons.map((reason) => reason.message)).toContain('mutated=false');
    // … and the record the engine kept still has the agent's own arguments.
    expect(call.args.path).toBe('a.ts');
  });

  it('ignores an `args` field on the result by construction', async () => {
    const { engine } = engineWith();
    const path = hookFile(
      'args-result.mjs',
      `export default () => ({ action: 'allow', args: { path: '/etc/passwd' } });\n`,
    );
    engine.onDecision(await loadDecisionHook(path, root));

    const decision = await engine.beforeCall(call);

    expect(decision.action).toBe('allow');
    expect('args' in decision).toBe(false);
  });

  it('is ignored when it returns something that is not a result object', async () => {
    const { engine } = engineWith();
    const path = hookFile('garbage.mjs', 'export default () => 42;\n');
    engine.onDecision(await loadDecisionHook(path, root));

    const decision = await engine.beforeCall({ ...call, serverName: 'shell', toolName: 'rm' });

    expect(decision.action).toBe('deny');
  });
});
