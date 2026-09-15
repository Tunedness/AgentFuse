/**
 * Finding the optional embedding backend, and what to do when it is not there.
 *
 * ## The invariant
 *
 * **`agentfuse` must never depend on `@agentfuse/embeddings-local`** — not in
 * `dependencies`, not in `devDependencies`, not in `peerDependencies`.
 * `discipline.test.ts` fails the build if it ever does. ADR-003 measured the
 * reason: `onnxruntime-node` unpacks to about 301 MB because it ships every
 * platform's binaries in one tarball, and a 300 MB `npx agentfuse` is not a
 * drop-in. So the backend lives in a companion package that is found at runtime
 * through a dynamic `import()` and nowhere else.
 *
 * ## The decision table
 *
 * ADR-001 forbids crippleware, and ADR-003 says in as many words that the rule
 * tier is fully functional without this package. That fixes three of the four
 * rows; the fourth follows from not lying to an operator who asked to be
 * protected.
 *
 * | configuration | package usable | outcome |
 * | --- | --- | --- |
 * | `semantic.enabled: false` | — | not attached, silently. Asking for it to be off and getting it off is not a degradation. |
 * | `semantic.provider: none` | — | same. This is the documented off switch. |
 * | `provider: local` | yes | attached. |
 * | `provider: local`, `mode: warn` | no | a warning on stderr, **the run proceeds**, the four deterministic rules keep working at full strength. |
 * | `provider: local`, `mode: enforce` | no | a hard error before the first call. |
 *
 * The last row is the only one with a judgement in it. In `enforce` the
 * operator has said "break the circuit on my behalf"; starting anyway with one
 * of the named detectors missing would be the tool quietly deciding that a
 * subset of the requested protection is close enough. In `warn` nothing is
 * being enforced yet, the run is an observation, and refusing to start would
 * cost the user their whole session to protect them from a weaker report.
 *
 * ## What phase 4 has to export
 *
 * This file is the contract. `@agentfuse/embeddings-local` must export:
 *
 * ```ts
 * createEmbeddingProvider(options: { model: string }): Promise<EmbeddingProvider>
 * installModel(options: { model: string; onProgress?: (e: InstallProgress) => void })
 *   : Promise<{ path: string; bytes: number }>
 * ```
 *
 * `EmbeddingProvider` is core's frozen port, L2-normalized vectors included.
 * A package that is installed but exports neither is treated exactly like one
 * that is absent — with a message that says which of the two happened, because
 * "install it" and "upgrade it" are different instructions.
 */

import type { EmbeddingProvider, PolicyMode } from '@agentfuse/core';
import { CliError, EXIT, messageOf } from './errors.js';

/** The package that carries the local backend. Named in every message. */
export const EMBEDDINGS_PACKAGE = '@agentfuse/embeddings-local';

/** Progress notes `installModel` may report. */
export interface InstallProgress {
  readonly message: string;
  /** Bytes fetched so far, when the step has a size. */
  readonly received?: number;
  readonly total?: number;
}

/** The surface {@link EMBEDDINGS_PACKAGE} is expected to expose. */
export interface EmbeddingsModule {
  createEmbeddingProvider?: (options: { model: string }) => Promise<EmbeddingProvider>;
  installModel?: (options: {
    model: string;
    onProgress?: (progress: InstallProgress) => void;
  }) => Promise<{ path: string; bytes: number }>;
}

/** Imports the companion package. Injected so every row above is testable. */
export type EmbeddingsLoader = () => Promise<unknown>;

/**
 * The real loader.
 *
 * The specifier is built at runtime so that a bundler cannot turn this into a
 * static edge and reintroduce the dependency the whole design removes.
 */
export const loadEmbeddingsPackage: EmbeddingsLoader = () => import(EMBEDDINGS_PACKAGE);

/** What the policy asks of the semantic layer. */
export interface SemanticRequest {
  /** Whether any rule, or the global block, wants semantic scoring at all. */
  readonly wanted: boolean;
  /** Providers named by the settings that want it, deduplicated. */
  readonly providers: readonly string[];
  /** Models named by those settings, deduplicated. */
  readonly models: readonly string[];
  /**
   * The model to load: the first one an active setting names.
   *
   * Empty exactly when {@link SemanticRequest.wanted} is `false`, because the
   * two are filled by the same pass. A consumer that has checked `wanted` has
   * a model, with no second copy of the schema's default to fall back to.
   */
  readonly model: string;
}

/** The shape of the compiled policy this module reads. Structural on purpose. */
interface SemanticSettingsSource {
  readonly policy: { readonly loop_detection: LoopSettingsView };
  readonly rules: readonly { readonly loop: LoopSettingsView }[];
}

interface LoopSettingsView {
  readonly semantic: {
    readonly enabled: boolean;
    readonly provider: string;
    readonly model: string;
  };
}

/**
 * Reads the policy for what the semantic layer is being asked for.
 *
 * Every rule's merged settings are considered, not only the global block: a
 * per-rule `loop_detection.semantic.enabled: true` under a global `false` means
 * the layer is wanted, and starting without it because the top-level switch
 * looked off would silently drop the rule the operator wrote most
 * deliberately.
 */
export function semanticRequestOf(compiled: SemanticSettingsSource): SemanticRequest {
  const providers = new Set<string>();
  const models = new Set<string>();
  let model = '';
  const consider = (loop: LoopSettingsView): void => {
    const { enabled, provider, model: named } = loop.semantic;
    if (!enabled || provider === 'none') return;
    providers.add(provider);
    models.add(named);
    if (model === '') model = named;
  };
  consider(compiled.policy.loop_detection);
  for (const rule of compiled.rules) consider(rule.loop);
  return { wanted: providers.size > 0, providers: [...providers], models: [...models], model };
}

/** The outcome of applying the table in the module doc. */
export type SemanticResolution =
  | {
      readonly kind: 'off';
      /** Why nothing was attached. Not a warning: this was asked for. */
      readonly reason: string;
    }
  | {
      readonly kind: 'ready';
      readonly provider: EmbeddingProvider;
    }
  | {
      readonly kind: 'degraded';
      /** Printed on stderr. The run continues, rule-only. */
      readonly warning: readonly string[];
    };

/** How {@link resolveEmbeddingProvider} behaves. */
export interface ResolveEmbeddingOptions {
  readonly request: SemanticRequest;
  /** The policy's `mode`. Decides warn-and-continue versus hard failure. */
  readonly mode: PolicyMode;
  readonly load?: EmbeddingsLoader | undefined;
}

/** The message body shared by the warn and the enforce paths. */
function unavailableLines(detail: string, model: string): string[] {
  return [
    detail,
    `Install it with \`npm install ${EMBEDDINGS_PACKAGE}\`, then \`agentfuse models install\` to fetch ${model}.`,
    'Or set loop_detection.semantic.provider: none to run on the deterministic rules alone — exact repeats, error repeats and short cycles all work without any model.',
  ];
}

/**
 * Applies the decision table.
 *
 * @throws {CliError} only for the `enforce` + unusable row.
 */
export async function resolveEmbeddingProvider(
  options: ResolveEmbeddingOptions,
): Promise<SemanticResolution> {
  const { request, mode } = options;
  const load = options.load ?? loadEmbeddingsPackage;

  if (!request.wanted) {
    return {
      kind: 'off',
      reason:
        'semantic loop detection is off in this policy (semantic.enabled: false or provider: none); the deterministic rules are unaffected',
    };
  }

  const unsupported = request.providers.filter((provider) => provider !== 'local');
  if (unsupported.length > 0) {
    // `openai` is in the schema because ADR-003 keeps API embedding as an
    // option, but no backend for it ships in P0. Saying so is better than
    // attaching nothing and letting the report imply it scored.
    return fail(
      mode,
      `loop_detection.semantic.provider is ${unsupported.join(', ')}, and this build has no backend for it`,
      [
        'This release ships only `local` (through the companion package) and `none`.',
        'Set loop_detection.semantic.provider to `local` or `none`.',
      ],
    );
  }

  let module: unknown;
  try {
    module = await load();
  } catch (error) {
    const message = messageOf(error);
    return fail(
      mode,
      `loop_detection.semantic.provider is local, but ${EMBEDDINGS_PACKAGE} is not installed`,
      unavailableLines(message, request.model),
    );
  }

  const factory = (module as EmbeddingsModule).createEmbeddingProvider;
  if (typeof factory !== 'function') {
    return fail(
      mode,
      `${EMBEDDINGS_PACKAGE} is installed but does not export createEmbeddingProvider`,
      unavailableLines(
        'That export is the interface AgentFuse loads it through, so this is a version mismatch rather than a missing install.',
        request.model,
      ),
    );
  }

  const model = request.model;
  try {
    return { kind: 'ready', provider: await factory({ model }) };
  } catch (error) {
    return fail(
      mode,
      `${EMBEDDINGS_PACKAGE} could not load the model ${model}`,
      unavailableLines(messageOf(error), request.model),
    );
  }
}

/** The warn-versus-enforce split, in one place so it cannot diverge. */
function fail(mode: PolicyMode, headline: string, detail: readonly string[]): SemanticResolution {
  if (mode === 'enforce') {
    throw new CliError(headline, {
      exitCode: EXIT.missingDependency,
      hints: [
        ...detail,
        'This is fatal in `mode: enforce` on purpose: you asked AgentFuse to break the circuit using a detector that is not here. It is a warning in `mode: warn`.',
      ],
    });
  }
  return {
    kind: 'degraded',
    warning: [
      `${headline}.`,
      ...detail,
      'Continuing in warn mode with the deterministic loop rules only.',
    ],
  };
}

/**
 * Resolves the companion package for `models install`.
 *
 * Separate from the policy path because the two failures want different
 * messages: here the user has explicitly asked to install a model, so there is
 * nothing to degrade to and nothing to warn about.
 *
 * @throws {CliError} when the package is missing or too old.
 */
export async function loadInstaller(
  load: EmbeddingsLoader = loadEmbeddingsPackage,
): Promise<NonNullable<EmbeddingsModule['installModel']>> {
  let module: unknown;
  try {
    module = await load();
  } catch (error) {
    throw new CliError(`${EMBEDDINGS_PACKAGE} is not installed`, {
      exitCode: EXIT.missingDependency,
      hints: [
        `\`agentfuse models install\` delegates to ${EMBEDDINGS_PACKAGE}, which AgentFuse deliberately does not depend on: it carries onnxruntime-node, about 301 MB of platform binaries, and bundling that into every install is what ADR-003 rejected.`,
        `Install it first: npm install ${EMBEDDINGS_PACKAGE}`,
        messageOf(error),
      ],
      cause: error,
    });
  }

  const installer = (module as EmbeddingsModule).installModel;
  if (typeof installer !== 'function') {
    throw new CliError(`${EMBEDDINGS_PACKAGE} does not export installModel`, {
      exitCode: EXIT.missingDependency,
      hints: [
        'That export is how AgentFuse drives the download, so the installed copy is either older or newer than this CLI.',
        `Update both: npm install ${EMBEDDINGS_PACKAGE}@latest agentfuse@latest`,
      ],
    });
  }
  return installer;
}
