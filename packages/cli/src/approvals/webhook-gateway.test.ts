import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApprovalRequest } from '@agentfuse/core';
import { DIAGNOSTIC_PREFIX, Diagnostics } from '@agentfuse/proxy';
import { afterEach, describe, expect, it } from 'vitest';
import { StringWriter } from '../io.js';
import {
  MAX_RESPONSE_BYTES,
  SIGNATURE_HEADER,
  signatureHeaderValue,
  signBody,
  verifySignature,
  WebhookApprovalGateway,
  webhookPayload,
} from './webhook-gateway.js';

/**
 * The webhook is tested against a real HTTP server that verifies the signature
 * **with its own `createHmac` call**, not with ours. A receiver is the party
 * this scheme has to convince, so a test that used our own signing code on both
 * sides would prove only that the function is deterministic.
 *
 * The digest is also pinned against a fixture. Changing the scheme has to be a
 * deliberate act: every receiver anybody has written stops working when it
 * changes, and the failure is a silently unverifiable request.
 */

const SECRET = 'shhh';

/** The exact body the fixture below was computed from. */
const FIXTURE_BODY =
  '{"v":1,"type":"approval_request","timestamp":1758000000000,"approvalId":"01APPROVAL","sessionId":"01SESSION","server":"fs","tool":"write_file","argsPreview":"{}","reasons":[{"code":"POLICY_APPROVAL","message":"needs a human"}],"timeoutMs":120000}';

/** `HMAC-SHA256("shhh", FIXTURE_BODY)`, hex. */
const FIXTURE_DIGEST = '94c1b5b6becf2a98e42cb09ed1df41eb0a4e563de6c4e2f2a44f33a4ba516dcd';

const servers: Server[] = [];
const held: Array<() => void> = [];

afterEach(async () => {
  for (const release of held.splice(0)) release();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: '01APPROVAL',
    sessionId: '01SESSION',
    toolName: 'write_file',
    serverName: 'fs',
    argsPreview: '{}',
    reasons: [{ code: 'POLICY_APPROVAL', message: 'needs a human' }],
    timeoutMs: 120_000,
    ...overrides,
  };
}

/** What the receiver saw. */
interface Received {
  readonly body: string;
  readonly signature: string | undefined;
  readonly headers: Record<string, string>;
  readonly verified: boolean;
}

type Responder = (received: Received) => {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Hold the response open for this long before answering. */
  readonly delayMs?: number;
};

/** A receiver that verifies the signature itself and then answers. */
async function receiver(
  respond: Responder,
  secret = SECRET,
): Promise<{ url: string; seen: Received[] }> {
  const seen: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const header = req.headers[SIGNATURE_HEADER.toLowerCase()];
      const signature = typeof header === 'string' ? header : undefined;
      // The receiver's own verification, written the way a receiver would:
      // recompute the MAC over the bytes that arrived and compare.
      const expected = `v1=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
      const received: Received = {
        body,
        signature,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, String(value)]),
        ),
        verified: signature === expected,
      };
      seen.push(received);

      const answer = respond(received);
      const send = (): void => {
        res.writeHead(answer.status ?? 200, {
          'content-type': 'application/json',
          ...answer.headers,
        });
        res.end(answer.body ?? '{"verdict":"approved"}');
      };
      if (answer.delayMs === undefined) send();
      else {
        const timer = setTimeout(send, answer.delayMs);
        held.push(() => clearTimeout(timer));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/approvals`, seen };
}

function gatewayFor(
  url: string,
  sink: StringWriter,
  extra: { readonly maxResponseBytes?: number } = {},
): WebhookApprovalGateway {
  return new WebhookApprovalGateway({
    url,
    secret: SECRET,
    diagnostics: new Diagnostics({ sink }),
    now: () => 1_758_000_000_000,
    ...extra,
  });
}

/** One parsed diagnostic line, by event name. */
function event(sink: StringWriter, name: string): Record<string, unknown> {
  for (const line of sink.lines) {
    const payload = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length).trim()) as Record<
      string,
      unknown
    >;
    if (payload['event'] === name) return payload;
  }
  throw new Error(`no ${name} event in ${sink.text}`);
}

describe('the signature scheme', () => {
  it('matches the pinned fixture', () => {
    // If this changes, every receiver anybody has deployed stops verifying.
    expect(signBody(SECRET, FIXTURE_BODY)).toBe(FIXTURE_DIGEST);
    expect(signatureHeaderValue(SECRET, FIXTURE_BODY)).toBe(`v1=${FIXTURE_DIGEST}`);
  });

  it('is the body a request would actually carry', () => {
    // The fixture is not a hand-written string: it is what the gateway posts
    // for this request at this timestamp, so the pin covers the payload shape
    // as well as the digest.
    expect(JSON.stringify(webhookPayload(request(), 1_758_000_000_000))).toBe(FIXTURE_BODY);
  });

  it('puts the timestamp inside the signed body', () => {
    // Beside it in a header, a replay could pair an old body with a fresh
    // timestamp and the MAC would still verify.
    expect(webhookPayload(request(), 42).timestamp).toBe(42);
    expect(FIXTURE_BODY).toContain('"timestamp":1758000000000');
  });

  it('sends the reason codes and messages and nothing else from a reason', () => {
    const payload = webhookPayload(
      request({
        reasons: [{ code: 'BUDGET_CALLS', message: 'out of calls', evidence: { calls: 200 } }],
      }),
      1,
    );

    expect(payload.reasons).toEqual([{ code: 'BUDGET_CALLS', message: 'out of calls' }]);
  });

  it('verifies a correct signature', () => {
    expect(verifySignature(SECRET, FIXTURE_BODY, `v1=${FIXTURE_DIGEST}`)).toBe(true);
  });

  it.each([
    ['a tampered body', `${FIXTURE_BODY} `, `v1=${FIXTURE_DIGEST}`],
    ['a tampered digest', FIXTURE_BODY, `v1=${FIXTURE_DIGEST.replace(/^9/, '8')}`],
    ['the wrong secret', FIXTURE_BODY, `v1=${signBody('other', FIXTURE_BODY)}`],
    ['no scheme prefix', FIXTURE_BODY, FIXTURE_DIGEST],
    ['a truncated header', FIXTURE_BODY, 'v1=94c1'],
    ['a future scheme', FIXTURE_BODY, `v2=${FIXTURE_DIGEST}`],
  ])('rejects %s', (_label, body, header) => {
    expect(verifySignature(SECRET, body, header)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(SECRET, FIXTURE_BODY, undefined)).toBe(false);
  });

  it('is detectable end to end: one changed byte and the receiver refuses', async () => {
    const sink = new StringWriter();
    // The receiver holds a different secret, which is what an attacker
    // replaying or rewriting a request effectively produces.
    const endpoint = await receiver(
      (received) =>
        received.verified
          ? { body: '{"verdict":"approved"}' }
          : { status: 401, body: '{"error":"bad signature"}' },
      'a-different-secret',
    );

    const verdict = await gatewayFor(endpoint.url, sink).requestApproval(
      request(),
      new AbortController().signal,
    );

    expect(endpoint.seen[0]?.verified).toBe(false);
    expect(verdict).toBe('denied');
    expect(event(sink, 'approval_resolved')['reason']).toContain('HTTP 401');
  });
});

describe('a webhook that answers', () => {
  it('approves when the endpoint says so, over a verified signature', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({
      body: '{"verdict":"approved","reason":"on-call said yes"}',
    }));

    const verdict = await gatewayFor(endpoint.url, sink).requestApproval(
      request(),
      new AbortController().signal,
    );

    expect(verdict).toBe('approved');
    expect(endpoint.seen[0]?.verified).toBe(true);
    expect(endpoint.seen[0]?.body).toBe(FIXTURE_BODY);
    expect(event(sink, 'approval_resolved')).toMatchObject({
      verdict: 'approved',
      source: 'webhook',
      reason: 'on-call said yes',
    });
  });

  it('denies when the endpoint says so', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({ body: '{"verdict":"denied","reason":"no"}' }));

    await expect(
      gatewayFor(endpoint.url, sink).requestApproval(request(), new AbortController().signal),
    ).resolves.toBe('denied');
  });

  it('identifies itself and asks for JSON', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({}));

    await gatewayFor(endpoint.url, sink).requestApproval(request(), new AbortController().signal);

    expect(endpoint.seen[0]?.headers['content-type']).toBe('application/json');
    expect(endpoint.seen[0]?.headers['user-agent']).toBe('agentfuse');
  });

  it('never puts the secret on the wire', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({}));

    await gatewayFor(endpoint.url, sink).requestApproval(request(), new AbortController().signal);

    const seen = endpoint.seen[0];
    expect(JSON.stringify(seen?.headers)).not.toContain(SECRET);
    expect(seen?.body).not.toContain(SECRET);
    // Only the MAC, which is what a shared secret is for.
    expect(seen?.signature).toBe(`v1=${FIXTURE_DIGEST}`);
  });

  it('never puts the secret in a diagnostic line', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({ status: 500, body: 'kaboom' }));

    await gatewayFor(endpoint.url, sink).requestApproval(request(), new AbortController().signal);

    // Including on the failure paths, which are where a hastily written log
    // line would dump the whole configuration.
    expect(sink.text).not.toContain(SECRET);
    expect(sink.text).toContain('HTTP 500');
  });
});

describe('a response that cannot be trusted', () => {
  it.each([
    ['a made-up verdict', '{"verdict":"maybe"}', 'must be'],
    ['no verdict at all', '{"ok":true}', 'must be'],
    ['a JSON array', '[{"verdict":"approved"}]', 'not a JSON object'],
    ['not JSON', 'approved', 'not JSON'],
    ['an empty body', '', 'not JSON'],
    ['a bare string', '"approved"', 'not a JSON object'],
  ])('denies on %s rather than guessing', async (_label, body, expected) => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({ body }));

    const verdict = await gatewayFor(endpoint.url, sink).requestApproval(
      request(),
      new AbortController().signal,
    );

    expect(verdict).toBe('denied');
    expect(event(sink, 'approval_resolved')['reason']).toContain(expected);
  });

  it('denies a 204, which has no body to read at all', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({ status: 204, body: '' }));

    const verdict = await gatewayFor(endpoint.url, sink).requestApproval(
      request(),
      new AbortController().signal,
    );

    expect(verdict).toBe('denied');
    expect(event(sink, 'approval_resolved')['reason']).toContain('not JSON');
  });

  it('denies on an HTTP error', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({ status: 503, body: '{"verdict":"approved"}' }));

    await expect(
      gatewayFor(endpoint.url, sink).requestApproval(request(), new AbortController().signal),
    ).resolves.toBe('denied');
  });

  it('denies a body bigger than the cap, while it is arriving', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({
      body: `{"verdict":"approved","pad":"${'x'.repeat(500)}"}`,
    }));

    const verdict = await gatewayFor(endpoint.url, sink, { maxResponseBytes: 64 }).requestApproval(
      request(),
      new AbortController().signal,
    );

    expect(verdict).toBe('denied');
    expect(event(sink, 'approval_resolved')['reason']).toContain('exceeded 64 bytes');
  });

  it('caps at 64 KiB by default', () => {
    expect(MAX_RESPONSE_BYTES).toBe(65_536);
  });

  it('denies rather than following a redirect', async () => {
    // Following one would re-send the signed body to a host the operator never
    // named, and hand it the power to approve the call.
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({
      status: 302,
      headers: { location: 'http://127.0.0.1:1/elsewhere' },
      body: '',
    }));

    await expect(
      gatewayFor(endpoint.url, sink).requestApproval(request(), new AbortController().signal),
    ).resolves.toBe('denied');
  });

  it('denies when there is nothing listening at all', async () => {
    const sink = new StringWriter();

    const verdict = await gatewayFor('http://127.0.0.1:1/nope', sink).requestApproval(
      request(),
      new AbortController().signal,
    );

    // A transport failure is a denial and not a timeout: `on_timeout: allow`
    // must not be convertible into blanket consent by breaking the network.
    expect(verdict).toBe('denied');
    expect(event(sink, 'approval_resolved')['verdict']).toBe('denied');
  });
});

describe('a response that never comes', () => {
  it('times out, which is the one verdict on_timeout may reinterpret', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({ delayMs: 5_000 }));

    const verdict = await gatewayFor(endpoint.url, sink).requestApproval(
      request({ timeoutMs: 120 }),
      new AbortController().signal,
    );

    expect(verdict).toBe('timeout');
    expect(event(sink, 'approval_resolved')).toMatchObject({
      verdict: 'timeout',
      source: 'webhook',
    });
  });

  it('denies when the engine abandons the request', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({ delayMs: 5_000 }));
    const controller = new AbortController();

    const pending = gatewayFor(endpoint.url, sink).requestApproval(request(), controller.signal);
    controller.abort();

    await expect(pending).resolves.toBe('denied');
    expect(event(sink, 'approval_resolved')['reason']).toContain('the session ended');
  });

  it('reports the request it made before waiting', async () => {
    const sink = new StringWriter();
    const endpoint = await receiver(() => ({}));

    await gatewayFor(endpoint.url, sink).requestApproval(request(), new AbortController().signal);

    expect(event(sink, 'approval_posted')).toMatchObject({
      approvalId: '01APPROVAL',
      url: endpoint.url,
    });
  });
});
