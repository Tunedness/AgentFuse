/**
 * Every byte the CLI writes goes through here.
 *
 * ## Why this exists rather than `console.log`
 *
 * In `wrap` mode **this process's stdout is the agent's JSON-RPC stream.** One
 * `console.log` anywhere in the CLI corrupts every frame after it, and the
 * client on the other end reports a parse error from a server that was working
 * a moment ago. The wrapped server gets blamed for AgentFuse's bug.
 *
 * Making the streams a parameter rather than an ambient global has three
 * consequences, and all three are the point:
 *
 * 1. `wrap` and `serve` build a context whose {@link CliContext.stdout} is the
 *    protocol stream and never write a diagnostic to it — they use
 *    {@link CliContext.stderr} and the proxy's `Diagnostics`.
 * 2. `discipline.test.ts` can assert that **no** file under `src/` mentions
 *    `console.` or `process.stdout`, with `main.ts` as the single exception,
 *    because there is no legitimate second way to write output.
 * 3. Every command is testable by capturing strings instead of intercepting a
 *    global.
 */

import { DIAGNOSTIC_PREFIX } from '@agentfuse/proxy';

/** The minimum of a writable stream the CLI needs. */
export interface Writer {
  write(chunk: string): unknown;
}

/** Everything a command is allowed to know about the outside world. */
export interface CliContext {
  /** Arguments after the executable and script, i.e. `process.argv.slice(2)`. */
  readonly argv: readonly string[];
  /** Command output. **In wrap mode this is the JSON-RPC stream.** */
  readonly stdout: Writer;
  /** Diagnostics, warnings and errors. Always safe to write to. */
  readonly stderr: Writer;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/** Collects what was written, for tests. */
export class StringWriter implements Writer {
  #chunks: string[] = [];

  write(chunk: string): boolean {
    this.#chunks.push(chunk);
    return true;
  }

  /** Everything written so far, concatenated. */
  get text(): string {
    return this.#chunks.join('');
  }

  /** Non-empty lines written so far. */
  get lines(): string[] {
    return this.text.split('\n').filter((line) => line !== '');
  }

  clear(): void {
    this.#chunks = [];
  }
}

/** Writes a line, adding the newline the caller should not have to remember. */
export function writeLine(writer: Writer, text = ''): void {
  writer.write(`${text}\n`);
}

/** Writes several lines at once. */
export function writeLines(writer: Writer, lines: readonly string[]): void {
  if (lines.length === 0) return;
  writer.write(`${lines.join('\n')}\n`);
}

/**
 * A multi-line warning for a person, on stderr, prefixed.
 *
 * The proxy's `Diagnostics` covers the two shapes it needs — a JSON event line
 * and a verbatim rendered report — and neither fits "three sentences explaining
 * that the thing you configured is not installed". This writes those sentences
 * with the same prefix, so a reader scanning a terminal can still tell
 * AgentFuse's lines from the wrapped server's, which is the rule that prefix
 * exists to serve. Never stdout, and silent under `--quiet`.
 */
export function writeNotice(
  writer: Writer,
  level: 'warning' | 'note',
  lines: readonly string[],
): void {
  const [headline, ...rest] = lines;
  if (headline === undefined) return;
  const out = [`${DIAGNOSTIC_PREFIX} ${level}: ${headline}`];
  for (const line of rest) out.push(`${DIAGNOSTIC_PREFIX}   ${line}`);
  writer.write(`${out.join('\n')}\n`);
}
