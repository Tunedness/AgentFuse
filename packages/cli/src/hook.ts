/**
 * `--hook ./hook.mjs` — ADR-004's single programmatic escape hatch.
 *
 * Policies are declarative because security and FinOps teams diff
 * configuration and do not read code. One hook is left open for the cases YAML
 * cannot express: "deny writes outside business hours", "allow this tool only
 * for this trace". It is deliberately the *only* one.
 *
 * ## What a hook may and may not do
 *
 * It receives the decision, a frozen view of the call and a view of the
 * session, and may return `{ action, reasons }`. It may raise the action
 * (`allow` → `deny`) or lower it, and append reasons. It **cannot modify the
 * arguments**: `FuseEngine` reads only those two fields, so an `args` field on
 * the result is ignored by construction. Rewriting an agent's requests is
 * McpGuard's territory; AgentFuse decides whether a call happens, never what it
 * says.
 *
 * A hook that throws is caught by the engine, recorded on the
 * `policy_decision` event as `hookError`, and treated as a no-op. That
 * behaviour lives in core and is not re-implemented here — this file only finds
 * the function and hands it over.
 *
 * ## Loading
 *
 * The module is imported by absolute file URL, so a relative `--hook` resolves
 * against the working directory the user typed it in rather than against
 * AgentFuse's own location. A default export is used if it is a function,
 * otherwise a named `onDecision`; anything else is a startup error naming both
 * spellings, because a hook silently not running is indistinguishable from a
 * policy that allows everything.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DecisionHook } from '@agentfuse/core';
import { CliError, EXIT, messageOf } from './errors.js';

/** The shape a hook module is allowed to have. */
interface HookModule {
  readonly default?: unknown;
  readonly onDecision?: unknown;
}

/** Imports a module by URL. Injected so the loader is testable. */
export type ModuleLoader = (url: string) => Promise<unknown>;

const importModule: ModuleLoader = (url) => import(url);

/**
 * Loads an `onDecision` hook from a file.
 *
 * @param specifier the `--hook` value, absolute or relative to `cwd`.
 * @throws {CliError} when the file is missing, will not load, or exports no
 * usable function.
 */
export async function loadDecisionHook(
  specifier: string,
  cwd: string,
  load: ModuleLoader = importModule,
): Promise<DecisionHook> {
  const path = isAbsolute(specifier) ? specifier : resolve(cwd, specifier);
  if (!existsSync(path)) {
    throw new CliError(`the hook file --hook names does not exist: ${path}`, {
      hints: ['The path is resolved against the working directory.'],
    });
  }

  let module: unknown;
  try {
    module = await load(pathToFileURL(path).href);
  } catch (error) {
    throw new CliError(`the hook ${path} could not be loaded`, {
      exitCode: EXIT.usage,
      hints: [
        messageOf(error),
        'A hook is an ES module: use `export default (ctx) => …` and a `.mjs` extension, or `"type": "module"` in the nearest package.json.',
      ],
      cause: error,
    });
  }

  const candidate = module as HookModule;
  const hook =
    typeof candidate.default === 'function'
      ? candidate.default
      : typeof candidate.onDecision === 'function'
        ? candidate.onDecision
        : undefined;

  if (hook === undefined) {
    throw new CliError(`the hook ${path} exports no function`, {
      exitCode: EXIT.usage,
      hints: [
        'Export it as the default (`export default (ctx) => …`) or as `onDecision`.',
        'A hook receives { decision, call, session } and may return { action, reasons }. It cannot change the call arguments.',
      ],
    });
  }

  return hook as DecisionHook;
}
