/**
 * What the semantic layer actually embeds.
 *
 * ADR-002 describes the input as "(ad + normalize argümanlar + sonuç özeti)" —
 * the tool's name, its normalized arguments, and a summary of the result. This
 * module is the one place that spelling lives, because the text is a contract:
 * change it and every calibrated threshold from phase 9 becomes meaningless,
 * and two AgentFuse versions scoring the same session would disagree.
 *
 * ```
 * <server>__<tool>
 * <argsNormalized, at most 800 chars>
 * result: <summary, at most 256 chars>
 * ```
 *
 * Three decisions are worth defending:
 *
 * - **The arguments come from `record.argsNormalized`,** which
 *   {@link normalizeArgs} already produced on the hot path for the fingerprint.
 *   Masking is not repeated here and must not be: the exact-repeat rule and the
 *   semantic rule have to agree on what "the same call" looks like, and two
 *   normalizers would drift apart.
 * - **The result is included, not just the request.** A loop is a request that
 *   keeps producing the same answer. `list_files` walking a directory tree
 *   produces near-identical requests and completely different results; an agent
 *   stuck retrying a failing write produces near-identical both. Without the
 *   result the first looks exactly like the second, and pagination is the
 *   canonical false positive this product cannot afford.
 * - **An error puts its signature first.** `ERROR(<signature>): ` in front of
 *   the summary means two failures of the same kind sit close together in
 *   embedding space even when the prose around them differs, which is the
 *   semantic counterpart of what the error-repeat rule does exactly.
 *
 * The arguments get the larger budget because that is where an agent's intent
 * lives; the result only has to say what kind of answer came back. Both are
 * capped so one megabyte of JSON cannot dominate a vector — and so the text
 * handed to a model stays inside a sentence-transformer's context either way.
 *
 * The argument cap only bites on a *wide* payload: {@link normalizeArgs} has
 * already collapsed any single string past 256 characters, so a lone huge blob
 * arrives here pre-shrunk and it takes dozens of fields to reach 800.
 */

import type { ToolCallRecord } from '../domain/records.js';
import { toolKey } from '../policy/glob.js';

/** Characters of normalized arguments kept. */
export const MAX_ARGS_CHARS = 800;
/** Characters of result summary kept, error prefix included. */
export const MAX_SUMMARY_CHARS = 256;

/**
 * Hard truncation with a visible marker.
 *
 * Deliberately not {@link truncateValue}'s middle collapse: that exists to keep
 * a *fingerprint* stable when the middle of a huge payload changes, whereas
 * here the leading characters carry the intent and a marker is enough to stop
 * two different truncations from looking identical.
 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The text for one completed call.
 *
 * A record with no outcome — a call still in flight, or one the engine
 * discarded — gets an empty result line rather than being refused, so a caller
 * cannot accidentally make the detector throw on the response path.
 */
export function semanticEmbeddingText(record: ToolCallRecord): string {
  const outcome = record.outcome;
  const raw = outcome?.resultSummary ?? '';
  const summary =
    outcome?.isError === true ? `ERROR(${outcome.errorSignature ?? 'unknown_error'}): ${raw}` : raw;

  // `toolKey` rather than the bare tool name: the fingerprint is built over
  // `<server>\0<tool>\0<args>` for the same reason, and `read_file` on two
  // different servers is not the same piece of work.
  return [
    toolKey(record.serverName, record.toolName),
    clip(record.argsNormalized, MAX_ARGS_CHARS),
    `result: ${clip(summary, MAX_SUMMARY_CHARS)}`,
  ].join('\n');
}
