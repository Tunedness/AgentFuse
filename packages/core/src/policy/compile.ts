import type { z } from 'zod';
import { sha256 } from '../util/hash.js';
import { stableStringify, toJsonValue } from '../util/json.js';
import { compileGlob, toolKey } from './glob.js';
import {
  type FusePolicy,
  FusePolicySchemaV1,
  type LoopDetectionOverride,
  type LoopDetectionSettings,
  type ToolRule,
} from './schema.js';

/** Thrown when a policy document does not validate. */
export class PolicyValidationError extends Error {
  /** One `path: message` line per problem, in document order. */
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid FusePolicy:\n  ${issues.join('\n  ')}`);
    this.name = 'PolicyValidationError';
    this.issues = issues;
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<root>';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
}

/**
 * Validates an already-parsed policy document.
 *
 * Reading and parsing YAML is **not** core's job: core does no I/O and carries
 * no YAML dependency. The CLI reads the file and hands the resulting object in.
 *
 * @throws {PolicyValidationError} naming every offending path.
 */
export function parsePolicy(input: unknown): FusePolicy {
  const result = FusePolicySchemaV1.safeParse(input);
  if (!result.success) throw new PolicyValidationError(formatIssues(result.error));
  return result.data;
}

/** The default policy: what `{ version: 1 }` means. */
export function defaultPolicy(): FusePolicy {
  return parsePolicy({ version: 1 });
}

/** Merges a rule's partial `loop_detection` over the global settings. */
export function mergeLoopDetection(
  base: LoopDetectionSettings,
  override: LoopDetectionOverride | undefined,
): LoopDetectionSettings {
  if (!override) return base;
  return {
    window: override.window ?? base.window,
    min_calls: override.min_calls ?? base.min_calls,
    exact_repeat: { count: override.exact_repeat?.count ?? base.exact_repeat.count },
    error_repeat: { count: override.error_repeat?.count ?? base.error_repeat.count },
    cycle: { max_period: override.cycle?.max_period ?? base.cycle.max_period },
    semantic: {
      enabled: override.semantic?.enabled ?? base.semantic.enabled,
      provider: override.semantic?.provider ?? base.semantic.provider,
      model: override.semantic?.model ?? base.semantic.model,
      threshold: override.semantic?.threshold ?? base.semantic.threshold,
      consecutive_windows:
        override.semantic?.consecutive_windows ?? base.semantic.consecutive_windows,
    },
    on_trip: override.on_trip ?? base.on_trip,
    cooldown: {
      calls: override.cooldown?.calls ?? base.cooldown.calls,
      duration: override.cooldown?.duration ?? base.cooldown.duration,
    },
  };
}

/** A policy rule with its pattern compiled and its loop settings resolved. */
export interface CompiledRule {
  /** Position in the `tools` array. */
  index: number;
  /** Stable identity used as `Decision.matchedRule`, e.g. `tools[2]`. */
  id: string;
  rule: ToolRule;
  pattern: RegExp;
  /** Global loop settings with this rule's override already applied. */
  loop: LoopDetectionSettings;
}

/** A policy prepared for the hot path. */
export interface CompiledPolicy {
  readonly policy: FusePolicy;
  readonly rules: readonly CompiledRule[];
  /** SHA-256 over the canonical JSON of the resolved policy; goes in reports. */
  readonly sha256: string;
  /**
   * How many completed calls a session must retain: the widest loop window any
   * rule could ask for, enough history for the longest cycle check, and enough
   * for the trip report's recent-calls table.
   */
  readonly windowCapacity: number;
  /** First matching rule for `<server>__<tool>`, or `undefined`. */
  match(serverName: string, toolName: string): CompiledRule | undefined;
}

const MATCH_CACHE_LIMIT = 1024;

/**
 * Prepares a validated policy for use.
 *
 * Every regex is built here, exactly once. `beforeCall` must never compile a
 * pattern — the proxy sits on the hot path of every tool call and the added
 * latency is a product requirement.
 */
export function compilePolicy(policy: FusePolicy): CompiledPolicy {
  const rules: CompiledRule[] = policy.tools.map((rule, index) => ({
    index,
    id: `tools[${index}]`,
    rule,
    pattern: compileGlob(rule.match),
    loop: mergeLoopDetection(policy.loop_detection, rule.loop_detection),
  }));

  const windows = [policy.loop_detection, ...rules.map((r) => r.loop)];
  const windowCapacity = Math.max(
    policy.report.recent_calls,
    ...windows.map((l) => Math.max(l.window, l.cycle.max_period * 2, l.exact_repeat.count)),
  );

  const cache = new Map<string, CompiledRule | undefined>();

  return {
    policy,
    rules,
    sha256: sha256(stableStringify(toJsonValue(policy))),
    windowCapacity,
    match(serverName, toolName) {
      const key = toolKey(serverName, toolName);
      if (cache.has(key)) return cache.get(key);
      const found = rules.find((r) => r.pattern.test(key));
      if (cache.size >= MATCH_CACHE_LIMIT) cache.clear();
      cache.set(key, found);
      return found;
    },
  };
}

/** Validates and compiles in one step. */
export function loadPolicy(input: unknown): CompiledPolicy {
  return compilePolicy(parsePolicy(input));
}
