import { z } from 'zod';
import { DURATION_MESSAGE, DURATION_PATTERN, parseDuration } from './duration.js';

/**
 * The FusePolicy document, as Zod.
 *
 * **This object is the single source of truth.** The published JSON Schema at
 * `schemas/fusepolicy.v1.schema.json` is generated from it by
 * `scripts/generate-schema.mts`, and CI fails if the two drift. Runtime
 * validation and editor autocomplete therefore cannot disagree.
 *
 * Every field has a default: `{ version: 1 }` parses into a complete, usable
 * policy. The most important of those defaults is `mode: 'warn'` — AgentFuse
 * observes and reports until a human decides it is trustworthy enough to
 * enforce. That is the mitigation for the product's first-listed risk (false
 * positives breaking a working agent), and it is not negotiable.
 *
 * Objects are strict: a misspelled key is a configuration bug that should
 * surface at load time, not silently disable the setting the operator thought
 * they had written.
 */

const durationInput = z.union(
  [
    z.string().regex(new RegExp(DURATION_PATTERN), DURATION_MESSAGE),
    z.number().int().nonnegative(),
  ],
  { error: DURATION_MESSAGE },
);

/** A duration field with a default, parsed to milliseconds. */
const duration = (fallback: string | number) =>
  durationInput.prefault(fallback).transform(parseDuration);

/** A duration field with no default, parsed to milliseconds. */
const optionalDuration = durationInput.transform(parseDuration).optional();

const positiveInt = () => z.number().int().positive();

// ---------------------------------------------------------------------------
// loop detection
// ---------------------------------------------------------------------------

const SemanticSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    provider: z.enum(['local', 'openai', 'none']).default('local'),
    model: z.string().min(1).default('Xenova/all-MiniLM-L6-v2'),
    /** Cosine similarity above which two windows count as "the same work". */
    threshold: z.number().min(0).max(1).default(0.83),
    /** How many consecutive windows must score above the threshold to trip. */
    consecutive_windows: positiveInt().default(2),
  })
  .prefault({});

const LoopDetectionSchema = z
  .strictObject({
    /** How many recent calls the rules look at. */
    window: positiveInt().default(8),
    /**
     * Minimum calls in the window before the **semantic** rule is allowed to
     * score. The deterministic rules (exact repeat, error repeat, cycle) are
     * not gated by it — gating them would defeat the whole point of catching a
     * three-call loop on the third call.
     */
    min_calls: positiveInt().default(5),
    exact_repeat: z.strictObject({ count: z.number().int().min(2).default(3) }).prefault({}),
    error_repeat: z.strictObject({ count: z.number().int().min(2).default(3) }).prefault({}),
    cycle: z.strictObject({ max_period: z.number().int().min(2).default(4) }).prefault({}),
    semantic: SemanticSchema,
    on_trip: z.enum(['halt', 'require_approval', 'warn']).default('halt'),
    cooldown: z
      .strictObject({ calls: positiveInt().default(3), duration: duration('2m') })
      .prefault({}),
  })
  .prefault({});

/** Per-rule partial override of {@link LoopDetectionSchema}. */
const LoopDetectionOverrideSchema = z
  .strictObject({
    window: positiveInt().optional(),
    min_calls: positiveInt().optional(),
    exact_repeat: z.strictObject({ count: z.number().int().min(2) }).optional(),
    error_repeat: z.strictObject({ count: z.number().int().min(2) }).optional(),
    cycle: z.strictObject({ max_period: z.number().int().min(2) }).optional(),
    semantic: z
      .strictObject({
        enabled: z.boolean().optional(),
        provider: z.enum(['local', 'openai', 'none']).optional(),
        model: z.string().min(1).optional(),
        threshold: z.number().min(0).max(1).optional(),
        consecutive_windows: positiveInt().optional(),
      })
      .optional(),
    on_trip: z.enum(['halt', 'require_approval', 'warn']).optional(),
    cooldown: z
      .strictObject({ calls: positiveInt().optional(), duration: optionalDuration })
      .optional(),
  })
  .optional();

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

const ToolRuleSchema = z.strictObject({
  /** Glob against `"<server>__<tool>"`. `*` spans any characters, `?` exactly one. */
  match: z.string().min(1),
  action: z.enum(['allow', 'warn', 'deny', 'require_approval']),
  /** Free-text rationale, surfaced in reports and approval prompts. */
  note: z.string().optional(),
  /**
   * Declares repeated identical calls harmless, which doubles the exact-repeat
   * threshold for this rule. Operator-asserted; unlike `idempotentHint` it is
   * not something the upstream server gets to claim about itself.
   */
  idempotent: z.boolean().default(false),
  loop_detection: LoopDetectionOverrideSchema,
});

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

export const FusePolicySchemaV1 = z
  .strictObject({
    version: z.literal(1),
    /**
     * `warn` observes and reports; `enforce` actually breaks the circuit.
     * Defaults to `warn` — see the module doc.
     */
    mode: z.enum(['warn', 'enforce']).default('warn'),

    session: z
      .strictObject({
        key: z
          .union([
            z.literal('auto'),
            z.literal('connection'),
            z.literal('traceparent'),
            z.string().regex(/^baggage:[A-Za-z0-9._-]+$/, 'expected "baggage:<name>"'),
          ])
          .default('auto'),
        idle_timeout: duration('10m'),
      })
      .prefault({}),

    budgets: z
      .strictObject({
        max_duration: duration('30m'),
        max_calls: positiveInt().default(200),
        max_tokens_estimated: positiveInt().default(400_000),
        max_usd_estimated: z.number().nonnegative().default(5),
        on_exceeded: z.enum(['halt', 'require_approval', 'warn']).default('require_approval'),
      })
      .prefault({}),

    loop_detection: LoopDetectionSchema,

    /** First match wins. An unmatched tool is allowed. */
    tools: z.array(ToolRuleSchema).prefault([{ match: '*', action: 'allow' }]),

    annotations: z
      .strictObject({
        /**
         * Whether to believe a server's own `readOnlyHint` / `idempotentHint`.
         * Off by default: the server is the thing being metered.
         */
        trust_hints: z.boolean().default(false),
      })
      .prefault({}),

    approvals: z
      .strictObject({
        timeout: duration('120s'),
        on_timeout: z.enum(['deny', 'allow']).default('deny'),
        gateways: z.array(z.enum(['cli', 'webhook'])).prefault(['cli']),
        webhook: z
          .strictObject({
            url: z.url(),
            /** Name of the env var holding the shared secret; never the secret. */
            secret_env: z.string().min(1),
          })
          .optional(),
      })
      .prefault({}),

    pricing: z
      .strictObject({
        input_per_mtok_usd: z.number().nonnegative().default(3),
        output_per_mtok_usd: z.number().nonnegative().default(15),
      })
      .prefault({}),

    report: z
      .strictObject({
        dir: z.string().min(1).default('.agentfuse/reports'),
        recent_calls: positiveInt().default(20),
        /** Replaces argument previews with fingerprints in written reports. */
        redact_args: z.boolean().default(false),
      })
      .prefault({}),

    telemetry: z
      .strictObject({
        /** Off unless opted in, per umbrella ADR-003. */
        enabled: z.boolean().default(false),
        otlp_endpoint: z.string().min(1).default('http://localhost:4318'),
        service_name: z.string().min(1).default('agentfuse'),
      })
      .prefault({}),
  })
  .meta({
    // No `id` here on purpose: registering one makes `z.toJSONSchema` hoist the
    // whole document into `$defs` behind a `$ref`, which is a worse thing to
    // point an editor at. The script stamps `$id` onto the emitted root.
    title: 'FusePolicy v1',
    description:
      'Circuit-breaker policy for AgentFuse. Every field is optional except `version`; defaults are safe (mode: warn).',
  });

/** A fully defaulted, validated policy. Durations are milliseconds. */
export type FusePolicy = z.infer<typeof FusePolicySchemaV1>;

/** One entry of the `tools` list, after defaults. */
export type ToolRule = FusePolicy['tools'][number];

/** The global `loop_detection` block, after defaults. */
export type LoopDetectionSettings = FusePolicy['loop_detection'];

/** A per-rule partial override of {@link LoopDetectionSettings}. */
export type LoopDetectionOverride = NonNullable<ToolRule['loop_detection']>;

/** What a rule can decide about a call. */
export type RuleAction = ToolRule['action'];

/** What to do when a loop rule fires or a budget is exhausted. */
export type TripDisposition = LoopDetectionSettings['on_trip'];

/** `warn` observes; `enforce` breaks the circuit. */
export type PolicyMode = FusePolicy['mode'];
