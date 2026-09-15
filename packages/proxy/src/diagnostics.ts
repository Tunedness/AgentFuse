/**
 * AgentFuse's own diagnostic output.
 *
 * Two rules, both load-bearing in stdio wrap mode:
 *
 * 1. **Never stdout.** In wrap mode the proxy's stdout *is* the JSON-RPC stream
 *    the agent is reading. One stray `console.log` and the client sees a parse
 *    error from a server that was working fine a moment ago. Every diagnostic
 *    goes through this class, which can only write to the stream it was given —
 *    `process.stderr` by default — and `stdout-discipline.test.ts` fails the
 *    build if any source file in this package reaches for stdout or `console`.
 * 2. **Prefixed and rate-limited.** The wrapped server's own stderr is
 *    forwarded byte-for-byte, so AgentFuse's lines have to be distinguishable
 *    from it, and a breaker that trips on every call in a tight loop must not
 *    bury the server's output under its own.
 *
 * Like the rest of the transport skeleton this file does not import
 * `@agentfuse/core`.
 */

/** The minimum of a writable stream the diagnostics need. */
export interface DiagnosticSink {
  write(chunk: string): unknown;
}

/** How a {@link Diagnostics} behaves. */
export interface DiagnosticsOptions {
  /** Silences everything. What `--quiet` sets. */
  quiet?: boolean;
  /** Where the lines go. Defaults to `process.stderr`. */
  sink?: DiagnosticSink;
  /** Lines allowed per window before suppression kicks in. Default 20. */
  maxPerWindow?: number;
  /** Length of the rate-limit window in milliseconds. Default 1000. */
  windowMs?: number;
  /** Injectable clock, so the rate limiter is testable without real time. */
  now?: () => number;
}

/** The prefix every AgentFuse diagnostic line carries. */
export const DIAGNOSTIC_PREFIX = '[agentfuse]';

/**
 * A rate-limited, prefixed, stderr-only structured logger.
 *
 * The payload is JSON so the lines are greppable and machine-readable, and the
 * prefix is plain text so a human scanning a terminal can tell at a glance
 * which lines are AgentFuse's and which are the wrapped server's.
 */
export class Diagnostics {
  readonly #quiet: boolean;
  readonly #sink: DiagnosticSink;
  readonly #maxPerWindow: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #windowStart: number;
  #emitted = 0;
  #suppressed = 0;

  constructor(options: DiagnosticsOptions = {}) {
    this.#quiet = options.quiet ?? false;
    this.#sink = options.sink ?? process.stderr;
    this.#maxPerWindow = options.maxPerWindow ?? 20;
    this.#windowMs = options.windowMs ?? 1_000;
    this.#now = options.now ?? Date.now;
    this.#windowStart = this.#now();
  }

  /** Whether anything at all will be written. */
  get enabled(): boolean {
    return !this.#quiet;
  }

  /** Writes one structured line, unless quiet or rate-limited. */
  emit(event: string, fields: Record<string, unknown> = {}): void {
    if (this.#quiet) return;
    const now = this.#now();
    if (now - this.#windowStart >= this.#windowMs) {
      const dropped = this.#suppressed;
      this.#windowStart = now;
      this.#emitted = 0;
      this.#suppressed = 0;
      // Reported rather than forgotten: silently dropping diagnostics during
      // the exact burst somebody is investigating is how a log lies.
      if (dropped > 0) {
        this.#emitted += 1;
        this.#write('diagnostics_suppressed', { dropped });
      }
    }
    if (this.#emitted >= this.#maxPerWindow) {
      this.#suppressed += 1;
      return;
    }
    this.#emitted += 1;
    this.#write(event, fields);
  }

  /**
   * Writes a pre-rendered multi-line block verbatim, unless quiet.
   *
   * The trip report core renders is a box-drawn table; prefixing every line
   * would mangle it, and reflowing it into JSON would throw away the layout
   * somebody is reading during an incident. It is bracketed by a prefixed
   * marker line instead, and it is not rate-limited: a report is emitted once
   * per *fresh* trip, and suppressing the one thing the operator came to look
   * at would be the wrong saving.
   */
  block(text: string): void {
    if (this.#quiet) return;
    this.#write('trip_report', { lines: text.split('\n').length });
    this.#sink.write(`${text}\n`);
  }

  #write(event: string, fields: Record<string, unknown>): void {
    let payload: string;
    try {
      payload = JSON.stringify({ event, ...fields });
    } catch {
      // A diagnostic that throws while describing a problem is worse than no
      // diagnostic. Cycles and BigInts are the usual culprits.
      payload = JSON.stringify({ event, unserializable: true });
    }
    this.#sink.write(`${DIAGNOSTIC_PREFIX} ${payload}\n`);
  }
}
