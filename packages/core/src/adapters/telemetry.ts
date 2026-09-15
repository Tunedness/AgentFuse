import type { FuseEvent } from '../domain/events.js';
import type { TelemetrySink } from '../ports/index.js';

/**
 * The default sink: drops everything.
 *
 * Umbrella ADR-003 requires telemetry to be **off unless opted in**, so the
 * engine's out-of-the-box behaviour must be to emit nowhere. Wiring an OTLP
 * exporter is an explicit act by the operator, not a default.
 */
export class NoopTelemetrySink implements TelemetrySink {
  emit(): void {
    // Intentionally empty.
  }

  async shutdown(): Promise<void> {
    // Nothing buffered, nothing to flush.
  }
}

/** Keeps every event in memory. For tests and for `agentfuse doctor`. */
export class RecordingTelemetrySink implements TelemetrySink {
  readonly events: FuseEvent[] = [];

  emit(event: FuseEvent): void {
    this.events.push(event);
  }

  /** All recorded events of one type, narrowed. */
  ofType<T extends FuseEvent['type']>(type: T): Extract<FuseEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<FuseEvent, { type: T }> => e.type === type);
  }

  async shutdown(): Promise<void> {
    // Nothing to flush.
  }
}
