import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { signatureHeaderValue } from './approvals/webhook-gateway.js';
import { parseArgs } from './args.js';
import { COMMANDS } from './cli.js';
import { MODE_VALUES } from './commands/shared.js';
import { RELAYABLE, WRAP_FLAGS } from './commands/wrap.js';

/**
 * The shipped example configuration, checked against the parser that will read
 * it.
 *
 * An example nobody runs is an example that rots, and this one is the first
 * thing most users will copy: an MCP client's server configuration is where
 * `agentfuse wrap` is actually typed. So every entry is put through the real
 * flag declaration rather than eyeballed — a `--mode warm` or a `--relay
 * samplng` in a file people paste from would be a support burden created by a
 * typo nobody could see.
 *
 * The file is deliberately plain JSON with no comment keys: it is copied into
 * `claude_desktop_config.json`, and an example that needs editing before it
 * parses is an example that gets edited wrong.
 */

const EXAMPLE = fileURLToPath(new URL('../../../examples/claude-desktop.json', import.meta.url));

interface DesktopConfig {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> | undefined }
  >;
}

function config(): DesktopConfig {
  return JSON.parse(readFileSync(EXAMPLE, 'utf8')) as DesktopConfig;
}

/** The entries, as `[name, entry]` pairs for `it.each`. */
const entries = Object.entries(config().mcpServers);

describe('examples/claude-desktop.json', () => {
  it('is valid JSON with at least one server in it', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('carries no comment keys, because the file is copied verbatim', () => {
    const raw = readFileSync(EXAMPLE, 'utf8');

    expect(Object.keys(config())).toEqual(['mcpServers']);
    expect(raw).not.toContain('//');
    // Bar the URL-shaped absolute paths, which have none.
    expect(raw).not.toContain('/*');
  });

  it.each(entries)('%s runs agentfuse through npx', (_name, entry) => {
    expect(entry.command).toBe('npx');
    // `-y` so a machine that has never installed it does not sit waiting for a
    // confirmation nobody can see.
    expect(entry.args.slice(0, 2)).toEqual(['-y', 'agentfuse']);
  });

  it.each(entries)('%s names a command this build has', (_name, entry) => {
    expect(COMMANDS).toContain(entry.args[2]);
  });

  it.each(entries)('%s parses against the real wrap flag declaration', (_name, entry) => {
    const args = entry.args.slice(3);

    // Throws on an unknown flag, on a misspelling and on a value flag with no
    // value, which is the whole point of running the example through it.
    const parsed = parseArgs(args, WRAP_FLAGS);

    expect(parsed.sawSeparator).toBe(true);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.rest.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s gives the wrapped server a name of its own', (_name, entry) => {
    const parsed = parseArgs(entry.args.slice(3), WRAP_FLAGS);

    // The alias is part of every fingerprint, so the examples set it rather
    // than leaning on the guess made from the command.
    expect(parsed.value('name')).toBeTruthy();
  });

  it.each(entries)('%s uses only values the validators accept', (_name, entry) => {
    const parsed = parseArgs(entry.args.slice(3), WRAP_FLAGS);
    const mode = parsed.value('mode');
    const relay = parsed.value('relay');
    const timeout = parsed.value('request-timeout');

    if (mode !== undefined) expect(MODE_VALUES).toContain(mode);
    if (relay !== undefined) {
      for (const capability of relay.split(',')) expect(RELAYABLE).toContain(capability);
    }
    if (timeout !== undefined) expect(Number.isInteger(Number(timeout))).toBe(true);
  });

  it.each(entries)('%s points at a policy, by flag or by environment', (_name, entry) => {
    const parsed = parseArgs(entry.args.slice(3), WRAP_FLAGS);

    // An MCP client launches the server in a working directory the user did not
    // choose — often `/` — so the upward search for `fusepolicy.yaml` cannot be
    // relied on here. One of the two explicit channels has to be used.
    const named =
      parsed.value('policy') !== undefined || entry.env?.['AGENTFUSE_POLICY'] !== undefined;
    expect(named).toBe(true);
  });

  it('shows a child flag surviving the separator, which is the trap', () => {
    // `--verbose` belongs to the wrapped server. An example that never
    // demonstrated this would leave the reader to discover it by breaking it.
    const withChildFlag = entries.find(([, entry]) =>
      parseArgs(entry.args.slice(3), WRAP_FLAGS).rest.some((token) => token.startsWith('--')),
    );

    expect(withChildFlag).toBeDefined();
  });

  it('shows the enforce mode as well as the default', () => {
    const modes = entries.map(([, entry]) =>
      parseArgs(entry.args.slice(3), WRAP_FLAGS).value('mode'),
    );

    expect(modes).toContain('enforce');
    // And at least one without the flag, which is the policy's own mode and
    // starts at `warn`.
    expect(modes).toContain(undefined);
  });
});

/**
 * The shipped approval receiver, checked against the signer that will call it.
 *
 * An example of a security-relevant protocol is worse than no example if it is
 * subtly wrong, and the way it goes wrong — signing a re-serialised body,
 * comparing with `===`, trusting an unsigned timestamp — is invisible on a
 * reading. So the file is imported and run against `WebhookApprovalGateway`
 * itself, which is the only party whose agreement matters.
 */

const RECEIVER = fileURLToPath(new URL('../../../examples/approval-webhook.mjs', import.meta.url));

interface Receiver {
  verify(secret: string, body: string, header: string | undefined): boolean;
}

async function receiver(): Promise<Receiver> {
  return (await import(pathToFileURL(RECEIVER).href)) as Receiver;
}

describe('examples/approval-webhook.mjs', () => {
  it('verifies exactly what the gateway signs', async () => {
    const { verify } = await receiver();
    const body = JSON.stringify({ hello: 'world', timestamp: 1 });

    expect(verify('shhh', body, signatureHeaderValue('shhh', body))).toBe(true);
  });

  it.each([
    ['a body changed by one byte', (body: string) => `${body} `],
    ['a body with the same fields in another order', () => '{"timestamp":1,"hello":"world"}'],
  ])('rejects %s', async (_label, mangle) => {
    const { verify } = await receiver();
    const body = JSON.stringify({ hello: 'world', timestamp: 1 });

    expect(verify('shhh', mangle(body), signatureHeaderValue('shhh', body))).toBe(false);
  });

  it('rejects a missing header and the wrong secret', async () => {
    const { verify } = await receiver();
    const body = '{"a":1}';

    expect(verify('shhh', body, undefined)).toBe(false);
    expect(verify('shhh', body, signatureHeaderValue('other', body))).toBe(false);
  });

  it('never contains a secret of its own', () => {
    const source = readFileSync(RECEIVER, 'utf8');

    // The whole point of `secret_env`: an example people copy must not teach
    // them to paste a secret into a file they will commit.
    expect(source).toContain('process.env.AGENTFUSE_WEBHOOK_SECRET');
    expect(source).toContain('secret_env');
  });

  it('says what an unparseable answer means, because none of them fail open', () => {
    const source = readFileSync(RECEIVER, 'utf8');

    expect(source).toContain('There is no response shape that fails open');
  });
});
