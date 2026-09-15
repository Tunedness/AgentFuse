/**
 * `agentfuse models install` — fetch the embedding model.
 *
 * This command does almost nothing itself, and that is the design. The download
 * lives in `@agentfuse/embeddings-local` along with the ONNX runtime it needs,
 * because ADR-003 measured what putting it here would cost: `onnxruntime-node`
 * unpacks to roughly 301 MB, in one tarball carrying every platform's binaries.
 * A `npx agentfuse` that dragged that in would not be a drop-in, and the CLI
 * therefore reaches the package through a dynamic `import()` and declares it
 * nowhere.
 *
 * Which means the common case, today, is that the package is not installed. The
 * requirement for this command is therefore about its **failure**: it must name
 * the package and the command that installs it, not surface an
 * `ERR_MODULE_NOT_FOUND` stack, and not quietly succeed at nothing. See
 * `loadInstaller` in `embeddings.ts` for the message and for the version-skew
 * case that looks the same from here but needs different advice.
 */

import { parseArgs } from '../args.js';
import { findPolicyFile, readPolicyFile } from '../config.js';
import {
  EMBEDDINGS_PACKAGE,
  type EmbeddingsLoader,
  type InstallProgress,
  loadInstaller,
} from '../embeddings.js';
import { CliError, EXIT, messageOf } from '../errors.js';
import { type CliContext, writeLines } from '../io.js';

/** Flags `models` accepts. */
export const MODELS_FLAGS = {
  booleans: ['help'],
  values: ['policy', 'model'],
  aliases: { '-p': '--policy', '-h': '--help' },
} as const;

/** The model used when neither a flag nor a policy names one. */
export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** `agentfuse models --help`. */
export function modelsHelp(): string[] {
  return [
    'Usage: agentfuse models install [--model <id>] [--policy <path>]',
    '',
    'Downloads the local embedding model the semantic loop detector uses.',
    '',
    '  --model <id>     Which model. Defaults to the policy’s',
    `                   loop_detection.semantic.model, or ${DEFAULT_MODEL}.`,
    '  --policy <path>  The policy to read that from.',
    '',
    `Requires ${EMBEDDINGS_PACKAGE}, which AgentFuse deliberately does not`,
    'depend on — it carries ~301 MB of ONNX runtime binaries. Install it first:',
    '',
    `  npm install ${EMBEDDINGS_PACKAGE}`,
    '',
    'The deterministic loop rules — exact repeats, error repeats, short cycles —',
    'need none of this and work on a plain install.',
  ];
}

/** The model the policy asks for, when a policy can be found at all. */
function modelFromPolicy(context: CliContext, flag: string | undefined): string | undefined {
  // A missing or broken policy is not a reason to refuse a download: the user
  // may be installing the model *before* writing their policy, which is the
  // order the `init` output suggests.
  try {
    const location = findPolicyFile({
      ...(flag !== undefined ? { flag } : undefined),
      env: context.env,
      cwd: context.cwd,
    });
    if (location === undefined) return undefined;
    return readPolicyFile(location).policy.loop_detection.semantic.model;
  } catch {
    return undefined;
  }
}

/** Runs `agentfuse models …`. */
export async function runModels(
  context: CliContext,
  argv: readonly string[],
  load?: EmbeddingsLoader,
): Promise<number> {
  const args = parseArgs(argv, MODELS_FLAGS);
  const subcommand = args.positionals[0];

  if (args.bool('help') || subcommand === undefined) {
    writeLines(context.stdout, modelsHelp());
    return args.bool('help') ? EXIT.ok : EXIT.usage;
  }

  if (subcommand !== 'install') {
    throw new CliError(`unknown models subcommand: ${subcommand}`, {
      hints: ['The only one is `agentfuse models install`.'],
    });
  }

  const model =
    args.value('model') ?? modelFromPolicy(context, args.value('policy')) ?? DEFAULT_MODEL;
  const install = await loadInstaller(load);

  writeLines(context.stdout, [`Installing ${model} via ${EMBEDDINGS_PACKAGE}…`]);
  const onProgress = (progress: InstallProgress): void => {
    const size =
      progress.received !== undefined && progress.total !== undefined
        ? ` (${Math.round((progress.received / Math.max(1, progress.total)) * 100)}%)`
        : '';
    writeLines(context.stdout, [`  ${progress.message}${size}`]);
  };

  let result: { path: string; bytes: number };
  try {
    result = await install({ model, onProgress });
  } catch (error) {
    throw new CliError(`installing ${model} failed`, {
      exitCode: EXIT.runtime,
      hints: [
        messageOf(error),
        'AGENTFUSE_OFFLINE=1 disables downloads entirely; unset it to allow this one.',
      ],
      cause: error,
    });
  }

  writeLines(context.stdout, [
    '',
    `Installed ${model}`,
    `  ${result.path}  (${(result.bytes / 1_000_000).toFixed(1)} MB)`,
    '',
    'Semantic loop detection is now available. Leave',
    'loop_detection.semantic.provider: local in your policy and it will be used.',
  ]);
  return EXIT.ok;
}
