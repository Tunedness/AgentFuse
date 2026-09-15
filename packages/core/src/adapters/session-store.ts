import { initialBreakerState } from '../domain/breaker.js';
import type { SessionState } from '../domain/session.js';
import type { SessionStore } from '../ports/index.js';

/**
 * The default store: a `Map`.
 *
 * Sufficient for the proxy, where one process owns one agent's sessions. A
 * Redis-backed store can be dropped in later without the engine noticing,
 * provided it stays synchronous.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionState>();

  get(sessionId: string): SessionState | undefined {
    return this.#sessions.get(sessionId);
  }

  create(sessionId: string, now: number): SessionState {
    const state: SessionState = {
      sessionId,
      startedAt: now,
      lastActivityAt: now,
      breaker: initialBreakerState(),
      counters: {
        calls: 0,
        durationMs: 0,
        tokensEstimated: 0,
        usdEstimated: 0,
        argsTokens: 0,
        resultTokens: 0,
      },
      budgetNotified: new Set(),
      window: [],
      inFlight: new Map(),
      errorCalls: 0,
      trips: [],
      pendingApprovals: new Set(),
    };
    this.#sessions.set(sessionId, state);
    return state;
  }

  touch(state: SessionState, now: number): void {
    state.lastActivityAt = now;
    state.counters.durationMs = now - state.startedAt;
  }

  delete(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  sweepIdle(idleTimeoutMs: number, now: number): string[] {
    const dropped: string[] = [];
    for (const [id, state] of this.#sessions) {
      if (now - state.lastActivityAt >= idleTimeoutMs) {
        this.#sessions.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  all(): Iterable<SessionState> {
    return this.#sessions.values();
  }
}
