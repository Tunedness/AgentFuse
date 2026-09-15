/**
 * The `tools/list` cache behind `ToolCallGuardOptions.annotationsFor`.
 *
 * Phase 5 left this hook unwired and said why: supplying it needs a catalogue
 * of the upstream's tool definitions, and the proxy holds no state of its own
 * that is not a connection. So the cache lives here, one per connection, filled
 * once from the upstream the bridge is already holding.
 *
 * ## Three properties worth stating, because they are what make this safe
 *
 * 1. **Nothing is fetched unless the policy asks for it.** `trust_hints`
 *    defaults to `false`, and with it off this never sends a request — an
 *    unrequested `tools/list` against somebody's server is not a free action.
 * 2. **An empty cache makes AgentFuse stricter, never looser.** The single
 *    thing core does with these hints is double the exact-repeat threshold for
 *    a tool the server calls `idempotentHint` (`guards/rule-loop.ts`). A hint
 *    that has not arrived yet therefore means the tighter threshold, so the
 *    race between the first tool call and the catalogue arriving cannot let a
 *    call through that should have been blocked.
 * 3. **The hints are validated, not believed.** They are written by the server
 *    AgentFuse exists to be sceptical of, so a `readOnlyHint: "yes"` is
 *    dropped rather than coerced, and a tool entry with no usable name is
 *    ignored. Core's `ToolAnnotations` is a subset of the wire shape; copying
 *    field by field also keeps a future wire addition from arriving in the
 *    engine unannounced.
 */

import type { ToolAnnotations } from '@agentfuse/core';

/** The part of an upstream connection this needs. Satisfied by the SDK's `Client`. */
export interface ToolLister {
  listTools(): Promise<unknown>;
}

/** Reads a boolean hint, ignoring anything that is not one. */
function flag(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The annotations of one wire tool entry, or `undefined` if it declares none.
 *
 * Exported for its own test: the validation is the interesting part of this
 * file, and a server that sends nonsense is the case it exists for.
 */
export function readAnnotations(value: unknown): ToolAnnotations | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const readOnlyHint = flag(raw, 'readOnlyHint');
  const destructiveHint = flag(raw, 'destructiveHint');
  const idempotentHint = flag(raw, 'idempotentHint');
  const openWorldHint = flag(raw, 'openWorldHint');
  const title = typeof raw['title'] === 'string' ? raw['title'] : undefined;

  const annotations: ToolAnnotations = {
    ...(readOnlyHint !== undefined ? { readOnlyHint } : undefined),
    ...(destructiveHint !== undefined ? { destructiveHint } : undefined),
    ...(idempotentHint !== undefined ? { idempotentHint } : undefined),
    ...(openWorldHint !== undefined ? { openWorldHint } : undefined),
    ...(title !== undefined ? { title } : undefined),
  };
  return Object.keys(annotations).length === 0 ? undefined : annotations;
}

/** How a {@link ToolCatalogue} behaves. */
export interface ToolCatalogueOptions {
  /**
   * The policy's `annotations.trust_hints`.
   *
   * `false` — the default — means the catalogue is never fetched at all, and
   * {@link ToolCatalogue.annotationsFor} answers `undefined` for everything.
   */
  readonly trustHints: boolean;
  /** Told what happened, so a failed fetch is visible rather than silent. */
  readonly onEvent?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

/** A connection's tool catalogue, as far as the engine cares about it. */
export class ToolCatalogue {
  readonly #trustHints: boolean;
  readonly #onEvent: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  readonly #annotations = new Map<string, ToolAnnotations>();
  #primed = false;

  constructor(options: ToolCatalogueOptions) {
    this.#trustHints = options.trustHints;
    this.#onEvent = options.onEvent;
  }

  /** Whether this will ever hold anything. */
  get trustHints(): boolean {
    return this.#trustHints;
  }

  /** How many tools declared usable annotations. */
  get size(): number {
    return this.#annotations.size;
  }

  /**
   * `ToolCallGuardOptions.annotationsFor`, bound.
   *
   * A property rather than a method so it can be handed over directly without
   * the caller having to remember to bind it.
   */
  readonly annotationsFor = (toolName: string): ToolAnnotations | undefined =>
    this.#annotations.get(toolName);

  /**
   * Fills the cache from an upstream connection. Never throws, and never twice.
   *
   * A server that cannot answer `tools/list` still gets its calls guarded; the
   * only consequence is the stricter threshold of property 2 above. Refusing
   * to serve because an optional catalogue failed would be the wrong trade in
   * both directions.
   */
  async prime(lister: ToolLister): Promise<void> {
    if (!this.#trustHints || this.#primed) return;
    this.#primed = true;

    let result: unknown;
    try {
      result = await lister.listTools();
    } catch (error) {
      this.#onEvent?.('tool_catalogue_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const tools = (result as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) {
      this.#onEvent?.('tool_catalogue_failed', { message: 'tools/list returned no tool list' });
      return;
    }

    for (const tool of tools) {
      const name = (tool as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name === '') continue;
      const annotations = readAnnotations((tool as { annotations?: unknown }).annotations);
      if (annotations !== undefined) this.#annotations.set(name, annotations);
    }

    this.#onEvent?.('tool_catalogue', { tools: tools.length, annotated: this.#annotations.size });
  }
}
