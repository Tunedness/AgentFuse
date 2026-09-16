import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { COMMANDS } from './cli.js';
import { APPROVE_FLAGS, DENY_FLAGS } from './commands/approve.js';
import { INIT_FLAGS } from './commands/init.js';
import { MODELS_FLAGS } from './commands/models.js';
import { REPORT_FLAGS } from './commands/report.js';
import { SERVE_FLAGS } from './commands/serve.js';
import { VALIDATE_FLAGS } from './commands/validate.js';
import { WRAP_FLAGS } from './commands/wrap.js';

/**
 * The documentation, checked against the parser that will read it.
 *
 * Phase 6b did this to `examples/claude-desktop.json` and the reasoning carries
 * over unchanged: a `--mode warm` in a file people paste from is a support
 * burden created by a typo nobody can see. A README is the same artefact with
 * a wider readership — it is the first thing anybody runs, and every command
 * in it is copied by hand into a terminal.
 *
 * So every `agentfuse …` line in every README is put through the real flag
 * declarations, and the check runs in **both** directions:
 *
 * - nothing documented may be absent from the parser (a typo, or a flag that
 *   was renamed and left behind in prose);
 * - nothing in the parser may be absent from the documentation (a flag that
 *   exists and that nobody is told about).
 *
 * The second direction is the one that rots quietly. A flag added in a later
 * phase with no README line is indistinguishable, to a reader, from a flag
 * that does not exist.
 */

const ROOT = new URL('../../../', import.meta.url);

const DOCS = [
  'README.md',
  'packages/cli/README.md',
  'packages/core/README.md',
  'packages/proxy/README.md',
  'packages/embeddings-local/README.md',
] as const;

/** Each command's real declaration, by name. Adding a command fails the table test. */
const SPECS = {
  wrap: WRAP_FLAGS,
  serve: SERVE_FLAGS,
  init: INIT_FLAGS,
  validate: VALIDATE_FLAGS,
  report: REPORT_FLAGS,
  approve: APPROVE_FLAGS,
  deny: DENY_FLAGS,
  models: MODELS_FLAGS,
} as const;

/**
 * Flags that belong to other programs and appear in the docs legitimately.
 *
 * Kept short and explicit. A long allowlist would make this test pass by
 * accident, which is the failure mode of every "check the docs" test.
 */
const FOREIGN = new Set([
  '--workspace', // npm, for the benchmark scripts
  '--json', // also ours; npm's too, in the packaging notes
]);

/** `--version` and `--help` are matched only as the very first token. */
const GLOBAL_FLAGS = new Set(['--version', '-v', '--help', '-h']);

function read(doc: string): string {
  return readFileSync(new URL(doc, ROOT), 'utf8');
}

const sources = DOCS.map((doc) => [doc, read(doc)] as const);

/** Joins backslash continuations, so a wrapped shell command reads as one line. */
function logicalLines(text: string): string[] {
  return text.replace(/\\\n\s*/g, ' ').split('\n');
}

/**
 * Every `agentfuse …` invocation in a document, as `[command, tail]`.
 *
 * Deliberately naive about where it looks: a command in prose is copied just
 * as often as one in a fenced block, and both have to be right. Lines that
 * document a *placeholder* command (`agentfuse <command> --help`) are dropped,
 * and so are the paths in `node packages/cli/dist/main.js`, which is not a
 * parse of the argument vector.
 */
function invocations(text: string): { command: string; tail: string[] }[] {
  const found: { command: string; tail: string[] }[] = [];
  for (const line of logicalLines(text)) {
    // `npx agentfuse …`, `agentfuse …`, and the same inside backticks.
    for (const match of line.matchAll(/\bagentfuse\s+([^`\n|]*)/g)) {
      const tokens = (match[1] ?? '').trim().split(/\s+/).filter(Boolean);
      const head = tokens[0];
      if (head === undefined) continue;
      // A package name (`agentfuse/core`) or a version banner, not a command.
      if (head.startsWith('<') || head.startsWith('[')) continue;
      if (GLOBAL_FLAGS.has(head)) continue;
      if (!COMMANDS.includes(head as (typeof COMMANDS)[number])) {
        found.push({ command: head, tail: [] });
        continue;
      }
      found.push({ command: head, tail: tokens.slice(1) });
    }
  }
  return found;
}

/** Every long flag mentioned anywhere in a document. */
function flagsIn(text: string): Set<string> {
  const flags = new Set<string>();
  for (const match of text.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) flags.add(match[0]);
  return flags;
}

/** Every flag a spec declares, in `--name` form, including its aliases' targets. */
function declared(spec: {
  booleans?: readonly string[];
  values?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
}): Set<string> {
  const names = new Set<string>();
  for (const name of spec.booleans ?? []) names.add(`--${name}`);
  for (const name of spec.values ?? []) names.add(`--${name}`);
  return names;
}

const ALL_DECLARED = new Set<string>(Object.values(SPECS).flatMap((spec) => [...declared(spec)]));

describe('the documented command surface', () => {
  it('covers every command this build has, and invents none', () => {
    // The table above is what the per-command tests iterate, so it has to be
    // the command list itself rather than a copy that drifts from it.
    expect(Object.keys(SPECS).sort()).toEqual([...COMMANDS].sort());
  });

  it.each(sources)('%s names only real commands', (_doc, text) => {
    const named = [...new Set(invocations(text).map((entry) => entry.command))];
    const unknown = named.filter(
      (command) => !COMMANDS.includes(command as (typeof COMMANDS)[number]),
    );

    expect(unknown).toEqual([]);
  });

  it.each(sources)('%s mentions no flag that does not exist', (_doc, text) => {
    const unknown = [...flagsIn(text)].filter(
      (flag) => !ALL_DECLARED.has(flag) && !GLOBAL_FLAGS.has(flag) && !FOREIGN.has(flag),
    );

    expect(unknown).toEqual([]);
  });

  it.each(sources)('%s parses every agentfuse line it shows', (_doc, text) => {
    for (const { command, tail } of invocations(text)) {
      const spec = SPECS[command as keyof typeof SPECS];
      // Placeholder values (`<path>`, `<id>`) are fine: the parser only cares
      // that a value flag has *a* value, and that the flag itself is known.
      // What this catches is the flag being unknown to *this* command — a
      // `--mode` documented on `report`, say — which no union check would see.
      expect(() => parseArgs(tail, spec), `agentfuse ${command} ${tail.join(' ')}`).not.toThrow();
    }
  });
});

describe('the flags the documentation must not omit', () => {
  it.each(Object.entries(SPECS))('%s has every one of its flags written down', (_command, spec) => {
    const everywhere = sources.map(([, text]) => text).join('\n');
    const documented = flagsIn(everywhere);
    const missing = [...declared(spec)].filter(
      (flag) => !documented.has(flag) && !GLOBAL_FLAGS.has(flag),
    );

    expect(missing).toEqual([]);
  });

  it('documents the short aliases alongside their long forms', () => {
    const everywhere = sources.map(([, text]) => text).join('\n');

    // Not every alias in every place — but a short form that appears nowhere
    // is a shortcut only the source code knows about.
    for (const alias of ['-n', '-p', '-q', '-m', '-r', '-s', '-f']) {
      expect(everywhere, `alias ${alias}`).toContain(alias);
    }
  });
});

describe('the numbers the documentation quotes', () => {
  const root = read('README.md');

  /**
   * The measured operating point, as the benchmark recorded it.
   *
   * A README that rounds 87.0% up, or quotes the design target as though it
   * were the result, is the specific failure this whole phase was told to
   * avoid. So the numbers are pinned here against the committed benchmark
   * results, and a re-measurement has to move both.
   */
  const RESULTS = readFileSync(new URL('bench/detection/results.md', ROOT), 'utf8');

  it('quotes the measured detection rate, not the target', () => {
    expect(root).toContain('87.0%');
    expect(RESULTS).toContain('recall 0.870');
    // The target is named as a target, and named as unmet.
    expect(root).toMatch(/≥90%|≥ ?90%/);
    expect(root).toContain('does not meet it');
  });

  it('quotes the measured false-positive rate beside it', () => {
    expect(root).toContain('0.0% false positives');
    expect(RESULTS).toContain('FP-rate 0.0%');
  });

  it('quotes the worst-case added latency, not the best case', () => {
    const LATENCY = readFileSync(new URL('bench/latency/results.md', ROOT), 'utf8');

    expect(root).toContain('4.84 ms');
    expect(LATENCY).toContain('4.8');
    // And says which configuration that is, because the in-memory rows are
    // twenty times lower and mean nothing for a real installation.
    expect(root).toContain('semantic tier and telemetry both on');
  });

  it('says the calibration belongs to one model', () => {
    expect(root).toContain('invalidates `threshold`');
    expect(root).toContain('Xenova/all-MiniLM-L6-v2');
  });

  it('says every token and dollar figure is a floor', () => {
    expect(root).toContain('_estimated');
    expect(root).toContain('lower bound');
    // And that the two exact limits are the ones to lead with.
    expect(root).toContain('anchor limits');
  });

  it('says `serve` is not a guarded gateway', () => {
    expect(root).toContain('serve` is not a guarded gateway');
    expect(root).toContain('It does not forward tool calls.');
  });

  it('carries the McpGuard chaining contract by name', () => {
    expect(root).toContain('tunedness.session-id');
    expect(root).toContain('McpGuard');
  });
});
