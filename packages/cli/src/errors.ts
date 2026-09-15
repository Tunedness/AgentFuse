/**
 * The one error type the CLI shows a human.
 *
 * Anything thrown as a {@link CliError} is printed as a message and, when it
 * has one, a hint — no stack trace. A stack trace tells the user about
 * AgentFuse's internals when what they need is the name of the key they
 * misspelled or the package they have not installed. Everything else that
 * escapes is a bug in AgentFuse and *does* get its stack, because then the
 * internals are exactly what matters.
 */

/** Exit codes, so the shell can tell the failures apart. */
export const EXIT = {
  ok: 0,
  /** The user asked for something impossible: bad flag, missing file, typo. */
  usage: 2,
  /** A policy file that does not validate. */
  policy: 3,
  /** A configured capability is not installed. */
  missingDependency: 4,
  /** The wrapped server or the run itself failed. */
  runtime: 70,
} as const;

/** A failure with a message written for the person who typed the command. */
export class CliError extends Error {
  readonly exitCode: number;
  /** Extra lines printed under the message. Usually "what to do instead". */
  readonly hints: readonly string[];

  constructor(
    message: string,
    options: { exitCode?: number; hints?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT.usage;
    this.hints = options.hints ?? [];
  }
}

/**
 * The message of a thrown value, whether or not it is an `Error`.
 *
 * One helper rather than a ternary at each of the dozen places that quote an
 * underlying failure in a hint. A module whose top-level `throw 'x'` rejected a
 * dynamic import is not an `Error`, and `String(error)` on an object prints
 * `[object Object]`, so the single-place version is the one worth testing.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Renders a {@link CliError} the way the CLI prints it. */
export function formatCliError(error: CliError): string {
  const lines = [`agentfuse: ${error.message}`];
  for (const hint of error.hints) lines.push(`  ${hint}`);
  return `${lines.join('\n')}\n`;
}
