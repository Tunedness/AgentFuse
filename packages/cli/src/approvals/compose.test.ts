import type { ApprovalGateway, ApprovalRequest, ApprovalVerdict } from '@agentfuse/core';
import { DIAGNOSTIC_PREFIX, Diagnostics } from '@agentfuse/proxy';
import { describe, expect, it } from 'vitest';
import { StringWriter } from '../io.js';
import { CompositeApprovalGateway } from './compose.js';

/**
 * The composition rule, one test per clause of it. Two channels can only
 * usefully be redundancy, so the rule has to let either one answer — without
 * letting the quicker one to *give up* decide, and without letting a broken one
 * become consent.
 */

const REQUEST: ApprovalRequest = {
  approvalId: '01APPROVAL',
  sessionId: '01SESSION',
  toolName: 'write_file',
  serverName: 'fs',
  argsPreview: '{}',
  reasons: [{ code: 'POLICY_APPROVAL', message: 'needs a human' }],
  timeoutMs: 5_000,
};

/** How a fake channel behaves. */
interface Behaviour {
  readonly verdict?: ApprovalVerdict;
  readonly throws?: string;
  readonly afterMs?: number;
  /** Answers anyway after being stood down, which is how a late verdict races in. */
  readonly ignoresAbort?: boolean;
}

/** A channel that answers as told, and abandons the prompt when aborted. */
function channel(behaviour: Behaviour): { gateway: ApprovalGateway; aborted: () => boolean } {
  let sawAbort = false;
  return {
    aborted: () => sawAbort,
    gateway: {
      requestApproval: (_request, signal) =>
        new Promise<ApprovalVerdict>((resolve, reject) => {
          const settle = (): void => {
            if (behaviour.throws !== undefined) reject(new Error(behaviour.throws));
            else resolve(behaviour.verdict ?? 'timeout');
          };
          const timer = setTimeout(settle, behaviour.afterMs ?? 0);
          const onAbort = (): void => {
            sawAbort = true;
            if (behaviour.ignoresAbort === true) return;
            clearTimeout(timer);
            // What a real gateway does: an abandoned prompt is a denial.
            resolve('denied');
          };
          // A signal may already be aborted when a gateway is called, and then
          // no event ever fires. Both real gateways check for that, so the
          // double does too.
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
    },
  };
}

function composite(
  members: ReadonlyArray<[string, ApprovalGateway]>,
  sink = new StringWriter(),
): { gateway: CompositeApprovalGateway; sink: StringWriter } {
  return {
    sink,
    gateway: new CompositeApprovalGateway(
      members.map(([name, gateway]) => ({ name, gateway })),
      new Diagnostics({ sink }),
    ),
  };
}

/** Every parsed diagnostic line. */
function events(sink: StringWriter): Array<Record<string, unknown>> {
  return sink.lines.map(
    (line) => JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length).trim()) as Record<string, unknown>,
  );
}

describe('the composition rule', () => {
  it('reports the channels in the order the policy listed them', () => {
    const { gateway } = composite([
      ['cli', channel({}).gateway],
      ['webhook', channel({}).gateway],
    ]);

    expect(gateway.names).toEqual(['cli', 'webhook']);
  });

  it('takes the first decisive answer and stands the other channel down', async () => {
    const fast = channel({ verdict: 'approved', afterMs: 0 });
    const slow = channel({ verdict: 'denied', afterMs: 500 });
    const { gateway, sink } = composite([
      ['cli', fast.gateway],
      ['webhook', slow.gateway],
    ]);

    await expect(gateway.requestApproval(REQUEST, new AbortController().signal)).resolves.toBe(
      'approved',
    );
    expect(slow.aborted()).toBe(true);
    expect(events(sink)).toContainEqual(
      expect.objectContaining({ event: 'approval_decided_by', source: 'cli', verdict: 'approved' }),
    );
  });

  it('lets a denial from either channel end the request', async () => {
    const { gateway } = composite([
      ['cli', channel({ verdict: 'timeout', afterMs: 500 }).gateway],
      ['webhook', channel({ verdict: 'denied' }).gateway],
    ]);

    await expect(gateway.requestApproval(REQUEST, new AbortController().signal)).resolves.toBe(
      'denied',
    );
  });

  it('does not let one channel giving up end the request', async () => {
    // The whole point of the clause: the fastest channel to *stop waiting* must
    // not deny a call the other channel's human was about to approve.
    const quitter = channel({ verdict: 'timeout', afterMs: 0 });
    const human = channel({ verdict: 'approved', afterMs: 60 });
    const { gateway } = composite([
      ['cli', quitter.gateway],
      ['webhook', human.gateway],
    ]);

    await expect(gateway.requestApproval(REQUEST, new AbortController().signal)).resolves.toBe(
      'approved',
    );
  });

  it('reports a timeout only when every channel has timed out', async () => {
    const { gateway } = composite([
      ['cli', channel({ verdict: 'timeout' }).gateway],
      ['webhook', channel({ verdict: 'timeout', afterMs: 20 }).gateway],
    ]);

    await expect(gateway.requestApproval(REQUEST, new AbortController().signal)).resolves.toBe(
      'timeout',
    );
  });

  it('fails closed when a channel breaks and nobody else answers', async () => {
    // A broken gateway must not be convertible into consent by an
    // `on_timeout: allow` policy, so it denies rather than timing out.
    const { gateway, sink } = composite([
      ['cli', channel({ throws: 'socket is gone' }).gateway],
      ['webhook', channel({ verdict: 'timeout', afterMs: 20 }).gateway],
    ]);

    await expect(gateway.requestApproval(REQUEST, new AbortController().signal)).resolves.toBe(
      'denied',
    );
    expect(events(sink)).toContainEqual(
      expect.objectContaining({ event: 'approval_gateway_failed', source: 'cli' }),
    );
  });

  it('still takes a real answer when the other channel breaks', async () => {
    const { gateway } = composite([
      ['cli', channel({ throws: 'socket is gone' }).gateway],
      ['webhook', channel({ verdict: 'approved', afterMs: 20 }).gateway],
    ]);

    await expect(gateway.requestApproval(REQUEST, new AbortController().signal)).resolves.toBe(
      'approved',
    );
  });

  it('records a verdict that arrives after the decision instead of dropping it', async () => {
    // "I approved that and it was refused" has to be answerable from the log.
    const { gateway, sink } = composite([
      ['cli', channel({ verdict: 'denied' }).gateway],
      ['webhook', channel({ verdict: 'approved', afterMs: 5, ignoresAbort: true }).gateway],
    ]);

    await gateway.requestApproval(REQUEST, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const discarded = events(sink).filter((line) => line['event'] === 'approval_discarded');
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({ source: 'webhook', verdict: 'approved' });
  });

  it('passes the engine’s abort on to every channel', async () => {
    const one = channel({ verdict: 'approved', afterMs: 500 });
    const two = channel({ verdict: 'approved', afterMs: 500 });
    const { gateway } = composite([
      ['cli', one.gateway],
      ['webhook', two.gateway],
    ]);
    const controller = new AbortController();

    const pending = gateway.requestApproval(REQUEST, controller.signal);
    controller.abort();

    await expect(pending).resolves.toBe('denied');
    expect(one.aborted()).toBe(true);
    expect(two.aborted()).toBe(true);
  });

  it('handles a signal that was aborted before it was called', async () => {
    const one = channel({ verdict: 'approved', afterMs: 500 });
    const { gateway } = composite([['cli', one.gateway]]);
    const controller = new AbortController();
    controller.abort();

    await expect(gateway.requestApproval(REQUEST, controller.signal)).resolves.toBe('denied');
    expect(one.aborted()).toBe(true);
  });
});
