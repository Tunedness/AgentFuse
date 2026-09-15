/**
 * One decision: which approval channel, if any, this run gets.
 *
 * The shape is deliberately the one `embeddings.ts` uses for the embedding
 * backend — a single function returning a small union, with every row of its
 * table pinned by a test — so that "the thing you configured is not usable" is
 * decided in one place rather than at each call site.
 *
 * | configuration | result |
 * | --- | --- |
 * | `mode: warn` | **off, silently.** Warn mode never asks a human: the engine resolves approvals only under `enforce`, and everything a `require_approval` rule would have gated is forwarded and reported as `wouldTrip`. |
 * | the policy never asks for approval | **off, silently.** Nothing to ask about. |
 * | `enforce` + `gateways: []` | **off, with a warning.** |
 * | `enforce` + `gateways: [cli]` | the unix socket. |
 * | `enforce` + `gateways: [webhook]` | the signed POST. |
 * | `enforce` + both | both, composed. See `compose.ts` for the rule. |
 * | `enforce` + a channel that cannot be opened | **off for that channel, with a warning.** |
 *
 * ## Why a broken channel is a warning and not a hard error
 *
 * This is the one place the approval table deliberately departs from the
 * embedding table next door, which makes `provider: local` + `mode: enforce` +
 * a missing package a hard exit. The reasoning there was that starting anyway
 * would let AgentFuse silently decide a *subset* of the requested protection
 * was close enough.
 *
 * An approval channel fails the other way. With no channel, `require_approval`
 * resolves to a denial — **stricter** than what the operator asked for, never
 * looser, and nothing is forwarded that would not have been forwarded anyway.
 * Refusing to start, meanwhile, takes the user's MCP server down with it: the
 * wrap is what their client launches, so a hard error here does not produce a
 * safer run, it produces no run — and an agent with no fuse in front of it at
 * all. So the channel goes quiet, loudly: a multi-line warning naming the
 * channel, the underlying failure and its hints, and a `approval_gateway_off`
 * diagnostic.
 *
 * `on_timeout: allow` gets a warning of its own wherever a gateway is opened:
 * it is the one setting in the file that makes AgentFuse fail **open**, and a
 * tool whose job is enforcement should say so out loud every time it starts.
 */

import type { ApprovalGateway, FusePolicy } from '@agentfuse/core';
import type { Diagnostics } from '@agentfuse/proxy';
import { CliError, messageOf } from '../errors.js';
import type { Writer } from '../io.js';
import { type ApprovalHost, CliApprovalGateway } from './cli-gateway.js';
import { CompositeApprovalGateway, type NamedGateway } from './compose.js';
import { resolveApprovalSocketPath, SOCKET_ENV_VAR } from './protocol.js';
import type { SocketListener } from './socket.js';
import { type FetchLike, WebhookApprovalGateway } from './webhook-gateway.js';

export type { ApprovalHost } from './cli-gateway.js';

/**
 * Whether a policy can ever produce an approval request.
 *
 * Read off the policy rather than discovered at the first blocked call, because
 * everything in the table above has to be decided before the engine exists.
 *
 * An `onDecision` hook deliberately does not count. The engine resolves
 * approvals from the *guards'* action, and hooks run afterwards — so a hook
 * that raises a call to `require_approval` is reported to the agent as
 * `POLICY_APPROVAL` and never reaches a gateway. That is the frozen behaviour;
 * opening a socket for it would suggest otherwise.
 */
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

/** What this run got. */
export type ApprovalResolution =
  | { readonly kind: 'off'; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly gateway: ApprovalGateway;
      /** The channels, in policy order, for the startup diagnostic. */
      readonly sources: readonly string[];
      /** The bound socket path, when a CLI gateway is among them. */
      readonly socketPath: string | undefined;
      /** Hands the engine over, once it exists. See `cli-gateway.ts`. */
      bindHost(host: ApprovalHost): void;
      close(): Promise<void>;
    };

/** What {@link resolveApprovalGateway} needs. */
export interface ApprovalResolveOptions {
  readonly policy: FusePolicy;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly diagnostics: Diagnostics;
  /** Where a pending prompt goes. Not silenced by `--quiet`; see `cli-gateway.ts`. */
  readonly stderr: Writer;
  /** Multi-line operator warnings, already carrying `--quiet`. */
  readonly warn: (lines: readonly string[]) => void;
  /** This user's uid, where the platform has one. */
  readonly uid?: number | undefined;
  /** Distinguishes this process's fallback socket from another wrap's. */
  readonly suffix?: string | undefined;
  /** Injected for tests. */
  readonly listen?: SocketListener | undefined;
  /** Injected for tests. */
  readonly fetch?: FetchLike | undefined;
  /** Injected for tests. */
  readonly now?: (() => number) | undefined;
}

/**
 * Reads the shared secret.
 *
 * @throws {CliError} when the named variable is unset or empty. Caught by
 * {@link resolveApprovalGateway} and turned into a warning; the error type is
 * still a `CliError` because what it carries — a message plus the hints that
 * fix it — is exactly what the warning needs to say.
 */
function secretFor(variable: string, env: Readonly<Record<string, string | undefined>>): string {
  const secret = env[variable];
  if (secret !== undefined && secret !== '') return secret;
  throw new CliError(`the shared secret ${variable} is not set`, {
    hints: [
      `approvals.webhook.secret_env names ${variable}, and this process has no such variable.`,
      'The secret lives in the environment on purpose: a policy file is meant to be committed and diffed.',
      `Export it where AgentFuse runs: ${variable}=… agentfuse wrap -- <command>`,
    ],
  });
}

/** Whether a URL is one where an unencrypted POST is nobody else's business. */
function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/** Builds the webhook channel, with the two warnings its configuration earns. */
function webhookGateway(options: ApprovalResolveOptions): WebhookApprovalGateway {
  const config = options.policy.approvals.webhook;
  if (config === undefined) {
    throw new CliError(
      'approvals.gateways lists webhook, and there is no approvals.webhook block',
      {
        hints: [
          'Add the endpoint and the name of the variable holding its secret:',
          '  approvals:',
          '    gateways: [webhook]',
          '    webhook:',
          '      url: https://example.internal/agentfuse/approvals',
          '      secret_env: AGENTFUSE_WEBHOOK_SECRET',
        ],
      },
    );
  }

  const secret = secretFor(config.secret_env, options.env);
  const url = new URL(config.url);
  if (url.protocol !== 'https:' && !isLoopback(url)) {
    options.warn([
      `The approval webhook ${config.url} is not https.`,
      'The shared secret never leaves this machine — only the HMAC does — but the verdict comes back unauthenticated, so anybody on the path can approve a call.',
      'Use https for anything but a loopback endpoint.',
    ]);
  }

  return new WebhookApprovalGateway({
    url: config.url,
    secret,
    diagnostics: options.diagnostics,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
    ...(options.now !== undefined ? { now: options.now } : undefined),
  });
}

/** Applies the table in the module doc. */
export async function resolveApprovalGateway(
  options: ApprovalResolveOptions,
): Promise<ApprovalResolution> {
  const { policy } = options;
  if (policy.mode !== 'enforce') return { kind: 'off', reason: 'warn mode never asks a human' };
  if (!wantsApproval(policy)) {
    return { kind: 'off', reason: 'the policy never asks for approval' };
  }

  // Deduplicated: `gateways: [cli, cli]` is a typo, and honouring it would open
  // two listeners, the second on the fallback path, with no way to tell them
  // apart in a prompt.
  const names = [...new Set(policy.approvals.gateways)];
  if (names.length === 0) {
    options.warn([
      'This policy asks for human approval and approvals.gateways is empty.',
      'Approvals therefore fail closed: a call that needs one is denied without anybody being asked.',
      'Set approvals.gateways: [cli] to be prompted on stderr, or [webhook] to POST the request somewhere.',
    ]);
    return { kind: 'off', reason: 'approvals.gateways is empty' };
  }

  if (policy.approvals.on_timeout === 'allow') {
    options.warn([
      'approvals.on_timeout is `allow`, which makes AgentFuse fail OPEN.',
      `An approval nobody answers within ${policy.approvals.timeout}ms is forwarded to the wrapped server as if it had been approved.`,
      'This is not recommended: the call a policy singled out for a human is exactly the one that should not go through unattended. Use `deny` unless you have a reason.',
    ]);
  }

  const members: NamedGateway[] = [];
  let cli: CliApprovalGateway | undefined;

  for (const name of names) {
    try {
      if (name === 'cli') {
        const choice = resolveApprovalSocketPath(options.env, options.suffix ?? 'alt');
        cli = await CliApprovalGateway.open({
          path: choice.path,
          fallback: choice.fallback,
          defaultPath: choice.path,
          stderr: options.stderr,
          diagnostics: options.diagnostics,
          ...(options.uid !== undefined ? { uid: options.uid } : undefined),
          ...(options.listen !== undefined ? { listen: options.listen } : undefined),
        });
        options.diagnostics.emit('approval_gateway', {
          source: 'cli',
          socket: cli.path,
          origin: choice.origin,
          socketEnv: SOCKET_ENV_VAR,
        });
        members.push({ name: 'cli', gateway: cli });
      } else {
        members.push({ name: 'webhook', gateway: webhookGateway(options) });
        options.diagnostics.emit('approval_gateway', {
          source: 'webhook',
          url: policy.approvals.webhook?.url,
          secretEnv: policy.approvals.webhook?.secret_env,
        });
      }
    } catch (error) {
      // Per the module doc: a channel that cannot be opened goes quiet, and
      // says so. The other configured channel, if any, still gets its turn —
      // a broken webhook must not take the terminal prompt down with it.
      options.warn([
        `The ${name} approval channel could not be opened: ${messageOf(error)}`,
        ...(error instanceof CliError ? error.hints : []),
        'Approvals from this channel therefore fail closed: a call that needs one is denied without anybody being asked. Nothing is forwarded that would not have been.',
      ]);
      options.diagnostics.emit('approval_gateway_unavailable', {
        source: name,
        message: messageOf(error),
      });
    }
  }

  if (members.length === 0) {
    return { kind: 'off', reason: 'no approval channel could be opened' };
  }

  const [only] = members;
  const gateway =
    members.length === 1 && only !== undefined
      ? only.gateway
      : new CompositeApprovalGateway(members, options.diagnostics);

  return {
    kind: 'ready',
    gateway,
    sources: members.map((member) => member.name),
    socketPath: cli?.path,
    bindHost: (host) => cli?.bindHost(host),
    close: async () => {
      await cli?.close();
    },
  };
}
