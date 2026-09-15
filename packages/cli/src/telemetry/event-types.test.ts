import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES } from './sink.js';

/**
 * Umbrella ADR-003 fixes the telemetry schema at four event types. This file is
 * the test that fails if a fifth ever appears.
 *
 * Three nets, because one would not hold:
 *
 * 1. {@link EVENT_NAMES} is the only table of names, and it is checked against
 *    the literal list ADR-003 wrote down rather than against itself.
 * 2. The sink has exactly one place that builds a log record, and it takes its
 *    name from that table — so a new event type cannot be smuggled in as a
 *    string literal at a second call site.
 * 3. `security_event` belongs to McpGuard and AgentFuse must never emit it; no
 *    source file in this package may even name it outside a comment saying so.
 *
 * The reason this matters is not tidiness. The schema is shared with McpGuard
 * and with a Control Plane that joins several tools onto one plane: an event
 * type invented here is a type every other consumer has to learn about, and a
 * `security_event` emitted here is AgentFuse claiming to have found something
 * it is not in the business of looking for.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** ADR-003's list, typed out rather than derived, so the test can disagree. */
const ADR_003 = ['tool_call', 'policy_decision', 'budget_event', 'loop_detection'];

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/** Strips comments, so prose naming a forbidden thing is not one. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the four event types', () => {
  it('is exactly ADR-003’s list, and nothing else', () => {
    expect(Object.keys(EVENT_NAMES).sort()).toEqual([...ADR_003].sort());
  });

  it('namespaces every one of them under tunedness', () => {
    for (const [type, name] of Object.entries(EVENT_NAMES)) {
      expect(name).toBe(`tunedness.${type}`);
    }
  });

  it('has no security_event, which belongs to McpGuard', () => {
    expect(Object.keys(EVENT_NAMES)).not.toContain('security_event');
    expect(Object.values(EVENT_NAMES)).not.toContain('tunedness.security_event');
  });

  it('builds every log record in one place, from that table', () => {
    const sink = stripComments(source('./sink.ts'));

    // One producer of log records, and its name comes from the table. A fifth
    // type would have to edit the table, which breaks the first test here.
    expect(sink.match(/enqueueLog\(/g)).toHaveLength(1);
    expect(sink.match(/eventName:/g)).toHaveLength(1);
    expect(sink).toContain('EVENT_NAMES[type]');
  });

  it('is not named by any source file outside a comment', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (stripComments(readFileSync(file, 'utf8')).includes('security_event')) {
        offenders.push(file.slice(SRC.length));
      }
    }

    expect(offenders).toEqual([]);
  });
});

/** Every non-test source file under a directory. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}
