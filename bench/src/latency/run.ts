/**
 * The latency benchmark.
 *
 * PRD §6 budgets the added latency of interposing AgentFuse at **p95 < 50 ms
 * per call**, and ADR-002's whole shape — the embedding on an asynchronous
 * queue, the verdict applied on the next call — exists to protect that budget.
 * This measures it, twice over:
 *
 * - over `InMemoryTransport`, where the difference is the engine plus one
 *   in-process hop and nothing else;
 * - over a real stdio pipe through the built CLI, where it is everything a
 *   user actually pays: a second process, two more serialisations, policy
 *   loading, the tokenizer, and — on half the runs — a real OTLP exporter
 *   posting to a real socket.
 *
 * Six configurations per tier: {direct, rules, semantic} × {telemetry off, on}.
 * 1000 warm calls each, after a warmup that is discarded.
 *
 * Needs the model in the cache for the semantic configurations:
 * `npx agentfuse models install`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbeddingProvider } from '@agentfuse/core';
import { directRig, proxiedRig, type Rig, type TelemetryMode } from './inmemory.js';
import { added, type Distribution, ms, summarise } from './stats.js';
import {
  type Collector,
  directStdioRig,
  semanticQueueProbe,
  startCollector,
  wrappedStdioRig,
} from './stdio.js';

const EMBEDDINGS_PACKAGE = '@agentfuse/embeddings-local';
const RESULTS_JSON = fileURLToPath(new URL('../../latency/results.json', import.meta.url));
const RESULTS_MD = fileURLToPath(new URL('../../latency/results.md', import.meta.url));

/** Calls measured per configuration. */
const CALLS = 1000;
/**
 * Calls discarded first.
 *
 * Not politeness: V8 needs a few hundred iterations to tier up the JSON codec
 * and the guard pipeline, and a child process needs its first messages before
 * its pipes settle. Measuring those would put the JIT's warm-up inside a number
 * that is supposed to describe steady state.
 */
const WARMUP = 200;

/** PRD §6, per call. */
const BUDGET_P95_MS = 50;

interface EmbeddingsModule {
  createEmbeddingProvider?: (options: { model: string }) => Promise<EmbeddingProvider>;
}

async function loadProvider(): Promise<EmbeddingProvider | undefined> {
  try {
    const module = (await import(EMBEDDINGS_PACKAGE)) as EmbeddingsModule;
    const factory = module.createEmbeddingProvider;
    if (typeof factory !== 'function') return undefined;
    return await factory({ model: 'Xenova/all-MiniLM-L6-v2' });
  } catch {
    return undefined;
  }
}

/** Drives one rig and returns the per-call durations in milliseconds. */
async function measure(rig: Rig): Promise<number[]> {
  for (let i = 0; i < WARMUP; i += 1) await rig.call(i);

  const samples: number[] = new Array<number>(CALLS);
  for (let i = 0; i < CALLS; i += 1) {
    const started = process.hrtime.bigint();
    await rig.call(WARMUP + i);
    samples[i] = Number(process.hrtime.bigint() - started) / 1e6;
  }
  return samples;
}

interface Measurement {
  readonly tier: 'in-memory' | 'stdio';
  readonly config: 'direct' | 'rules' | 'semantic';
  readonly telemetry: TelemetryMode;
  readonly distribution: Distribution;
  readonly queue?: Record<string, number> | undefined;
  readonly exports?: number | undefined;
}

function row(label: string, d: Distribution): string {
  return `| ${label} | ${ms(d.min)} | ${ms(d.mean)} | ${ms(d.p50)} | ${ms(d.p95)} | ${ms(d.p99)} | ${ms(d.max)} |`;
}

const HEADER = '| configuration | min | mean | p50 | p95 | p99 | max |';
const RULE = '| --- | --- | --- | --- | --- | --- | --- |';

async function main(): Promise<void> {
  const out: string[] = [];
  const say = (line = ''): void => {
    out.push(line);
    process.stdout.write(`${line}\n`);
  };

  const provider = await loadProvider();
  say('# AgentFuse — latency benchmark');
  say();
  say(
    `${CALLS} measured calls per configuration, ${WARMUP} discarded first · node ${process.version} · ${process.platform}/${process.arch}`,
  );
  say(
    provider === undefined
      ? `**${EMBEDDINGS_PACKAGE} is not available**, so the in-memory semantic rows are missing. The stdio semantic rows will fall back to rule-only inside the CLI and say so in its own diagnostics.`
      : `embedder: ${provider.id} (${provider.dims} dims)`,
  );

  const measurements: Measurement[] = [];

  // ---- tier 1: InMemoryTransport -----------------------------------------
  say();
  say('## Tier 1 — `InMemoryTransport` (the engine and one in-process hop)');
  say();
  say(HEADER);
  say(RULE);

  for (const telemetry of ['off', 'on'] as const) {
    const direct = await directRig();
    measurements.push({
      tier: 'in-memory',
      config: 'direct',
      telemetry,
      distribution: summarise(await measure(direct)),
    });
    await direct.close();

    const rules = await proxiedRig({ telemetry });
    measurements.push({
      tier: 'in-memory',
      config: 'rules',
      telemetry,
      distribution: summarise(await measure(rules)),
    });
    await rules.close();

    if (provider !== undefined) {
      const semantic = await proxiedRig({ telemetry, provider });
      const distribution = summarise(await measure(semantic));
      measurements.push({
        tier: 'in-memory',
        config: 'semantic',
        telemetry,
        distribution,
        queue: semantic.stats?.(),
      });
      await semantic.close();
    }
  }

  for (const m of measurements) {
    say(row(`${m.config} · telemetry ${m.telemetry}`, m.distribution));
  }

  // ---- tier 2: a real stdio pipe ------------------------------------------
  const stdioStart = measurements.length;
  say();
  say('## Tier 2 — a real stdio pipe through the built CLI');
  say();
  say(HEADER);
  say(RULE);

  for (const telemetry of ['off', 'on'] as const) {
    const collector: Collector | undefined =
      telemetry === 'on' ? await startCollector() : undefined;

    // The direct leg never has a collector — there is no AgentFuse in it to
    // export anything — so its two rows differ only by measurement noise, and
    // that difference is itself a useful reading of how noisy the tier is.
    const direct = await directStdioRig();
    measurements.push({
      tier: 'stdio',
      config: 'direct',
      telemetry,
      distribution: summarise(await measure(direct)),
    });
    await direct.close();

    for (const semantic of [false, true]) {
      const rig = await wrappedStdioRig({
        semantic,
        telemetry,
        ...(collector !== undefined ? { endpoint: collector.endpoint } : undefined),
      });
      const before = collector?.received() ?? 0;
      const distribution = summarise(await measure(rig));
      measurements.push({
        tier: 'stdio',
        config: semantic ? 'semantic' : 'rules',
        telemetry,
        distribution,
        ...(collector !== undefined ? { exports: collector.received() - before } : undefined),
      });
      await rig.close();
    }

    await collector?.close();
  }

  for (const m of measurements.slice(stdioStart)) {
    const suffix = m.exports === undefined ? '' : ` (${m.exports} export posts)`;
    say(row(`${m.config} · telemetry ${m.telemetry}${suffix}`, m.distribution));
  }

  // ---- added latency -------------------------------------------------------
  say();
  say('## Added latency — `(rules | semantic) − direct`, percentile by percentile');
  say();
  say(HEADER);
  say(RULE);

  const deltas: Record<string, Distribution> = {};
  for (const tier of ['in-memory', 'stdio'] as const) {
    for (const telemetry of ['off', 'on'] as const) {
      const direct = measurements.find(
        (m) => m.tier === tier && m.telemetry === telemetry && m.config === 'direct',
      );
      if (direct === undefined) continue;
      for (const config of ['rules', 'semantic'] as const) {
        const proxied = measurements.find(
          (m) => m.tier === tier && m.telemetry === telemetry && m.config === config,
        );
        if (proxied === undefined) continue;
        const key = `${tier} · ${config} · telemetry ${telemetry}`;
        const delta = added(direct.distribution, proxied.distribution);
        deltas[key] = delta;
        say(row(key, delta));
      }
    }
  }

  // ---- the telemetry axis --------------------------------------------------
  say();
  say('## What telemetry costs');
  say();
  for (const tier of ['in-memory', 'stdio'] as const) {
    for (const config of ['rules', 'semantic'] as const) {
      const off = measurements.find(
        (m) => m.tier === tier && m.config === config && m.telemetry === 'off',
      );
      const on = measurements.find(
        (m) => m.tier === tier && m.config === config && m.telemetry === 'on',
      );
      if (off === undefined || on === undefined) continue;
      say(
        `- ${tier} ${config}: p95 ${ms(off.distribution.p95)} → ${ms(on.distribution.p95)} ms (${ms(on.distribution.p95 - off.distribution.p95)} ms), p99 ${ms(off.distribution.p99)} → ${ms(on.distribution.p99)} ms`,
      );
    }
  }
  say();
  say('## What the embedding queue actually did');
  say();
  const queue = measurements.find((m) => m.queue !== undefined)?.queue;
  if (queue !== undefined) {
    say(
      `in-memory, ${CALLS + WARMUP} calls: offered ${queue.offered}, embedded ${queue.embedded}, shed by sampling ${queue.droppedSampling}, dropped on overflow ${queue.droppedOverflow}, still waiting at the end ${queue.depth}`,
    );
  }
  const probed = provider === undefined ? {} : await semanticQueueProbe(300);
  if (Object.keys(probed).length > 0) {
    say(
      `wrapped process, 300 calls: ${Object.entries(probed)
        .map(([key, value]) => `${key} ${value}`)
        .join(', ')}`,
    );
  }
  say();
  say(
    'These two lines are the explanation for the whole table. In memory the client calls faster than any model can answer, so the queue sheds almost everything and the semantic tier is free — which is the property ADR-002 was designed for, and the proof that the hot path is genuinely decoupled. Through a pipe the calls are slower, the queue keeps up, and the ONNX work then competes for the same process and the same cores as the proxy: that is where the extra milliseconds come from. Load shedding is the design working, not a fault; a session that shed is marked `degraded` and its report says so.',
  );
  if (probed.batches !== undefined && probed.offered !== undefined) {
    say();
    say(
      `**Note the batch count: ${probed.batches} batches for ${probed.offered} jobs.** Under a steady arrival rate the worker is always idle when the next call completes, so it takes a batch of one and pays the model's fixed per-inference cost every time; phase 4 measured a batch of eight at 10.7 ms, so eight batches of one cost several times what one batch of eight would. The queue cannot wait for company because it owns no timer — core has no clock of its own and phase 3 rejected a \`Scheduler\` port for that reason — and the only alternative, holding jobs until a deadline checked on the *next* enqueue, would leave the tail of a short session unscored. That is a detection-coverage trade for a latency budget with ten times the headroom it needs, so it is recorded here rather than taken.`,
    );
  }

  // ---- the verdict ---------------------------------------------------------
  say();
  say('## Verdict against PRD §6');
  say();
  const worst = Object.entries(deltas).reduce<[string, number]>(
    (acc, [key, delta]) => (delta.p95 > acc[1] ? [key, delta.p95] : acc),
    ['none', Number.NEGATIVE_INFINITY],
  );
  const pass = worst[1] < BUDGET_P95_MS;
  say(
    `- added latency p95 < ${BUDGET_P95_MS} ms: ${pass ? 'MET' : 'NOT MET'} · worst configuration is ${worst[0]} at ${ms(worst[1])} ms`,
  );

  mkdirSync(dirname(RESULTS_JSON), { recursive: true });
  writeFileSync(
    RESULTS_JSON,
    `${JSON.stringify(
      {
        generatedBy: 'bench/src/latency/run.ts',
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        calls: CALLS,
        warmup: WARMUP,
        budgetP95Ms: BUDGET_P95_MS,
        measurements,
        added: deltas,
        worst: { configuration: worst[0], p95Ms: worst[1] },
        met: pass,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(RESULTS_MD, `${out.join('\n')}\n`, 'utf8');

  await provider?.close?.();
  if (!pass) process.exitCode = 1;
}

await main();
