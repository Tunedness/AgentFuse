/**
 * The one `Diagnostics`, with a second reader attached.
 *
 * Phase 6b wrote down why there is exactly one `Diagnostics` in a wrap: two
 * instances mean two rate-limit windows, so the startup warnings would be
 * counted apart from the trips and a burst could silence the wrong one. Phase 8
 * needs a second *consumer* of the same stream — the approval pair phase 7
 * named (`approval_pending` → `approval_resolved`) is the only way to measure
 * how long a human took, and it lives on the diagnostics rather than in a
 * `FuseEvent`.
 *
 * So this subclasses rather than duplicating. The rate limiter, the prefix, the
 * `--quiet` switch and `block()` are the proxy's, untouched; the only addition
 * is that every `emit` is shown to an observer first.
 *
 * **Before, not after, and outside the quiet check on purpose.** `--quiet`
 * silences AgentFuse's own chatter in a terminal the operator is using to read
 * their server's output. It is not an instruction to stop recording what the
 * breaker did: a run that exports nothing because somebody wanted a quiet
 * terminal would lose exactly the audit trail the collector was configured for.
 *
 * The observer is wrapped in a `try`. A telemetry consumer that threw while
 * describing an approval would otherwise take down a proxy on behalf of a
 * feature that is off by default.
 */

import { Diagnostics, type DiagnosticsOptions } from '@agentfuse/proxy';

/** A second reader of the diagnostic stream. Must not throw; contained if it does. */
export type DiagnosticObserver = (event: string, fields: Record<string, unknown>) => void;

/** A {@link Diagnostics} that also shows every event to an observer. */
export class ObservedDiagnostics extends Diagnostics {
  readonly #observe: DiagnosticObserver;

  constructor(options: DiagnosticsOptions, observe: DiagnosticObserver) {
    super(options);
    this.#observe = observe;
  }

  override emit(event: string, fields: Record<string, unknown> = {}): void {
    try {
      this.#observe(event, fields);
    } catch {
      // Contained deliberately: see the module doc. There is nowhere useful to
      // report this — the reporting channel is the thing that just threw.
    }
    super.emit(event, fields);
  }
}
