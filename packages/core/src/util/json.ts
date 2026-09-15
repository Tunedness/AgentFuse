/**
 * Deterministic JSON.
 *
 * `JSON.stringify` is not usable for fingerprinting: it emits object keys in
 * insertion order, except that integer-like keys are hoisted and sorted
 * numerically. Two logically identical payloads can therefore serialise
 * differently. This serialiser sorts every object's keys itself and never
 * consults insertion order, so the output is a function of the value alone.
 */

/** Any value that survives a JSON round trip. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

function writeString(value: string): string {
  return JSON.stringify(value);
}

function writeNumber(value: number): string {
  // NaN and ±Infinity have no JSON representation; collapsing them to null
  // matches `JSON.stringify` and keeps fingerprints stable.
  return Number.isFinite(value) ? String(value) : 'null';
}

/**
 * Serialises a JSON value with object keys sorted lexicographically.
 *
 * Array order is preserved — the order of a list is semantic (`["a","b"]` is a
 * different request from `["b","a"]`) and sorting it would fuse distinct calls
 * into one fingerprint.
 */
export function stableStringify(value: JsonValue): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return writeString(value);
    case 'number':
      return writeNumber(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = value[key];
    if (entry === undefined) continue;
    parts.push(`${writeString(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Coerces an arbitrary value into a {@link JsonValue}, the way `JSON.stringify`
 * would: `undefined` and functions vanish from objects and become `null` in
 * arrays, `bigint` becomes its decimal string, and anything exotic becomes
 * `null`.
 *
 * `toJSON()` is honoured so `Date` behaves as expected.
 */
export function toJsonValue(input: unknown, seen: Set<object> = new Set()): JsonValue {
  if (input === null) return null;
  switch (typeof input) {
    case 'string':
    case 'boolean':
      return input;
    case 'number':
      return Number.isFinite(input) ? input : null;
    case 'bigint':
      return input.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return null;
    default:
      break;
  }
  const obj = input as object;
  if (seen.has(obj)) return null;
  const toJson = (obj as { toJSON?: () => unknown }).toJSON;
  if (typeof toJson === 'function') {
    return toJsonValue(toJson.call(obj), seen);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => toJsonValue(item, seen));
    }
    // Null prototype: a payload carrying a `__proto__` key must produce an own
    // property, not silently reassign the accumulator's prototype and vanish
    // from the fingerprint.
    const out = Object.create(null) as { [k: string]: JsonValue };
    for (const [key, raw] of Object.entries(obj)) {
      if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') continue;
      out[key] = toJsonValue(raw, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
