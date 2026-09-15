/**
 * Whether telemetry is on, and what to build when it is.
 *
 * The decision table, which is `embeddings.ts`'s sibling and deliberately
 * diverges from it in one row:
 *
 * | configuration | outcome |
 * | --- | --- |
 * | `telemetry.enabled: false` | **nothing is built, silently.** No queue, no timer, no socket, no line on stderr. |
 * | enabled, endpoint parses | the exporter and the sink, and one `telemetry_enabled` diagnostic naming the endpoint. |
 * | enabled, endpoint does not parse | **a warning, and the run continues without telemetry.** |
 *
 * That last row is where this parts company with the embedding table, on
 * purpose. There, `provider: local` under `mode: enforce` with the package
 * missing is a hard exit, because the operator asked AgentFuse to break
 * circuits using a detector that is not present and a subset of the requested
 * protection is not close enough. Telemetry decides nothing. A typo in
 * `otlp_endpoint` that killed a wrap would take the user's MCP server down and
 * leave their agent with no fuse in front of it at all — strictly worse than
 * running with the breaker on and the collector unfed. So it warns loudly and
 * carries on, which is the same judgement phase 7 made for an approval channel
 * that cannot be opened.
 *
 * The default being off is umbrella ADR-003's, and the silence in row one is
 * deliberate too: a line on every run about a feature nobody switched on is
 * noise in a stream the operator is reading for their own server's output.
 */

import type { FusePolicy } from '@agentfuse/core';
import { CLI_VERSION } from '../index.js';
import {
  type ExporterDiagnostic,
  type FetchLike,
  OtlpExporter,
  type OtlpExporterOptions,
} from './exporter.js';
import { attributes, type OtlpResource, type OtlpScope, str } from './otlp.js';
import { OtlpTelemetrySink } from './sink.js';
import type { RandomBytes } from './trace.js';

/** The instrumentation scope every payload carries. */
export const SCOPE: OtlpScope = { name: 'agentfuse', version: CLI_VERSION };

/** What {@link resolveTelemetry} is given. */
export interface ResolveTelemetryOptions {
  /** The policy in force, after any `--mode` override. */
  readonly policy: FusePolicy;
  /** The host's single `Diagnostics`, for the export failure line. */
  readonly onDiagnostic: ExporterDiagnostic;
  /** Injected for tests. Production uses Node 20's global `fetch`. */
  readonly fetch?: FetchLike | undefined;
  /** Injected for tests. */
  readonly now?: (() => number) | undefined;
  /** Injected for tests. */
  readonly random?: RandomBytes | undefined;
  /** Injected for tests: batching, timeouts and backoff. */
  readonly tuning?: Omit<OtlpExporterOptions, 'endpoint' | 'fetch' | 'now' | 'onDiagnostic'>;
}

/** The outcome of applying the table in the module doc. */
export type TelemetryResolution =
  | {
      readonly kind: 'off';
      /** Why nothing was built. Not a warning: this is the default. */
      readonly reason: string;
    }
  | {
      readonly kind: 'ready';
      readonly sink: OtlpTelemetrySink;
      /** The base endpoint, as configured. */
      readonly endpoint: string;
    }
  | {
      readonly kind: 'degraded';
      /** Printed on stderr. The run continues without telemetry. */
      readonly warning: readonly string[];
    };

/**
 * The resource every export carries.
 *
 * `service.name` and `service.version` are the two well-known keys kept
 * outside the `tunedness.*` namespace, because collectors route and group on
 * them and renaming them would make AgentFuse's data land nowhere. Everything
 * describing *AgentFuse* rather than the process is namespaced.
 */
export function resourceFor(policy: FusePolicy): OtlpResource {
  return {
    attributes: attributes({
      'service.name': str(policy.telemetry.service_name),
      'service.version': str(CLI_VERSION),
      'telemetry.sdk.name': str('agentfuse'),
      'telemetry.sdk.language': str('nodejs'),
      'tunedness.tool': str('agentfuse'),
      'tunedness.policy.mode': str(policy.mode),
    }),
  };
}

/**
 * Whether an endpoint is one `fetch` could ever reach.
 *
 * Checked here rather than discovered on the first export, so the operator
 * hears about their typo at startup instead of never — a failed export is one
 * rate-limited line among many.
 */
export function endpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'it is not a URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `its scheme is ${url.protocol.replace(':', '')}, and OTLP/HTTP needs http or https`;
  }
  return undefined;
}

/** Applies the decision table. Never throws. */
export function resolveTelemetry(options: ResolveTelemetryOptions): TelemetryResolution {
  const { policy } = options;
  if (!policy.telemetry.enabled) {
    return {
      kind: 'off',
      reason: 'telemetry.enabled is false, which is the default (umbrella ADR-003)',
    };
  }

  const endpoint = policy.telemetry.otlp_endpoint;
  const problem = endpointProblem(endpoint);
  if (problem !== undefined) {
    return {
      kind: 'degraded',
      warning: [
        `telemetry.enabled is true but telemetry.otlp_endpoint (${endpoint}) cannot be used: ${problem}.`,
        'Nothing will be exported. Decisions are still on stderr and in the trip reports.',
        'An OTLP/HTTP collector endpoint looks like http://localhost:4318; the /v1/traces and /v1/logs paths are appended for you.',
      ],
    };
  }

  const exporter = new OtlpExporter(resourceFor(policy), SCOPE, {
    ...options.tuning,
    endpoint,
    onDiagnostic: options.onDiagnostic,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
    ...(options.now !== undefined ? { now: options.now } : undefined),
  });

  return {
    kind: 'ready',
    endpoint,
    sink: new OtlpTelemetrySink({
      exporter,
      ...(options.now !== undefined ? { now: options.now } : undefined),
      ...(options.random !== undefined ? { random: options.random } : undefined),
    }),
  };
}
