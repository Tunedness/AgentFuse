/**
 * The labelled detection corpus, generated from a seed.
 *
 * PRD §6 promises ≥90% detection and <5% false positives "on synthetic loop
 * scenarios". This file is those scenarios, and it is the part of phase 9 that
 * decides whether the measurement is worth anything: a corpus whose negatives
 * are easy turns the false-positive number into a formality, and PRD §8 lists
 * false-positive trips as the product's first risk.
 *
 * So the negatives are written to be hard on purpose:
 *
 * | scenario | why it is a trap |
 * | --- | --- |
 * | `pagination-sweep` | one tool, N calls, near-identical arguments. Phase 4 measured page 1 ↔ page 2 at cosine **0.9971** — cosine-indistinguishable from a real loop even with different result text. |
 * | `bulk-edit` | one tool, N calls, arguments that differ only in a path or an id, results that differ only in a byte count. |
 * | `list-traverse-process` | a run of `read_file` calls long enough to fill the window on its own, wrapped in honest work at both ends. |
 * | `try-then-fix` | the same command run before and after a fix. Two identical fingerprints inside one window. |
 * | `converging-build-test` | the same command run three or four times, converging. The arguments never change; only the results do. |
 *
 * And the positives are written so that the deterministic rules cannot take all
 * the credit: `reworded-retry` and `drifting-loop` never repeat a fingerprint,
 * never fail, and never oscillate, so R1, R2 and R3 are blind to both and only
 * the semantic layer can catch them.
 *
 * Every session is built from an {@link Rng} seeded with
 * `<seed>:<scenario>:<index>`, so adding a scenario cannot reshuffle the ones
 * beside it and the whole corpus regenerates byte-identically.
 */

import { Rng } from '../rng.js';
import {
  type CorpusCall,
  type CorpusSession,
  NEGATIVE_SCENARIOS,
  type NegativeScenario,
  POSITIVE_SCENARIOS,
  type PositiveScenario,
  type ScenarioName,
} from './types.js';

/** The seed the committed corpus is generated from. */
export const DEFAULT_SEED = 'agentfuse-phase-9';

/** Sessions generated per scenario. Ten scenarios × 20 = 200. */
export const SESSIONS_PER_SCENARIO = 20;

// ---------------------------------------------------------------------------
// shared vocabulary
// ---------------------------------------------------------------------------

const REPOS = ['acme/api', 'acme/web', 'octo/tools', 'labs/pipeline'] as const;

const SOURCE_FILES = [
  'src/index.ts',
  'src/auth/session.ts',
  'src/auth/tokens.ts',
  'src/http/router.ts',
  'src/http/middleware.ts',
  'src/db/pool.ts',
  'src/db/migrate.ts',
  'src/queue/worker.ts',
  'src/queue/retry.ts',
  'src/util/logger.ts',
  'src/util/clock.ts',
  'src/config/load.ts',
  'src/cli/main.ts',
  'src/cli/flags.ts',
  'src/report/render.ts',
  'src/report/json.ts',
] as const;

const ISSUE_TITLES = [
  'Login returns 401 after token refresh',
  'Flaky retry test on CI',
  'Migration 0042 deadlocks on large tables',
  'Router drops trailing slash',
  'Worker leaks a socket per job',
  'Logger writes to stdout in wrap mode',
  'Config loader ignores XDG_CONFIG_HOME',
  'Report renderer truncates wide tables',
  'Pool exhausts under burst load',
  'Token refresh races with logout',
  'CLI --json flag is undocumented',
  'Middleware swallows AbortError',
  'Retry backoff is not jittered',
  'Clock adapter is not injectable in tests',
  'Migrate command has no dry run',
  'Session cookie missing SameSite',
] as const;

const SHELL_BUILD = 'npm run build';
const SHELL_TEST = 'npm test';

/** A fragment of plausible TypeScript, so the result text is not a placeholder. */
function sourceExcerpt(rng: Rng, file: string): string {
  const symbol = (file.split('/').pop() ?? 'module').replace('.ts', '');
  return (
    `// ${file}\nimport { Clock } from '../ports/clock.js';\n\n` +
    `export function ${symbol}(now: number): number {\n` +
    `  return now + ${rng.int(1, 9)}00;\n}`
  );
}

// ---------------------------------------------------------------------------
// session builder
// ---------------------------------------------------------------------------

class SessionBuilder {
  readonly #calls: CorpusCall[] = [];

  /** Adds a successful call. */
  ok(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    bytes?: number,
  ): this {
    this.#calls.push({
      serverName,
      toolName,
      args,
      isError: false,
      result,
      resultBytes: bytes ?? result.length,
    });
    return this;
  }

  /** Adds a failing call. */
  fail(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    errorCode?: string,
  ): this {
    this.#calls.push({
      serverName,
      toolName,
      args,
      isError: true,
      result,
      resultBytes: result.length,
      ...(errorCode !== undefined ? { errorCode } : undefined),
    });
    return this;
  }

  get length(): number {
    return this.#calls.length;
  }

  done(fields: Omit<CorpusSession, 'calls'>): CorpusSession {
    return { ...fields, calls: this.#calls };
  }
}

/**
 * Zero to two unrelated calls before the interesting part.
 *
 * Real loops do not begin on call zero, and a corpus whose positives do would
 * quietly inflate detection latency into a better number than it is.
 */
function prelude(rng: Rng, b: SessionBuilder): number {
  const count = rng.int(0, 2);
  for (let i = 0; i < count; i += 1) {
    switch (rng.int(0, 2)) {
      case 0: {
        const file = rng.pick(SOURCE_FILES);
        b.ok('fs', 'read_file', { path: file }, sourceExcerpt(rng, file));
        break;
      }
      case 1:
        b.ok(
          'fs',
          'list_directory',
          { path: 'src' },
          `8 entries: auth/, http/, db/, queue/, util/, config/, cli/, report/`,
        );
        break;
      default:
        b.ok(
          'github',
          'get_issue',
          { repo: rng.pick(REPOS), number: rng.int(100, 900) },
          `#${rng.int(100, 900)} ${rng.pick(ISSUE_TITLES)} — open, 3 comments`,
        );
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// positives
// ---------------------------------------------------------------------------

/**
 * P1 — the same call, verbatim, over and over.
 *
 * The degenerate loop, and the one R1 exists for. It is in the corpus not
 * because it is hard but because a detector that missed it would be useless,
 * and because it anchors the detection-latency number: R1 fires on the third
 * identical call, so the floor for this scenario is two wasted turns.
 */
function verbatimRetry(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const start = prelude(rng, b);
  const repeats = rng.int(5, 10);

  const shape = rng.int(0, 3);
  let call: () => void;
  if (shape === 0) {
    const repo = rng.pick(REPOS);
    const query = 'is:open label:regression author:bot';
    call = () => b.ok('github', 'search_issues', { repo, query }, 'No issues matched the query.');
  } else if (shape === 1) {
    const path = rng.pick(SOURCE_FILES);
    const body = sourceExcerpt(rng, path);
    call = () => b.ok('fs', 'read_file', { path }, body);
  } else if (shape === 2) {
    const sql = `SELECT id, kind FROM events WHERE kind = 'login_failed' LIMIT 25`;
    call = () => b.ok('postgres', 'query', { sql }, '0 rows');
  } else {
    const command = `${SHELL_TEST} -- src/auth`;
    call = () =>
      b.ok('shell', 'run_command', { command }, 'Tests: 2 failed, 11 passed. See report above.');
  }

  for (let i = 0; i < repeats; i += 1) call();

  return b.done({
    id,
    scenario: 'verbatim-retry',
    label: 'positive',
    loopStartIndex: start,
    note: `the identical call ${repeats} times; R1 should stop it on the third`,
  });
}

/**
 * P2 — the same question, reworded every turn.
 *
 * **This is one of the two scenarios only the semantic layer can catch.** Every
 * fingerprint differs, nothing fails, nothing oscillates, so R1, R2 and R3 are
 * all blind by construction. The agent is asking the same thing in different
 * words and getting the same nothing back.
 */
function rewordedRetry(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const start = prelude(rng, b);
  const repo = rng.pick(REPOS);

  const themes = [
    [
      'login fails with 401',
      'authentication returns 401',
      'cannot authenticate user 401',
      '401 unauthorized on login',
      'why does sign-in return 401',
      'login endpoint rejects valid credentials',
      'auth 401 after token refresh',
      'unauthorized response when logging in',
      'sign in broken 401 error',
      'credentials rejected with 401 status',
    ],
    [
      'worker leaks sockets',
      'socket leak in queue worker',
      'queue worker file descriptor leak',
      'why does the worker leak connections',
      'open sockets grow per job',
      'connection not released after job',
      'worker does not close its socket',
      'fd leak background worker',
      'sockets accumulate in worker process',
      'job handler leaves sockets open',
    ],
    [
      'migration deadlock',
      'migrate command deadlocks',
      'deadlock during schema migration',
      'why does migration 0042 hang',
      'schema migration blocks on lock',
      'alter table deadlock migration',
      'migration stuck waiting for lock',
      'db migration lock contention',
      'migrate hangs on large table',
      'deadlock detected running migrations',
    ],
  ] as const;
  const queries = rng.shuffle(rng.pick(themes));
  const repeats = rng.int(6, 10);

  const answers = [
    'No issues matched the query.',
    'Found 0 issues.',
    'No matching issues found.',
    '0 results.',
  ] as const;

  for (let i = 0; i < repeats; i += 1) {
    const query = queries[i % queries.length] as string;
    // The shape of the arguments wobbles too, the way a model's output does:
    // an optional filter appears, a limit changes, a key is added.
    const args: Record<string, unknown> =
      i % 3 === 0
        ? { repo, query }
        : i % 3 === 1
          ? { repo, query, state: 'open' }
          : { query, repo, limit: 20 + (i % 4) * 10 };
    b.ok('github', 'search_issues', args, rng.pick(answers));
  }

  return b.done({
    id,
    scenario: 'reworded-retry',
    label: 'positive',
    loopStartIndex: start,
    note: 'same question, new words each turn; every fingerprint differs so only the semantic layer can see it',
  });
}

/**
 * P3 — the same failure, over and over.
 *
 * The error text carries a volatile temp path, so this also exercises
 * `errorSignature`'s masking: two attempts that differ only in `/tmp/<hex>`
 * have to land on the same signature or R2 never fires.
 */
function errorLoop(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const start = prelude(rng, b);
  const repeats = rng.int(5, 9);
  const shape = rng.int(0, 2);

  for (let i = 0; i < repeats; i += 1) {
    if (shape === 0) {
      b.fail(
        'fs',
        'write_file',
        {
          path: '/etc/agentfuse/policy.yaml',
          content: `version: 1\nmode: enforce\nbudgets:\n  max_calls: ${100 + i * 25}\n`,
        },
        `EACCES: permission denied, open '/tmp/${rng.hex(8)}/policy.yaml'`,
      );
    } else if (shape === 1) {
      b.fail(
        'postgres',
        'query',
        { sql: `SELECT * FROM events WHERE created_at > now() - interval '${i + 1} days'` },
        'relation "events" does not exist',
        '42P01',
      );
    } else {
      b.fail(
        'shell',
        'run_command',
        { command: `${SHELL_BUILD} --workspace packages/${['core', 'proxy', 'cli'][i % 3]}` },
        `npm ERR! code ELIFECYCLE\nnpm ERR! errno ${rng.int(1, 9)}`,
      );
    }
  }

  return b.done({
    id,
    scenario: 'error-loop',
    label: 'positive',
    loopStartIndex: start,
    note: `${repeats} failures with one signature; R2 should stop it on the third`,
  });
}

/**
 * P4 — A-B-A-B (and A-B-C-A-B-C).
 *
 * Neither tool individually reaches R1's threshold inside the window, which is
 * exactly the gap R3 was written for.
 */
function oscillation(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const start = prelude(rng, b);
  const period = rng.bool(0.6) ? 2 : 3;
  const cycles = period === 2 ? rng.int(3, 5) : rng.int(2, 4);
  const file = rng.pick(SOURCE_FILES);
  const body = sourceExcerpt(rng, file);
  const failures = rng.int(2, 6);

  const steps: (() => void)[] = [
    () =>
      b.fail(
        'shell',
        'run_command',
        { command: SHELL_TEST },
        `Tests: ${failures} failed, ${40 + failures} passed.`,
      ),
    () => b.ok('fs', 'read_file', { path: file }, body),
  ];
  if (period === 3) {
    steps.push(() =>
      b.ok('github', 'search_issues', { repo: 'acme/api', query: 'flaky test' }, 'Found 0 issues.'),
    );
  }

  for (let c = 0; c < cycles; c += 1) for (const step of steps) step();

  return b.done({
    id,
    scenario: 'oscillation',
    label: 'positive',
    loopStartIndex: start,
    note: `period-${period} cycle repeated ${cycles} times; R3 should stop it after two full cycles`,
  });
}

/**
 * P5 — the loop that never repeats itself.
 *
 * **The second scenario only the semantic layer can catch,** and the one that
 * most resembles a real model failure: one knob gets nudged every turn, nothing
 * errors, nothing repeats, and the answer never changes. The deterministic
 * rules have nothing to hold on to.
 */
function driftingLoop(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const start = prelude(rng, b);
  const repeats = rng.int(8, 14);
  const shape = rng.int(0, 2);
  const repo = rng.pick(REPOS);

  for (let i = 0; i < repeats; i += 1) {
    if (shape === 0) {
      b.ok(
        'fs',
        'search_files',
        { pattern: 'TODO(auth)', path: 'src', max_results: 50 + i * 10 },
        '0 matches.',
      );
    } else if (shape === 1) {
      b.ok(
        'postgres',
        'query',
        { sql: `SELECT id FROM events WHERE kind = 'login' ORDER BY id DESC LIMIT ${10 + i * 5}` },
        '0 rows',
      );
    } else {
      b.ok(
        'github',
        'search_issues',
        { repo, query: 'flaky retry test', per_page: 10 + i * 5, sort: 'updated' },
        'Found 0 issues.',
      );
    }
  }

  return b.done({
    id,
    scenario: 'drifting-loop',
    label: 'positive',
    loopStartIndex: start,
    note: `${repeats} calls, one knob nudged each turn, the same empty answer; no deterministic rule can see it`,
  });
}

// ---------------------------------------------------------------------------
// negatives — the false-positive traps
// ---------------------------------------------------------------------------

/**
 * N1 — a pagination sweep.
 *
 * The canonical false positive, and the one phase 4 measured directly: page 1
 * against page 2 scores **0.9971**, closer than some genuine loops. Half the
 * sessions use a hex cursor and half an opaque base64url one, because the hex
 * form is the only one `NEVER_MASKED_KEYS` actually protects — a plain
 * base64url token is not hex and the mask would not have eaten it anyway. That
 * split is what lets the runner say whether the `cursor` exemption carries its
 * weight or is decoration.
 */
function paginationSweep(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const pages = rng.int(8, 16);
  const hexCursor = rng.bool(0.5);
  const shape = rng.int(0, 2);
  const repo = rng.pick(REPOS);
  const titles = rng.shuffle(ISSUE_TITLES);
  let issue = rng.int(100, 400);

  for (let page = 0; page < pages; page += 1) {
    const cursor = page === 0 ? undefined : hexCursor ? rng.hex(32) : rng.token(22);
    if (shape === 0) {
      const picked = [0, 1, 2].map((k) => {
        issue += rng.int(1, 4);
        return `#${issue} ${titles[(page * 3 + k) % titles.length] as string}`;
      });
      b.ok(
        'github',
        'search_issues',
        { repo, query: 'is:open label:bug', ...(cursor !== undefined ? { cursor } : undefined) },
        `Page ${page + 1}: 20 issues. ${picked.join('; ')}. Next cursor present.`,
        4200,
      );
    } else if (shape === 1) {
      const dir = `src/${['auth', 'http', 'db', 'queue', 'util'][page % 5] as string}`;
      const entries = rng
        .sample(SOURCE_FILES, 4)
        .map((f) => f.split('/').pop() as string)
        .join(', ');
      b.ok(
        'fs',
        'list_directory',
        { path: dir, ...(cursor !== undefined ? { cursor } : undefined) },
        `Page ${page + 1} of ${dir}: 25 entries: ${entries}, …`,
        2600,
      );
    } else {
      // No `cursor` key at all: the offset lives inside the SQL string, so the
      // exemption cannot help and only the fingerprint's own variation does.
      const offset = page * 100;
      b.ok(
        'postgres',
        'query',
        { sql: `SELECT id, kind, created_at FROM events ORDER BY id LIMIT 100 OFFSET ${offset}` },
        `100 rows (ids ${offset + 1}–${offset + 100}), kinds: login, logout, refresh`,
        9800,
      );
    }
  }

  return b.done({
    id,
    scenario: 'pagination-sweep',
    label: 'negative',
    loopStartIndex: null,
    note: `${pages} pages, ${hexCursor ? 'hex' : 'opaque'} cursor, ${shape === 2 ? 'offset in the SQL' : 'cursor argument'}; measured at cosine 0.9971 in phase 4`,
  });
}

/**
 * N2 — a bulk edit across N similar files.
 *
 * One tool, N calls, arguments that differ in a path and a line, results that
 * differ in a byte count. Honest work that looks like a loop from any distance.
 */
function bulkEdit(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const shape = rng.int(0, 1);

  if (shape === 0) {
    const files = rng.sample(SOURCE_FILES, rng.int(8, 14));
    b.ok('fs', 'list_directory', { path: 'src' }, `${files.length} files need the header.`);
    for (const file of files) {
      b.ok(
        'fs',
        'write_file',
        { path: file, content: `// Copyright 2026 Acme Inc.\n${sourceExcerpt(rng, file)}` },
        `Wrote ${rng.int(900, 2400)} bytes to ${file}.`,
      );
    }
    return b.done({
      id,
      scenario: 'bulk-edit',
      label: 'negative',
      loopStartIndex: null,
      note: `a license header added to ${files.length} files; one tool, every call distinct work`,
    });
  }

  const repo = rng.pick(REPOS);
  const count = rng.int(9, 15);
  let issue = rng.int(200, 500);
  for (let i = 0; i < count; i += 1) {
    issue += rng.int(1, 6);
    b.ok(
      'github',
      'create_comment',
      { repo, issue, body: 'Closing as stale — please reopen with a reproduction.' },
      `Comment ${rng.hex(8)} created on #${issue}.`,
    );
  }
  return b.done({
    id,
    scenario: 'bulk-edit',
    label: 'negative',
    loopStartIndex: null,
    note: `the same comment posted to ${count} different issues; only the id distinguishes the calls`,
  });
}

/**
 * N3 — try, read the error, fix, try again.
 *
 * The most common honest shape there is, and it puts two identical build
 * commands inside one window. One round or two: three would make it
 * `converging-build-test`, and the two traps are kept apart so the runner can
 * say which one a false positive came from.
 */
function tryThenFix(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const rounds = rng.int(1, 2);
  const command = rng.bool(0.5) ? SHELL_BUILD : `${SHELL_BUILD} --workspace packages/core`;
  b.ok(
    'fs',
    'list_directory',
    { path: 'packages' },
    '4 entries: core/, proxy/, cli/, embeddings-local/',
  );

  for (let round = 0; round < rounds; round += 1) {
    const file = rng.pick(SOURCE_FILES);
    b.fail(
      'shell',
      'run_command',
      { command },
      `${file}(${rng.int(10, 80)},${rng.int(3, 40)}): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
    );
    b.ok('fs', 'read_file', { path: file }, sourceExcerpt(rng, file));
    b.ok(
      'fs',
      'write_file',
      { path: file, content: `${sourceExcerpt(rng, file)}\n// fixed the argument type` },
      `Wrote ${rng.int(700, 1800)} bytes to ${file}.`,
    );
  }
  b.ok(
    'shell',
    'run_command',
    { command },
    `Build succeeded in ${rng.int(3, 12)}.${rng.int(0, 9)}s.`,
  );
  b.ok('shell', 'run_command', { command: SHELL_TEST }, 'Tests: 0 failed, 48 passed.');

  return b.done({
    id,
    scenario: 'try-then-fix',
    label: 'negative',
    loopStartIndex: null,
    note: `${rounds} fix round(s) around the same build command; ${rounds + 1} identical fingerprints in the window`,
  });
}

/**
 * N4 — list, walk, summarise.
 *
 * The middle of this session is a run of `read_file` calls long enough to fill
 * the window on its own. Nothing about it is repetitive except the tool.
 */
function listTraverseProcess(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const files = rng.sample(SOURCE_FILES, rng.int(7, 13));
  b.ok(
    'fs',
    'list_directory',
    { path: 'src' },
    `${files.length} entries: ${files.map((f) => f.split('/').pop() as string).join(', ')}`,
  );
  for (const file of files) b.ok('fs', 'read_file', { path: file }, sourceExcerpt(rng, file));
  b.ok(
    'fs',
    'write_file',
    { path: 'docs/module-map.md', content: files.map((f) => `- ${f}`).join('\n') },
    `Wrote ${rng.int(400, 900)} bytes to docs/module-map.md.`,
  );

  return b.done({
    id,
    scenario: 'list-traverse-process',
    label: 'negative',
    loopStartIndex: null,
    note: `a ${files.length}-file traversal between a list and a write; the middle fills the window with one tool`,
  });
}

/**
 * N5 — a build-test loop that is converging.
 *
 * The arguments to `npm test` never change — this is the trap. What changes is
 * the answer: seven failures, then four, then one, then none. An agent doing
 * this is making progress on every turn, and halting it is the most expensive
 * mistake AgentFuse can make.
 */
function convergingBuildTest(rng: Rng, id: string): CorpusSession {
  const b = new SessionBuilder();
  const rounds = rng.int(3, 5);
  const sameFile = rng.bool(0.4);
  const file = rng.pick(SOURCE_FILES);
  let failures = rounds * rng.int(2, 3);

  for (let round = 0; round < rounds; round += 1) {
    b.fail(
      'shell',
      'run_command',
      { command: SHELL_TEST },
      `Tests: ${failures} failed, ${48 - failures} passed. Failing: ${rng
        .sample(SOURCE_FILES, 2)
        .map((f) => f.replace('src/', '').replace('.ts', '.test.ts'))
        .join(', ')}`,
    );
    const target = sameFile ? file : rng.pick(SOURCE_FILES);
    b.ok('fs', 'read_file', { path: target }, sourceExcerpt(rng, target));
    b.ok(
      'fs',
      'write_file',
      { path: target, content: `${sourceExcerpt(rng, target)}\n// round ${round + 1} fix` },
      `Wrote ${rng.int(700, 1800)} bytes to ${target}.`,
    );
    failures = Math.max(0, failures - rng.int(2, 4));
  }
  b.ok('shell', 'run_command', { command: SHELL_TEST }, 'Tests: 0 failed, 48 passed.');

  return b.done({
    id,
    scenario: 'converging-build-test',
    label: 'negative',
    loopStartIndex: null,
    note: `${rounds + 1} runs of an unchanging \`${SHELL_TEST}\`, failures falling to zero; progress lives entirely in the result`,
  });
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

type Generator = (rng: Rng, id: string) => CorpusSession;

const GENERATORS: Record<ScenarioName, Generator> = {
  'verbatim-retry': verbatimRetry,
  'reworded-retry': rewordedRetry,
  'error-loop': errorLoop,
  oscillation,
  'drifting-loop': driftingLoop,
  'pagination-sweep': paginationSweep,
  'bulk-edit': bulkEdit,
  'try-then-fix': tryThenFix,
  'list-traverse-process': listTraverseProcess,
  'converging-build-test': convergingBuildTest,
};

/** Every scenario, positives first. */
export const ALL_SCENARIOS: readonly ScenarioName[] = [
  ...POSITIVE_SCENARIOS,
  ...NEGATIVE_SCENARIOS,
];

/** How the corpus is generated. */
export interface CorpusOptions {
  readonly seed?: string;
  readonly sessionsPerScenario?: number;
}

/**
 * Builds the whole labelled corpus.
 *
 * Deterministic in `(seed, sessionsPerScenario)` alone, and each session's
 * generator gets its own derived seed so the scenarios cannot perturb each
 * other.
 */
export function generateCorpus(options: CorpusOptions = {}): CorpusSession[] {
  const seed = options.seed ?? DEFAULT_SEED;
  const per = options.sessionsPerScenario ?? SESSIONS_PER_SCENARIO;
  const out: CorpusSession[] = [];

  for (const scenario of ALL_SCENARIOS) {
    const generate = GENERATORS[scenario];
    for (let i = 0; i < per; i += 1) {
      const index = String(i).padStart(2, '0');
      out.push(generate(new Rng(`${seed}:${scenario}:${i}`), `${scenario}-${index}`));
    }
  }
  return out;
}

/** The corpus as JSONL, with a trailing newline. */
export function toJsonl(sessions: readonly CorpusSession[]): string {
  return `${sessions.map((session) => JSON.stringify(session)).join('\n')}\n`;
}

/** Parses JSONL back into sessions. Blank lines are skipped. */
export function fromJsonl(text: string): CorpusSession[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CorpusSession);
}

export type { NegativeScenario, PositiveScenario, ScenarioName };
