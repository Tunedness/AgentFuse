import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FORWARDED_SIGNALS, nodeProcessHost } from './host.js';

/**
 * The real host is thin on purpose, so what is worth testing is that it is the
 * *only* thin place: phase 6a made `main.ts` the one file allowed to touch the
 * process's streams, and a serving command needs three more process members
 * that no other command does. Keeping them in one file is what makes the rest
 * of the CLI testable without spawning anything, and this is the test that
 * stops a second such file appearing — the same idea as `discipline.test.ts`
 * and core's `purity.test.ts`.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** The files allowed to name a process member. */
const PROCESS_OWNERS = new Set(['main.ts', 'host.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'testing') out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strips comments, so prose naming a forbidden thing is not one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('who is allowed to touch the process', () => {
  it('is only the entry point and this file', () => {
    // `process.env` is not here: it is read-only ambient configuration and the
    // commands take it through `CliContext` anyway. These four are the ones
    // that make a module untestable or let it act on the process.
    const banned = [
      /\bprocess\s*\.\s*stdin\b/,
      /\bprocess\s*\.\s*on\b/,
      /\bprocess\s*\.\s*off\b/,
      /\bprocess\s*\.\s*kill\b/,
    ];
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = file.slice(SRC.length);
      if (PROCESS_OWNERS.has(name)) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        if (pattern.test(source)) offenders.push(`${name}: ${pattern.source}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps both owners present, so the exception cannot become the rule', () => {
    const names = new Set(sourceFiles(SRC).map((file) => file.slice(SRC.length)));

    for (const owner of PROCESS_OWNERS) expect(names).toContain(owner);
  });
});

describe('the node host', () => {
  const registered: Array<() => void> = [];

  afterEach(() => {
    const host = nodeProcessHost();
    for (const listener of registered.splice(0)) {
      for (const signal of FORWARDED_SIGNALS) host.offSignal(signal, listener);
    }
  });

  it('forwards the two signals a supervisor sends', () => {
    expect([...FORWARDED_SIGNALS]).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('registers and removes a signal listener', () => {
    const host = nodeProcessHost();
    const before = process.listenerCount('SIGINT');
    const listener = (): void => undefined;
    registered.push(listener);

    host.onSignal('SIGINT', listener);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    host.offSignal('SIGINT', listener);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('exposes the read end of the agent’s pipe', () => {
    expect(nodeProcessHost().stdin).toBe(process.stdin);
  });

  it('reports a signal to a live process as delivered', () => {
    // Signal 0 rather than a real one: it is the liveness probe, it takes the
    // same code path through `process.kill`, and it cannot end the test run.
    // The cast is the price of a signal type that only names what wrap
    // forwards, which is the right type for every other caller.
    expect(nodeProcessHost().kill(process.pid, 0 as unknown as 'SIGINT')).toBe(true);
  });

  it('reports a signal to a process that is gone as not delivered', () => {
    // A pid that cannot exist: ESRCH, which is not a failure worth a warning —
    // it is what happens when a terminal already delivered Ctrl-C to the child.
    expect(nodeProcessHost().kill(2_147_483_646, 'SIGTERM')).toBe(false);
  });
});
