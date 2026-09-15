import { describe, expect, it } from 'vitest';
import type { BreakerPhase, BreakerState } from '../domain/breaker.js';
import type { Reason } from '../domain/decision.js';
import { applyBreakerEvent, type BreakerEvent } from './breaker.js';

const REASON: Reason = { code: 'LOOP_EXACT_REPEAT', message: 'test' };

function stateIn(phase: BreakerPhase): BreakerState {
  return phase === 'closed'
    ? { phase, approvedSinceHalfOpen: 0 }
    : { phase, approvedSinceHalfOpen: 0, trippedAt: 1_000, tripReason: REASON };
}

const EVENTS = {
  'trip(halt)': { kind: 'trip', disposition: 'halt', reason: REASON, now: 2_000 },
  'trip(require_approval)': {
    kind: 'trip',
    disposition: 'require_approval',
    reason: REASON,
    now: 2_000,
  },
  'trip(warn)': { kind: 'trip', disposition: 'warn', reason: REASON, now: 2_000 },
  cooldown_elapsed: { kind: 'cooldown_elapsed', now: 2_000 },
  approved: { kind: 'approved', cooldownCalls: 1 },
  denied: { kind: 'denied', now: 2_000 },
  reset: { kind: 'reset' },
} satisfies Record<string, BreakerEvent>;

type EventName = keyof typeof EVENTS;

/**
 * The full transition table, phase by event.
 *
 * Written out rather than derived, so a change to the machine has to be
 * defended here in plain sight instead of quietly agreeing with itself.
 */
const TABLE: [BreakerPhase, EventName, BreakerPhase][] = [
  ['closed', 'trip(halt)', 'open'],
  ['closed', 'trip(require_approval)', 'half_open'],
  ['closed', 'trip(warn)', 'closed'],
  ['closed', 'cooldown_elapsed', 'closed'],
  ['closed', 'approved', 'closed'],
  ['closed', 'denied', 'closed'],
  ['closed', 'reset', 'closed'],

  ['open', 'trip(halt)', 'open'],
  ['open', 'trip(require_approval)', 'open'],
  ['open', 'trip(warn)', 'open'],
  ['open', 'cooldown_elapsed', 'half_open'],
  ['open', 'approved', 'open'],
  ['open', 'denied', 'open'],
  ['open', 'reset', 'closed'],

  ['half_open', 'trip(halt)', 'open'],
  ['half_open', 'trip(require_approval)', 'open'],
  ['half_open', 'trip(warn)', 'open'],
  ['half_open', 'cooldown_elapsed', 'half_open'],
  ['half_open', 'approved', 'closed'],
  ['half_open', 'denied', 'open'],
  ['half_open', 'reset', 'closed'],
];

describe('breaker transition table', () => {
  it('covers every phase against every event', () => {
    expect(TABLE).toHaveLength(3 * Object.keys(EVENTS).length);
  });

  it.each(TABLE)('%s + %s -> %s', (from, event, expected) => {
    const state = stateIn(from);
    const transition = applyBreakerEvent(state, EVENTS[event]);
    expect(transition.from).toBe(from);
    expect(transition.to).toBe(expected);
    expect(state.phase).toBe(expected);
  });
});

describe('breaker details', () => {
  it('only clears the loop window when the circuit closes', () => {
    expect(applyBreakerEvent(stateIn('half_open'), EVENTS.approved).clearWindow).toBe(true);
    expect(applyBreakerEvent(stateIn('open'), EVENTS.reset).clearWindow).toBe(true);
    expect(applyBreakerEvent(stateIn('closed'), EVENTS['trip(halt)']).clearWindow).toBe(false);
    expect(applyBreakerEvent(stateIn('open'), EVENTS.cooldown_elapsed).clearWindow).toBe(false);
  });

  it('needs cooldown.calls consecutive approvals to close', () => {
    const state = stateIn('half_open');
    for (let i = 1; i < 3; i += 1) {
      const transition = applyBreakerEvent(state, { kind: 'approved', cooldownCalls: 3 });
      expect(transition.to).toBe('half_open');
      expect(state.approvedSinceHalfOpen).toBe(i);
    }
    const last = applyBreakerEvent(state, { kind: 'approved', cooldownCalls: 3 });
    expect(last.to).toBe('closed');
    expect(state.approvedSinceHalfOpen).toBe(0);
    expect(state.tripReason).toBeUndefined();
  });

  it('records why it tripped, and forgets once closed', () => {
    const state = stateIn('closed');
    applyBreakerEvent(state, EVENTS['trip(halt)']);
    expect(state.trippedAt).toBe(2_000);
    expect(state.tripReason).toBe(REASON);

    applyBreakerEvent(state, EVENTS.reset);
    expect(state.trippedAt).toBeUndefined();
    expect(state.tripReason).toBeUndefined();
  });

  it('does not stamp a trip time when the disposition is only to warn', () => {
    const state = stateIn('closed');
    applyBreakerEvent(state, EVENTS['trip(warn)']);
    expect(state.trippedAt).toBeUndefined();
  });

  it('resets the approval streak on any phase change', () => {
    const state = stateIn('half_open');
    state.approvedSinceHalfOpen = 2;
    applyBreakerEvent(state, EVENTS['trip(halt)']);
    expect(state.approvedSinceHalfOpen).toBe(0);
  });
});
