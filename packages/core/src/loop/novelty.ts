/**
 * How much of a window's answers the agent had already been told.
 *
 * ## Why this exists
 *
 * ADR-002 puts the *result summary* into what the semantic layer embeds, and
 * `embed-text.ts` says why: pagination produces near-identical requests and
 * completely different answers, a stuck retry produces near-identical both, and
 * without the answer the first looks exactly like the second.
 *
 * Phase 9 measured that and found the intent had not survived the
 * implementation. Concatenating the request and the answer into one string and
 * embedding it lets the request dominate, because it is several times longer
 * and because a sentence transformer is mostly reading the tool name and the
 * argument shape. Phase 4's own table shows the failure directly: a
 * `search_issues` pagination pair scored **0.9971**, while the same tool asked
 * "login bug" and then "login error" — a genuine loop — scored **0.9791**. The
 * pair that should have been furthest apart was the closer one.
 *
 * So the answer gets its own signal, and this is it. It is deliberately **not**
 * another embedding: it is a token-overlap statistic, which costs no model
 * call, is exactly reproducible, and is legible in a trip report — "the last
 * six answers contained nothing you had not already been shown" is a sentence a
 * human can check against their own scrollback.
 *
 * ## What it computes
 *
 * For each call in the window, the fraction of its answer's distinct tokens
 * that also appear in **some other call's answer in the same window**. The
 * window's staleness is the mean of those fractions.
 *
 * - Ten pages of search results share their boilerplate and nothing else: every
 *   issue number and title is unique to one page, so staleness is low.
 * - A bulk edit across ten files shares "wrote" and "bytes" and nothing else.
 * - An agent retrying the same failing write gets the same sentence every time,
 *   so staleness is 1.
 *
 * The statistic is symmetric — "shared with any other call" rather than "seen
 * before" — because a window is a set of calls, not an ordering, and because
 * document frequency can then be maintained incrementally as slots are evicted.
 *
 * ## Deliberate edge cases
 *
 * An empty answer counts as **fully stale**. A tool that returns nothing, over
 * and over, is telling the agent nothing over and over; scoring the empty
 * string as novel would make the silent-tool loop the one case the layer could
 * not see.
 */

/** Distinct tokens kept per answer. Bounds memory and the inner loops. */
const MAX_TOKENS = 256;

const TOKEN_RE = /[a-z0-9]+/g;

/**
 * Lowercased alphanumeric runs, deduplicated.
 *
 * Crude on purpose. This is not trying to understand the answer — it is trying
 * to tell "these two answers are made of the same material" from "these two
 * answers are made of different material", and for that, punctuation and word
 * order are noise. Anything cleverer would need a language, and tool output is
 * not reliably in one.
 */
export function noveltyTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN_RE)) {
    out.add(match[0]);
    if (out.size >= MAX_TOKENS) break;
  }
  return out;
}

/** Options for {@link ResultNoveltyWindow}. */
export interface ResultNoveltyWindowOptions {
  /** How many answers the window holds. Comes from `loop_detection.window`. */
  capacity: number;
  /** Default minimum occupancy before {@link ResultNoveltyWindow.staleness} answers. */
  minCalls?: number;
}

/**
 * A fixed-capacity ring of answer token sets that knows its own staleness.
 *
 * Sized and evicted in lockstep with {@link EmbeddingWindow}: the two describe
 * the same window of calls from two directions, and a drift between them would
 * make the combined score meaningless.
 */
export class ResultNoveltyWindow {
  #capacity: number;
  readonly #minCalls: number;
  #slots: (Set<string> | undefined)[];
  /** token → how many slots currently contain it. */
  readonly #documentFrequency = new Map<string, number>();
  #count = 0;
  #head = 0;

  constructor(options: ResultNoveltyWindowOptions) {
    const { capacity } = options;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`window capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
    this.#minCalls = options.minCalls ?? 2;
    this.#slots = new Array<Set<string> | undefined>(capacity);
  }

  /** How many answers the window currently holds. */
  get size(): number {
    return this.#count;
  }

  /** How many it can hold. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Adds one answer, evicting the oldest when the window is full. */
  push(text: string): void {
    const tokens = noveltyTokens(text);
    const evicted = this.#slots[this.#head];
    if (evicted !== undefined) this.#release(evicted);
    else this.#count += 1;

    this.#slots[this.#head] = tokens;
    for (const token of tokens) {
      this.#documentFrequency.set(token, (this.#documentFrequency.get(token) ?? 0) + 1);
    }
    this.#head = (this.#head + 1) % this.#capacity;
  }

  /**
   * The mean fraction of each answer's tokens shared with another answer in the
   * window, or `null` when there is not enough of a window yet.
   *
   * Returns `null` below two occupied slots for the same reason
   * {@link EmbeddingWindow.score} does: one answer has nothing to be stale
   * against.
   */
  staleness(minCalls: number = this.#minCalls): number | null {
    if (this.#count < 2 || this.#count < minCalls) return null;

    let total = 0;
    for (const tokens of this.#slots) {
      if (tokens === undefined) continue;
      if (tokens.size === 0) {
        total += 1;
        continue;
      }
      let shared = 0;
      for (const token of tokens) {
        if ((this.#documentFrequency.get(token) ?? 0) >= 2) shared += 1;
      }
      total += shared / tokens.size;
    }
    return total / this.#count;
  }

  /**
   * Changes the capacity, keeping the newest answers that still fit.
   *
   * The mirror of {@link EmbeddingWindow.ensureCapacity}, and it has to exist
   * for the same reason: `loop_detection.window` is overridable per rule, so a
   * session that touches two differently-configured tools asks for two sizes.
   */
  ensureCapacity(capacity: number): void {
    if (capacity === this.#capacity) return;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`window capacity must be a positive integer, got ${capacity}`);
    }
    const kept = this.#oldestFirst().slice(-capacity);
    this.#capacity = capacity;
    this.#slots = new Array<Set<string> | undefined>(capacity);
    this.#documentFrequency.clear();
    this.#count = 0;
    this.#head = 0;
    for (const tokens of kept) {
      this.#slots[this.#head] = tokens;
      for (const token of tokens) {
        this.#documentFrequency.set(token, (this.#documentFrequency.get(token) ?? 0) + 1);
      }
      this.#head = (this.#head + 1) % this.#capacity;
      this.#count += 1;
    }
  }

  /** Empties the window. Used when the breaker closes and the history is moot. */
  clear(): void {
    this.#slots = new Array<Set<string> | undefined>(this.#capacity);
    this.#documentFrequency.clear();
    this.#count = 0;
    this.#head = 0;
  }

  // -------------------------------------------------------------------------

  #release(tokens: Set<string>): void {
    for (const token of tokens) {
      const next = (this.#documentFrequency.get(token) ?? 1) - 1;
      if (next <= 0) this.#documentFrequency.delete(token);
      else this.#documentFrequency.set(token, next);
    }
  }

  #oldestFirst(): Set<string>[] {
    const out: Set<string>[] = [];
    const oldest = (this.#head - this.#count + this.#capacity) % this.#capacity;
    for (let i = 0; i < this.#count; i += 1) {
      const slot = this.#slots[(oldest + i) % this.#capacity];
      if (slot !== undefined) out.push(slot);
    }
    return out;
  }
}
