/**
 * The FusePolicy surface, exposed as the `@agentfuse/core/policy` subpath.
 *
 * `parsePolicy` takes an already-parsed object — core reads no files. The
 * generated JSON Schema in `schemas/fusepolicy.v1.schema.json` is produced from
 * {@link FusePolicySchemaV1}, so editors and the runtime validate the same
 * document.
 */

export type { CompiledPolicy, CompiledRule } from './compile.js';
export {
  compilePolicy,
  defaultPolicy,
  loadPolicy,
  mergeLoopDetection,
  PolicyValidationError,
  parsePolicy,
} from './compile.js';
export { DURATION_MESSAGE, DURATION_PATTERN, formatDuration, parseDuration } from './duration.js';
export type { RuleEvaluation } from './evaluate.js';
export { evaluateRules } from './evaluate.js';
export { compileGlob, globMatches, toolKey } from './glob.js';
export type {
  FusePolicy,
  LoopDetectionOverride,
  LoopDetectionSettings,
  PolicyMode,
  RuleAction,
  ToolRule,
  TripDisposition,
} from './schema.js';
export { FusePolicySchemaV1 } from './schema.js';
