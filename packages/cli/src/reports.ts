/**
 * Trip reports on disk. The CLI's half of a seam the proxy deliberately left.
 *
 * `@agentfuse/proxy` does **no file I/O**: `ToolCallGuardOptions.writeReport`
 * takes a decision and returns a path, and the path the agent is shown in the
 * refusal text is whatever comes back. That is this file. `@agentfuse/core`
 * builds the report object and renders the human view; nothing is re-rendered
 * here, because one renderer is what keeps the CLI, the Control Plane and the
 * snapshots agreeing on a single piece of text.
 *
 * ## The one hard rule
 *
 * **Writing a report must never fail a tool call.** `writeReport` is called
 * from inside the guarded path, at the moment a call is being refused. A full
 * disk, a read-only mount or a directory somebody deleted turns a clean refusal
 * — the thing the agent can read and act on — into a JSON-RPC error, which is
 * the exact failure `trip-result.ts` exists to prevent. So every path here
 * swallows its error, reports it out of band, and returns `undefined`; the
 * refusal then references the trip id instead of a file, which is worse but
 * still works.
 *
 * ## The filename
 *
 * `<trippedAt, filesystem-safe>__<tripId>.json`, which sorts
 * chronologically under a plain lexicographic sort — so `report last` is the
 * last name in the directory, with no need to open a single file to find out
 * which one is newest. `:` and `.` are replaced because Windows refuses them in
 * filenames, and a tool that writes reports nobody on Windows can open is not
 * writing reports.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Decision, TripReport } from '@agentfuse/core';
import { CliError, EXIT, messageOf } from './errors.js';

/** Suffix every report file carries. */
export const REPORT_SUFFIX = '.json';

/** One report on disk, as the listing sees it. */
export interface ReportEntry {
  /** Absolute path. */
  readonly path: string;
  readonly file: string;
  readonly tripId: string;
  /**
   * The timestamp component of the filename.
   *
   * Read from the name rather than by opening the file, so listing a thousand
   * trips costs no parses. **Not ISO-8601**: `:` and `.` were replaced to keep
   * the name portable, so this sorts correctly and is not a date to parse. The
   * real `trippedAt` is inside the report, and anything that displays a time
   * reads it from there.
   */
  readonly stamp: string;
}

/** A timestamp turned into something every filesystem accepts. */
function fileTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

/** Pulls the trip id back out of a filename written by {@link FileReportStore}. */
function tripIdOf(file: string): string {
  const stem = basename(file, REPORT_SUFFIX);
  const separator = stem.indexOf('__');
  return separator === -1 ? stem : stem.slice(separator + 2);
}

/** The timestamp half of such a filename. See {@link ReportEntry.stamp}. */
function stampOf(file: string): string {
  const stem = basename(file, REPORT_SUFFIX);
  const separator = stem.indexOf('__');
  return separator === -1 ? '' : stem.slice(0, separator);
}

/** How a {@link FileReportStore} behaves. */
export interface FileReportStoreOptions {
  /** Directory reports go in. Created on first write. */
  readonly dir: string;
  /**
   * Out-of-band error reporting, for the failures that must not throw.
   *
   * Takes the thrown value rather than an `Error`, so nothing has to
   * manufacture one to satisfy a signature; the caller turns it into a line
   * with {@link messageOf}.
   */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** Reads and writes the `report.dir` directory. */
export class FileReportStore {
  readonly dir: string;
  readonly #onError: ((error: unknown) => void) | undefined;
  #written = 0;
  #failed = 0;

  constructor(options: FileReportStoreOptions) {
    this.dir = resolve(options.dir);
    this.#onError = options.onError;
  }

  /** Reports successfully written by this store. */
  get written(): number {
    return this.#written;
  }

  /** Writes that failed and were swallowed. */
  get failed(): number {
    return this.#failed;
  }

  /**
   * Persists a report.
   *
   * @returns the absolute path, or `undefined` when the write failed. Never
   * throws — see the module doc.
   */
  write(report: TripReport): string | undefined {
    const path = join(this.dir, `${fileTimestamp(report.trippedAt)}__${report.tripId}.json`);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      this.#written += 1;
      return path;
    } catch (error) {
      this.#failed += 1;
      this.#onError?.(error);
      return undefined;
    }
  }

  /**
   * The `writeReport` hook `createToolCallGuard` takes.
   *
   * A decision without a report is a block the engine did not build a report
   * for — an `onDecision` hook that raised the action, most often — and there
   * is nothing to write.
   */
  get hook(): (decision: Decision) => string | undefined {
    return (decision) => (decision.report === undefined ? undefined : this.write(decision.report));
  }

  /** Every report in the directory, newest first. Empty when there is none. */
  list(): ReportEntry[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      // A directory that does not exist holds no reports, which is a fact and
      // not an error: nothing has tripped yet.
      return [];
    }
    return (
      files
        .filter((file) => file.endsWith(REPORT_SUFFIX))
        // The name starts with the timestamp, so a plain lexicographic sort is
        // chronological and `last()` is the first entry of the reverse.
        .sort()
        .reverse()
        .map((file) => ({
          path: join(this.dir, file),
          file,
          tripId: tripIdOf(file),
          stamp: stampOf(file),
        }))
    );
  }

  /** The most recent report, or `undefined`. */
  last(): ReportEntry | undefined {
    return this.list()[0];
  }

  /**
   * Finds a report by trip id, filename or path.
   *
   * A relative path is resolved against the store's own directory, not the
   * process's working directory: everything else in the CLI takes its cwd from
   * the injected context, and one function reading the ambient one is how a
   * command starts behaving differently under a test than under a shell.
   *
   * @throws {CliError} when nothing matches.
   */
  find(reference: string): ReportEntry {
    const entries = this.list();
    const asPath = resolve(this.dir, reference);
    const match = entries.find(
      (entry) => entry.tripId === reference || entry.file === reference || entry.path === asPath,
    );
    if (match !== undefined) return match;
    throw new CliError(`no report matches ${reference}`, {
      exitCode: EXIT.usage,
      hints: [
        `Looked in ${this.dir}.`,
        entries.length === 0
          ? 'That directory holds no reports yet — nothing has tripped the breaker.'
          : 'Run `agentfuse report list` to see what is there.',
      ],
    });
  }

  /**
   * Reads one report.
   *
   * @throws {CliError} when the file is missing or is not a trip report.
   */
  read(path: string): TripReport {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      throw new CliError(`cannot read the report ${path}`, {
        exitCode: EXIT.usage,
        hints: [messageOf(error)],
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CliError(`${path} is not valid JSON`, {
        exitCode: EXIT.usage,
        hints: [messageOf(error)],
      });
    }

    if (!isTripReport(parsed)) {
      throw new CliError(`${path} is not an AgentFuse trip report`, {
        exitCode: EXIT.usage,
        hints: ['A trip report has `"kind": "trip"` and `"reportVersion": 1`.'],
      });
    }
    return parsed;
  }
}

/**
 * Whether a parsed value is a trip report this build understands.
 *
 * Checked rather than cast: the directory is on the user's disk and may hold a
 * report from a newer AgentFuse, and rendering one of those with this version's
 * renderer would produce confident nonsense.
 */
export function isTripReport(value: unknown): value is TripReport {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<TripReport>;
  return (
    candidate.kind === 'trip' &&
    candidate.reportVersion === 1 &&
    typeof candidate.tripId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.trippedAt === 'string'
  );
}
