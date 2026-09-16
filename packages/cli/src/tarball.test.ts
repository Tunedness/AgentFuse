import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nonProtocolLines, WireClient } from './testing/wire.js';

/**
 * The drop-in, installed from tarballs, on a machine that is not this
 * workspace.
 *
 * Every other process test in this package runs `dist/main.js` out of the
 * repository, where `node_modules` is hoisted, every workspace package is
 * symlinked into place, and any import resolves whether it was declared or
 * not. That tree answers "does the code work". It cannot answer the question
 * a first-time user asks, which is "does the thing npm hands me work" — and
 * the two differ for exactly the reasons this phase went looking: a `files`
 * array that forgot a directory, an `exports` path that names a file the
 * tarball does not carry, a dependency that was always there by accident.
 *
 * So: pack the real tarballs, unpack them into a directory under the system
 * temp root, link in **only** the third-party packages the manifests actually
 * declare, and run the command line out of that tree against the shipped
 * example configuration.
 *
 * What that proves, and nothing weaker would:
 *
 * - the tarballs are complete — a missing file is an `ERR_MODULE_NOT_FOUND`
 *   on the first import rather than a test that mysteriously still passes;
 * - `agentfuse` finds `@agentfuse/core` and `@agentfuse/proxy` **in the
 *   tarballs**. The temp directory is outside the repository, so Node's
 *   upward walk never reaches the workspace `node_modules`;
 * - the declared dependency list is *sufficient*, not merely minimal. Only
 *   what the manifests name is linked, so an undeclared import fails here;
 * - the flags in `examples/claude-desktop.json` work against the built
 *   binary, not only against the parser `examples.test.ts` feeds them to;
 * - and the breaker actually breaks, from a packed build, with the semantic
 *   tier switched off — which is the claim that the rule tier needs no second
 *   install step.
 *
 * The third-party packages are symlinked from the workspace rather than
 * installed, because `npm install` in a temp directory needs the network and
 * this suite has exactly one network test, gated behind a variable. Node
 * realpaths a symlinked package, so their own dependencies resolve from the
 * workspace tree — which is fine: what is under test is our four tarballs and
 * the completeness of what they ask for.
 */

const HERE = new URL('./', import.meta.url);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./testing/fixtures/raw-server.mjs', HERE));
const EXAMPLE = fileURLToPath(new URL('../../../examples/claude-desktop.json', HERE));

/**
 * Gated on the build and on a POSIX `tar`.
 *
 * `npm pack` needs `dist/`, and the workspace gate runs `build` before `test`,
 * so this runs in CI. Windows has `tar.exe` but not reliably with these flags,
 * and CI is Linux; skipping there is honest rather than pretending.
 */
const runnable = existsSync(new URL('../dist/main.js', HERE)) && process.platform !== 'win32';

/** The three packages a bare `agentfuse wrap` needs. `embeddings-local` is not one. */
const NEEDED = ['agentfuse', '@agentfuse/core', '@agentfuse/proxy'] as const;

interface Packed {
  readonly name: string;
  readonly filename: string;
}

let home = '';
let modules = '';
let bin = '';
let policy = '';

/** Packs the workspace, unpacks what is needed, and links the declared deps. */
function install(): void {
  home = mkdtempSync(join(tmpdir(), 'agentfuse-dropin-'));
  modules = join(home, 'node_modules');
  mkdirSync(modules, { recursive: true });

  // `--pack-destination` does not create the directory; npm reports ENOENT
  // against the tarball it was about to write, which is a confusing way to
  // learn that.
  const tarballs = join(home, 'tarballs');
  mkdirSync(tarballs, { recursive: true });
  const stdout = execFileSync(
    'npm',
    ['pack', '--workspaces', '--json', '--pack-destination', tarballs],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const packed = JSON.parse(stdout) as Packed[];

  const linked = new Set<string>();
  for (const name of NEEDED) {
    const entry = packed.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`npm pack produced no tarball for ${name}`);

    // Every tarball unpacks to a directory called `package/`; extract into a
    // scratch directory and move it to the name Node will look for.
    const scratch = join(home, 'unpack', name.replace('/', '-'));
    mkdirSync(scratch, { recursive: true });
    execFileSync('tar', ['-xzf', join(tarballs, entry.filename), '-C', scratch]);

    const target = join(modules, name);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(scratch, 'package'), target);

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      // Ours come from the tarballs; everything else is linked from the
      // workspace, and only if a manifest asked for it by name.
      if (dependency.startsWith('@agentfuse/') || dependency === 'agentfuse') continue;
      if (linked.has(dependency)) continue;
      linked.add(dependency);
      const source = join(ROOT, 'node_modules', dependency);
      if (!existsSync(source))
        throw new Error(`${name} declares ${dependency}, which is not installed`);
      mkdirSync(dirname(join(modules, dependency)), { recursive: true });
      symlinkSync(source, join(modules, dependency), 'dir');
    }
  }

  bin = join(modules, 'agentfuse', 'dist', 'main.js');

  // `enforce`, a two-call exact-repeat threshold, and the semantic tier off:
  // the tier needs a 292 MB companion and a 23 MB model, and the claim under
  // test is that the rule tier is complete without either.
  policy = join(home, 'fusepolicy.yaml');
  writeFileSync(
    policy,
    [
      'version: 1',
      'mode: enforce',
      'budgets:',
      '  max_calls: 20',
      'loop_detection:',
      '  exact_repeat:',
      '    count: 2',
      '  semantic:',
      '    provider: none',
      'report:',
      '  dir: reports',
      '',
    ].join('\n'),
  );
}

/**
 * The first example entry's flags, with only the two paths substituted.
 *
 * The flags themselves come from the shipped file verbatim: what is being
 * checked is the configuration people copy, so rewriting it here would check
 * something nobody has.
 */
function exampleArgs(): string[] {
  const config = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  const first = Object.values(config.mcpServers)[0];
  if (first === undefined) throw new Error('the example configuration has no entries');

  // Drop `-y agentfuse`: the binary is named directly, because `npx` would
  // reach for the registry.
  const args = first.args.slice(2);
  const separator = args.indexOf('--');
  const flags = args.slice(0, separator).map((token, index, all) =>
    // The one placeholder in the example that has to become real.
    all[index - 1] === '--policy' ? policy : token,
  );
  return [...flags, '--', process.execPath, FIXTURE];
}

function start(): WireClient {
  return WireClient.spawn({
    command: process.execPath,
    args: [bin, ...exampleArgs()],
    // No AGENTFUSE_POLICY: the example's first entry names it with --policy,
    // and a second channel would hide a broken flag.
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    cwd: home,
  });
}

describe.runIf(runnable)('installed from the tarballs', () => {
  beforeAll(() => {
    install();
  });

  afterAll(() => {
    if (home !== '') rmSync(home, { recursive: true, force: true });
  });

  it('puts the binary and both libraries where node will find them', () => {
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(join(modules, '@agentfuse/core', 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(modules, '@agentfuse/proxy', 'dist', 'index.js'))).toBe(true);

    // And the tree really is somewhere else. If it were inside the repository,
    // Node's upward walk would find the workspace `node_modules` and this whole
    // file would be testing the workspace again under another name.
    expect(resolve(home).startsWith(resolve(ROOT))).toBe(false);
  });

  it('ships the JSON Schema on the subpath the manifest advertises', () => {
    // People's editors resolve this path to validate their policy file as they
    // type; it is a published surface, not an internal file.
    const schema = join(modules, '@agentfuse/core', 'schemas', 'fusepolicy.v1.schema.json');

    expect(existsSync(schema)).toBe(true);
    expect(JSON.parse(readFileSync(schema, 'utf8'))).toMatchObject({ type: 'object' });
  });

  it('runs --version out of the packed build', () => {
    const stdout = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });

    // Three versions from three separate tarballs: proof that the CLI resolved
    // the other two rather than falling back to anything.
    expect(stdout).toMatch(/^agentfuse \d+\.\d+\.\d+ \(core \d+\.\d+\.\d+, proxy \d+\.\d+\.\d+\)/);
  });

  it('validates a policy file, which loads core’s whole schema', () => {
    const stdout = execFileSync(process.execPath, [bin, 'validate', '--policy', policy], {
      encoding: 'utf8',
      cwd: home,
    });

    expect(stdout).toContain('enforce');
  });

  it('wraps a server with the example’s own flags and forwards a call', async () => {
    const agent = start();
    try {
      const handshake = (await agent.initialize()) as { serverInfo?: { name?: string } };

      // The wrapped server's identity, mirrored: the agent negotiated against
      // the real server through a proxy that came out of a tarball.
      expect(handshake.serverInfo?.name).toBe('raw-server');

      const first = (await agent.call('tools/call', {
        name: 'echo',
        arguments: { path: '/etc/hosts' },
      })) as { isError?: boolean; content?: { text?: string }[] };

      expect(first.isError).toBeUndefined();
      expect(first.content?.[0]?.text).toBe('{"path":"/etc/hosts"}');
    } finally {
      await agent.dispose();
    }
  });

  it('breaks the circuit from a packed build, with no embedding backend at all', async () => {
    const agent = start();
    try {
      await agent.initialize();
      const args = { name: 'echo', arguments: { path: '/etc/hosts' } };

      await agent.call('tools/call', args);
      const second = (await agent.call('tools/call', args)) as {
        isError?: boolean;
        content?: { text?: string }[];
        structuredContent?: unknown;
      };

      // A refusal, not a protocol error, with the one load-bearing sentence in
      // it — and no `@agentfuse/embeddings-local` anywhere in this tree.
      expect(second.isError).toBe(true);
      expect(second.content?.[0]?.text).toContain('AgentFuse circuit breaker OPEN');
      expect(second.content?.[0]?.text).toContain('Retrying this call unchanged');
      expect(JSON.stringify(second.structuredContent)).toContain('LOOP_EXACT_REPEAT');
      expect(existsSync(join(modules, '@agentfuse/embeddings-local'))).toBe(false);

      // And through all of that stdout carried protocol frames and nothing
      // else, which is the claim a packaging mistake could silently break: a
      // stray write from a module that only ships in the tarball.
      expect(nonProtocolLines(agent.stdout)).toEqual([]);

      agent.endInput();
      expect((await agent.exit()).code).toBe(0);
    } finally {
      await agent.dispose();
    }
  });

  it('writes its trip report where the policy said, relative to the policy', async () => {
    // `report.dir: reports` is relative, and it has to resolve against the
    // policy file rather than the process working directory — an MCP client
    // launches the server somewhere the user did not choose.
    const stdout = execFileSync(process.execPath, [bin, 'report', 'list', '--policy', policy], {
      encoding: 'utf8',
      cwd: home,
    });

    expect(stdout).toContain('LOOP_EXACT_REPEAT');
    expect(existsSync(join(home, 'reports'))).toBe(true);
  });
});
