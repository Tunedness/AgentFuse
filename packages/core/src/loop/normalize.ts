import { type JsonValue, stableStringify, toJsonValue } from '../util/json.js';

/**
 * Argument normalization: turning "the same call" into "the same string".
 *
 * Two calls are the same piece of work if they differ only in values that carry
 * no intent — a request id, a timestamp, a trace id. Masking those before
 * fingerprinting is what lets the exact-repeat rule see a loop that a naive
 * `JSON.stringify` comparison would miss entirely.
 *
 * The risk runs the other way too, and it is the more dangerous one: mask too
 * much and distinct calls collapse into one fingerprint, and the breaker halts
 * an agent that was making perfectly good progress. Every mask below is
 * therefore narrow, and one field is explicitly protected from masking — see
 * {@link NEVER_MASKED_KEYS}.
 */

/** Placeholders. The guillemets make a masked value obvious in a report. */
export const MASKS = {
  uuid: '«uuid»',
  ts: '«ts»',
  epoch: '«epoch»',
  hex: '«hex»',
  jwt: '«jwt»',
  masked: '«masked»',
} as const;

/** Strings longer than this collapse in the middle. */
const MAX_STRING = 256;
const HEAD = 128;
const TAIL = 64;

/** How far from "now" a 10/13-digit integer may be and still read as a clock. */
const EPOCH_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * Keys whose value is replaced wholesale, matched case-insensitively after
 * stripping `_`, `-` and spaces. These are protocol plumbing: they change on
 * every call by design and never distinguish one piece of work from another.
 */
const MASKED_KEYS = new Set([
  'requestid',
  'traceid',
  'spanid',
  'nonce',
  'idempotencykey',
  'csrf',
  'etag',
]);

/**
 * Keys that are never value-masked, at any depth.
 *
 * **`cursor` is the whole reason this set exists.** A pagination cursor is
 * frequently an opaque base64 or hex blob, which the hex and JWT masks would
 * happily flatten to a constant — and then `list(cursor: "a")`,
 * `list(cursor: "b")`, `list(cursor: "c")` would share one fingerprint and the
 * exact-repeat rule would halt an agent that is paging through results
 * correctly. A changing cursor is *evidence of progress*, so it must survive
 * normalization intact.
 */
export const NEVER_MASKED_KEYS = new Set(['cursor']);

/** `Idempotency-Key` and `idempotency_key` are the same key. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

// Masks are applied in this order. JWT runs first because its segments would
// otherwise be eaten by the hex mask; UUID before hex for the same reason.
const JWT_RE =
  /(?<![A-Za-z0-9_-])(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/g;
const UUID_RE =
  /(?<![0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}(?![0-9A-Za-z])/g;
const ISO_RE =
  /(?<![0-9])\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?(?![0-9])/g;
const EPOCH_RE = /(?<![0-9A-Za-z])(\d{13}|\d{10})(?![0-9A-Za-z])/g;
const HEX_RE = /(?<![0-9A-Za-z])[0-9a-fA-F]{16,}(?![0-9A-Za-z])/g;

/** True when a 10- or 13-digit integer plausibly denotes a moment near `now`. */
function looksLikeEpoch(digits: string, now: number): boolean {
  const value = Number(digits);
  const ms = digits.length === 10 ? value * 1000 : value;
  return Math.abs(ms - now) <= EPOCH_WINDOW_MS;
}

/** Applies every value mask to one string. */
export function maskString(input: string, now: number): string {
  return input
    .replace(JWT_RE, MASKS.jwt)
    .replace(UUID_RE, MASKS.uuid)
    .replace(ISO_RE, MASKS.ts)
    .replace(EPOCH_RE, (match) => (looksLikeEpoch(match, now) ? MASKS.epoch : match))
    .replace(HEX_RE, MASKS.hex);
}

/**
 * Collapses the middle of an over-long string.
 *
 * The length marker matters: a body that grew is a different request, but a
 * body that differs only somewhere in the middle of a megabyte of text is
 * almost always the same request retried.
 */
export function truncateValue(input: string): string {
  if (input.length <= MAX_STRING) return input;
  return `${input.slice(0, HEAD)}…«len=${input.length}»…${input.slice(-TAIL)}`;
}

function maskJson(value: JsonValue, key: string | undefined, now: number): JsonValue {
  const exempt = key !== undefined && NEVER_MASKED_KEYS.has(key);

  if (typeof value === 'string') {
    return truncateValue(exempt ? value : maskString(value, now));
  }
  if (typeof value === 'number') {
    if (exempt || !Number.isInteger(value)) return value;
    const digits = Math.abs(value).toString();
    if ((digits.length === 10 || digits.length === 13) && looksLikeEpoch(digits, now)) {
      return MASKS.epoch;
    }
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    // The key travels down into the array so `cursor: [...]` stays exempt and
    // `trace_id: [...]` stays masked.
    return value.map((item) => maskJson(item, key, now));
  }

  // Null prototype — see the note in `toJsonValue`.
  const out = Object.create(null) as { [k: string]: JsonValue };
  for (const [childKey, childValue] of Object.entries(value)) {
    const normalized = normalizeKey(childKey);
    out[childKey] = MASKED_KEYS.has(normalized)
      ? MASKS.masked
      : maskJson(childValue, normalized, now);
  }
  return out;
}

/**
 * Canonical, masked JSON for a call's arguments.
 *
 * Deterministic in `(args, now)` alone. `now` only ever affects whether a
 * 10/13-digit integer reads as a clock, so a fake clock makes the whole thing
 * reproducible in tests.
 */
export function normalizeArgs(args: unknown, now: number): string {
  return stableStringify(maskJson(toJsonValue(args), undefined, now));
}

/**
 * Human-facing preview of raw arguments for approval prompts and reports.
 *
 * Unmasked — a human deciding whether to approve a call needs to see the real
 * values. Redaction for written reports is a separate, explicit policy switch
 * (`report.redact_args`).
 */
export function argsPreview(args: unknown, maxLength = 200): string {
  const text = stableStringify(toJsonValue(args));
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
