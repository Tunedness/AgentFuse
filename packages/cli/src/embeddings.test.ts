import { compilePolicy, type EmbeddingProvider, parsePolicy } from '@agentfuse/core';
import { describe, expect, it } from 'vitest';
import {
  EMBEDDINGS_PACKAGE,
  type EmbeddingsLoader,
  loadEmbeddingsPackage,
  loadInstaller,
  resolveEmbeddingProvider,
  semanticRequestOf,
} from './embeddings.js';
import type { CliError } from './errors.js';

/** The compiled policy for a document fragment. */
function compiled(document: Record<string, unknown>) {
  return compilePolicy(parsePolicy({ version: 1, ...document }));
}

/** A provider double. Phase 4 supplies the real one. */
const provider: EmbeddingProvider = {
  id: 'test:double',
  dims: 8,
  embed: async (texts) => texts.map(() => new Float32Array(8)),
};

/** A loader that resolves to a module shape. */
const loaderFor =
  (module: unknown): EmbeddingsLoader =>
  async () =>
    module;

/** A loader that fails the way a missing package does. */
const missing: EmbeddingsLoader = async () => {
  const error = new Error(`Cannot find package '${EMBEDDINGS_PACKAGE}'`);
  (error as Error & { code?: string }).code = 'ERR_MODULE_NOT_FOUND';
  throw error;
};

describe('semanticRequestOf', () => {
  it('wants the layer by default, because the schema enables it', () => {
    const request = semanticRequestOf(compiled({}));

    expect(request).toEqual({
      wanted: true,
      providers: ['local'],
      models: ['Xenova/all-MiniLM-L6-v2'],
      model: 'Xenova/all-MiniLM-L6-v2',
    });
  });

  it('leaves the model empty exactly when nothing is wanted', () => {
    // The two are filled by the same pass, so a consumer that checked `wanted`
    // has a model and needs no second copy of the schema's default.
    expect(
      semanticRequestOf(compiled({ loop_detection: { semantic: { enabled: false } } })).model,
    ).toBe('');
    expect(semanticRequestOf(compiled({})).model).not.toBe('');
  });

  it('does not want it when it is disabled globally', () => {
    expect(
      semanticRequestOf(compiled({ loop_detection: { semantic: { enabled: false } } })).wanted,
    ).toBe(false);
  });

  it('does not want it when the provider is `none`', () => {
    expect(
      semanticRequestOf(compiled({ loop_detection: { semantic: { provider: 'none' } } })).wanted,
    ).toBe(false);
  });

  it('wants it when a single rule asks for it under a global `false`', () => {
    // Starting without the layer because the top-level switch looked off would
    // silently drop the rule the operator wrote most deliberately.
    const request = semanticRequestOf(
      compiled({
        loop_detection: { semantic: { enabled: false } },
        tools: [
          { match: 'shell__*', action: 'warn', loop_detection: { semantic: { enabled: true } } },
          { match: '*', action: 'allow' },
        ],
      }),
    );

    expect(request.wanted).toBe(true);
    expect(request.providers).toEqual(['local']);
  });

  it('collects every distinct provider and model the policy names', () => {
    const request = semanticRequestOf(
      compiled({
        tools: [
          {
            match: 'api__*',
            action: 'allow',
            loop_detection: { semantic: { provider: 'openai', model: 'text-embedding-3-small' } },
          },
          { match: '*', action: 'allow' },
        ],
      }),
    );

    expect([...request.providers].sort()).toEqual(['local', 'openai']);
    expect(request.models).toContain('text-embedding-3-small');
    expect(request.models).toContain('Xenova/all-MiniLM-L6-v2');
  });

  it('skips a rule that turns the layer off for itself', () => {
    const request = semanticRequestOf(
      compiled({
        loop_detection: { semantic: { provider: 'none' } },
        tools: [
          { match: 'fs__*', action: 'allow', loop_detection: { semantic: { provider: 'none' } } },
          { match: '*', action: 'allow' },
        ],
      }),
    );

    expect(request.wanted).toBe(false);
    expect(request.providers).toEqual([]);
  });
});

describe('the decision table when the companion package is absent', () => {
  it('semantic.enabled: false — not attached, and not a degradation', async () => {
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({ loop_detection: { semantic: { enabled: false } } })),
      mode: 'enforce',
      load: missing,
    });

    expect(resolution.kind).toBe('off');
    // Asking for it to be off and getting it off is not a warning, in either
    // mode — note this row passes with `mode: enforce`.
    if (resolution.kind === 'off') {
      expect(resolution.reason).toContain('off in this policy');
    }
  });

  it('provider: none — the same, and this is the documented off switch', async () => {
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({ loop_detection: { semantic: { provider: 'none' } } })),
      mode: 'enforce',
      load: missing,
    });

    expect(resolution.kind).toBe('off');
  });

  it('provider: local + mode: warn — a stderr warning, and the run proceeds', async () => {
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({})),
      mode: 'warn',
      load: missing,
    });

    expect(resolution.kind).toBe('degraded');
    if (resolution.kind !== 'degraded') return;
    const text = resolution.warning.join(' ');
    // ADR-001 forbids crippleware and ADR-003 says the rule tier is fully
    // functional without this package, so the warning has to say so rather
    // than implying the run is now useless.
    expect(text).toContain(EMBEDDINGS_PACKAGE);
    expect(text).toContain(`npm install ${EMBEDDINGS_PACKAGE}`);
    expect(text).toContain('deterministic');
    expect(text).toContain('Continuing in warn mode');
  });

  it('provider: local + mode: enforce — a hard error before the first call', async () => {
    // The operator said "break the circuit on my behalf". Starting anyway with
    // one of the named detectors missing would be the tool quietly deciding
    // that a subset of the requested protection is close enough.
    let caught: CliError | undefined;
    try {
      await resolveEmbeddingProvider({
        request: semanticRequestOf(compiled({})),
        mode: 'enforce',
        load: missing,
      });
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toContain(`${EMBEDDINGS_PACKAGE} is not installed`);
    expect(caught?.exitCode).toBe(4);
    expect(caught?.hints.join(' ')).toContain('fatal in `mode: enforce`');
    expect(caught?.hints.join(' ')).toContain('provider: none');
  });
});

describe('the decision table when the package is there', () => {
  it('attaches the provider the package builds', async () => {
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({})),
      mode: 'enforce',
      load: loaderFor({ createEmbeddingProvider: async () => provider }),
    });

    expect(resolution).toEqual({ kind: 'ready', provider });
  });

  it('asks for the model the policy names', async () => {
    const asked: string[] = [];
    await resolveEmbeddingProvider({
      request: semanticRequestOf(
        compiled({ loop_detection: { semantic: { model: 'custom/model' } } }),
      ),
      mode: 'warn',
      load: loaderFor({
        createEmbeddingProvider: async (options: { model: string }) => {
          asked.push(options.model);
          return provider;
        },
      }),
    });

    expect(asked).toEqual(['custom/model']);
  });

  it('treats a package with no factory as a version mismatch, not a missing install', async () => {
    // "Install it" and "upgrade it" are different instructions.
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({})),
      mode: 'warn',
      load: loaderFor({ somethingElse: true }),
    });

    expect(resolution.kind).toBe('degraded');
    if (resolution.kind !== 'degraded') return;
    expect(resolution.warning[0]).toContain('does not export createEmbeddingProvider');
    expect(resolution.warning.join(' ')).toContain('version mismatch');
  });

  it('degrades when the factory itself fails', async () => {
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({})),
      mode: 'warn',
      load: loaderFor({
        createEmbeddingProvider: async () => {
          throw new Error('no model in the cache and AGENTFUSE_OFFLINE=1');
        },
      }),
    });

    expect(resolution.kind).toBe('degraded');
    if (resolution.kind !== 'degraded') return;
    expect(resolution.warning.join(' ')).toContain('could not load the model');
    expect(resolution.warning.join(' ')).toContain('AGENTFUSE_OFFLINE=1');
  });

  it('fails hard on a broken factory in enforce mode too', async () => {
    await expect(
      resolveEmbeddingProvider({
        request: semanticRequestOf(compiled({})),
        mode: 'enforce',
        load: loaderFor({
          createEmbeddingProvider: async () => {
            throw new Error('nope');
          },
        }),
      }),
    ).rejects.toThrow(/could not load the model/);
  });
});

describe('a provider this build has no backend for', () => {
  it('says so rather than attaching nothing and letting the report imply it scored', async () => {
    // `openai` is in the schema because ADR-003 keeps API embedding as an
    // option, but no backend for it ships in P0.
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(
        compiled({ loop_detection: { semantic: { provider: 'openai' } } }),
      ),
      mode: 'warn',
      load: loaderFor({ createEmbeddingProvider: async () => provider }),
    });

    expect(resolution.kind).toBe('degraded');
    if (resolution.kind !== 'degraded') return;
    expect(resolution.warning[0]).toContain('openai');
    expect(resolution.warning.join(' ')).toContain('only `local`');
  });

  it('is fatal in enforce mode', async () => {
    await expect(
      resolveEmbeddingProvider({
        request: semanticRequestOf(
          compiled({ loop_detection: { semantic: { provider: 'openai' } } }),
        ),
        mode: 'enforce',
      }),
    ).rejects.toThrow(/no backend for it/);
  });
});

describe('loadInstaller', () => {
  it('hands back the installer the package exports', async () => {
    const installModel = async () => ({ path: '/cache/model', bytes: 1 });

    expect(await loadInstaller(loaderFor({ installModel }))).toBe(installModel);
  });

  it('names the package and the command that installs it', async () => {
    // The common case today is that the package is not installed, so this
    // message is the command's main product. Not a stack trace, and not a
    // silent no-op.
    let caught: CliError | undefined;
    try {
      await loadInstaller(missing);
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toBe(`${EMBEDDINGS_PACKAGE} is not installed`);
    expect(caught?.exitCode).toBe(4);
    expect(caught?.hints.join(' ')).toContain(`npm install ${EMBEDDINGS_PACKAGE}`);
    expect(caught?.hints.join(' ')).toContain('301 MB');
    expect(caught?.hints.join(' ')).not.toContain('ERR_MODULE_NOT_FOUND\n    at ');
  });

  it('survives a loader that rejects with something that is not an Error', async () => {
    // A rejected dynamic import is usually an `Error`, but a broken module's
    // top-level `throw 'x'` is not, and the message must still come out
    // readable rather than as `[object Object]` or a crash in the formatter.
    const rude: EmbeddingsLoader = () => Promise.reject('module blew up');

    await expect(loadInstaller(rude)).rejects.toThrow(/is not installed/);
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({})),
      mode: 'warn',
      load: rude,
    });
    expect(resolution.kind).toBe('degraded');
    if (resolution.kind !== 'degraded') return;
    expect(resolution.warning.join(' ')).toContain('module blew up');
  });

  it('survives a factory that rejects with something that is not an Error', async () => {
    const resolution = await resolveEmbeddingProvider({
      request: semanticRequestOf(compiled({})),
      mode: 'warn',
      load: loaderFor({ createEmbeddingProvider: () => Promise.reject('no model') }),
    });

    expect(resolution.kind).toBe('degraded');
    if (resolution.kind !== 'degraded') return;
    expect(resolution.warning.join(' ')).toContain('no model');
  });

  it('asks for an upgrade when the package is there but too old', async () => {
    let caught: CliError | undefined;
    try {
      await loadInstaller(loaderFor({}));
    } catch (error) {
      caught = error as CliError;
    }

    expect(caught?.message).toContain('does not export installModel');
    expect(caught?.hints.join(' ')).toContain('@latest');
  });
});

describe('the real loader', () => {
  it('goes through the companion package`s real specifier, whatever it resolves to', async () => {
    // Inside this monorepo the specifier *does* resolve: npm workspaces
    // symlinks every package into `node_modules`, so the import finds the real
    // `@agentfuse/embeddings-local` — provided it has been built, which the
    // gate does before it runs the tests. A published `agentfuse` installed on
    // its own finds nothing and rejects instead. Both states are covered by
    // the tables above; what this pins is that the real loader is the only
    // path to the package and that neither state escapes as a crash.
    const outcome = await loadEmbeddingsPackage().then(
      (module) => ({ resolved: true, module }) as const,
      () => ({ resolved: false }) as const,
    );

    if (outcome.resolved) {
      const module = outcome.module as Record<string, unknown>;
      // Phase 4's acceptance criterion, from this side: the companion package
      // exports both halves of the contract this file documents, so neither
      // the "installed but too old" row nor the "not installed" row applies to
      // it any more.
      expect(typeof module.createEmbeddingProvider).toBe('function');
      expect(typeof module.installModel).toBe('function');
      await expect(loadInstaller()).resolves.toBe(module.installModel);

      // Deliberately not calling `createEmbeddingProvider` here: it loads a
      // 23 MB model and the ONNX runtime, and this suite runs offline. The
      // package's own `model.test.ts` covers that, gated on the model being
      // cached.
    } else {
      await expect(loadInstaller()).rejects.toThrow(/is not installed/);
    }
  });
});
