import type { FusePolicy } from '@agentfuse/core';
import { parsePolicy } from '@agentfuse/core';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../index.js';
import { endpointProblem, resolveTelemetry, resourceFor, SCOPE } from './index.js';
import type { KeyValue } from './otlp.js';

/**
 * The decision table, row by row.
 *
 * Its sibling is `embeddings.ts`, and the one row where they differ — an
 * unusable configuration warns here rather than exiting — is the row with the
 * judgement in it, so it gets its own test.
 */

function policy(telemetry: Record<string, unknown> = {}): FusePolicy {
  return parsePolicy({ version: 1, telemetry });
}

/** The resource attributes as a plain object. */
function resourceAttributes(current: FusePolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of resourceFor(current).attributes as KeyValue[]) {
    out[entry.key] = Object.values(entry.value)[0];
  }
  return out;
}

const noop = (): void => undefined;

describe('endpointProblem', () => {
  it('accepts what OTLP/HTTP can be spoken over', () => {
    expect(endpointProblem('http://localhost:4318')).toBeUndefined();
    expect(endpointProblem('https://otlp.example.com/otlp')).toBeUndefined();
  });

  it('names the problem with a scheme fetch cannot use', () => {
    // The gRPC exporter is a different protocol, not a different URL, and
    // somebody who pastes their collector's gRPC endpoint deserves to be told.
    expect(endpointProblem('grpc://localhost:4317')).toContain('its scheme is grpc');
  });

  it('names a value that is not a URL at all', () => {
    // `localhost:4318` is not one of these: `new URL` reads it as the scheme
    // `localhost`, which the check above catches for a different reason.
    expect(endpointProblem('not a url')).toBe('it is not a URL');
    expect(endpointProblem('')).toBe('it is not a URL');
  });
});

describe('resolveTelemetry', () => {
  it('is off by default, and says why without warning about it', () => {
    const resolution = resolveTelemetry({ policy: policy(), onDiagnostic: noop });

    expect(resolution.kind).toBe('off');
    expect(resolution).toMatchObject({ reason: expect.stringContaining('ADR-003') });
  });

  it('builds the sink when it is asked for', () => {
    const resolution = resolveTelemetry({
      policy: policy({ enabled: true, otlp_endpoint: 'http://127.0.0.1:4318' }),
      onDiagnostic: noop,
    });

    expect(resolution).toMatchObject({ kind: 'ready', endpoint: 'http://127.0.0.1:4318' });
  });

  it('takes the injected seams when a test supplies them', async () => {
    const posted: string[] = [];
    const resolution = resolveTelemetry({
      policy: policy({ enabled: true, otlp_endpoint: 'http://127.0.0.1:4318' }),
      onDiagnostic: noop,
      fetch: async (url) => {
        posted.push(url);
        return new Response('{}', { status: 200 });
      },
      now: () => 1_700_000_000_000,
      random: (size) => new Uint8Array(size).fill(7),
      tuning: { flushIntervalMs: 1 },
    });
    if (resolution.kind !== 'ready') throw new Error('expected a sink');

    resolution.sink.emit({
      type: 'budget_event',
      timestamp: 1_700_000_000_000,
      sessionId: 'S1',
      dimension: 'calls',
      ratio: 0.5,
      value: 5,
      limit: 10,
      action: 'warn',
    });
    await resolution.sink.shutdown();

    expect(posted).toEqual(['http://127.0.0.1:4318/v1/logs']);
  });

  it('warns and stays out of the way when the endpoint cannot be used', () => {
    const resolution = resolveTelemetry({
      policy: policy({ enabled: true, otlp_endpoint: 'grpc://localhost:4317' }),
      onDiagnostic: noop,
    });

    expect(resolution.kind).toBe('degraded');
    // Not a `CliError`: unlike the embedding backend, telemetry decides
    // nothing, so refusing to start would cost the user their fuse to protect
    // them from a missing chart.
    expect(resolution).toMatchObject({
      warning: expect.arrayContaining([expect.stringContaining('Nothing will be exported')]),
    });
  });
});

describe('the resource', () => {
  it('names the service the way a collector expects, and AgentFuse the way ADR-003 does', () => {
    const current = policy({ enabled: true, service_name: 'fuse-prod' });

    expect(resourceAttributes(current)).toEqual({
      // The two well-known keys, kept outside the namespace because backends
      // route on them.
      'service.name': 'fuse-prod',
      'service.version': CLI_VERSION,
      'telemetry.sdk.name': 'agentfuse',
      'telemetry.sdk.language': 'nodejs',
      'tunedness.tool': 'agentfuse',
      'tunedness.policy.mode': 'warn',
    });
  });

  it('carries the mode in force, so warn and enforce runs are distinguishable', () => {
    expect(resourceAttributes(parsePolicy({ version: 1, mode: 'enforce' }))).toMatchObject({
      'tunedness.policy.mode': 'enforce',
    });
  });

  it('identifies the scope as this CLI', () => {
    expect(SCOPE).toEqual({ name: 'agentfuse', version: CLI_VERSION });
  });
});
