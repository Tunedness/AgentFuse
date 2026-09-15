/**
 * A minimal AgentFuse approval webhook receiver.
 *
 * Point a policy at it:
 *
 *     approvals:
 *       gateways: [webhook]
 *       webhook:
 *         url: http://127.0.0.1:8787/approvals
 *         secret_env: AGENTFUSE_WEBHOOK_SECRET
 *
 * and run it with the same secret:
 *
 *     AGENTFUSE_WEBHOOK_SECRET=... node examples/approval-webhook.mjs
 *
 * Node only, no dependencies. Replace `decide()` with whatever actually asks a
 * person — a Slack message, a pager, a queue — and answer when they do.
 *
 * ## The three things a receiver must get right
 *
 * 1. **Verify the signature over the raw body bytes**, before parsing. The
 *    header is `X-AgentFuse-Signature: v1=<hex>` where `<hex>` is
 *    `HMAC-SHA256(secret, body)`. Re-serialising the parsed JSON and signing
 *    that instead is the classic way to get this wrong: two JSON serialisers
 *    agree on meaning, not on bytes.
 * 2. **Compare in constant time**, and reject a length mismatch before
 *    comparing — `timingSafeEqual` throws on unequal lengths.
 * 3. **Check the age of `timestamp`**, which is inside the signed body for
 *    exactly this reason: a timestamp in an unsigned header would let anybody
 *    replay yesterday's approved request with a fresh one.
 *
 * The answer is `{"verdict":"approved"|"denied","reason":"..."}`. Anything
 * else — a different shape, an HTTP error, a body over 64 KiB, a redirect, or
 * no answer within `approvals.timeout` — is treated by AgentFuse as a refusal.
 * There is no response shape that fails open.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const SIGNATURE_HEADER = 'x-agentfuse-signature';
const PORT = Number(process.env.PORT ?? '8787');

/** How old a request may be before it is treated as a replay. */
const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Whether a body and header match under a secret.
 *
 * @param {string} secret
 * @param {string} body raw request bytes, as received
 * @param {string | undefined} header the `X-AgentFuse-Signature` value
 * @returns {boolean}
 */
export function verify(secret, body, header) {
  if (typeof header !== 'string') return false;
  const expected = `v1=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(expected, 'utf8'));
}

/**
 * Where a real receiver asks a person.
 *
 * Returning promptly with `denied` is a perfectly good implementation: an
 * approval channel that refuses everything is safe, if unhelpful. Returning
 * nothing at all until somebody answers is the intended one — AgentFuse holds
 * the request open until `approvals.timeout`.
 *
 * @param {{ approvalId: string, sessionId: string, server: string, tool: string, argsPreview: string, reasons: Array<{ code: string, message: string }> }} payload
 * @returns {Promise<{ verdict: 'approved' | 'denied', reason: string }>}
 */
async function decide(payload) {
  process.stdout.write(
    `approval ${payload.approvalId}: ${payload.tool} on ${payload.server} — ${payload.argsPreview}\n`,
  );
  for (const reason of payload.reasons)
    process.stdout.write(`  ${reason.code}: ${reason.message}\n`);
  return { verdict: 'denied', reason: 'this example refuses everything; edit decide()' };
}

/**
 * Starts the receiver.
 *
 * @param {string} secret
 * @param {number} port
 */
export function listen(secret, port = PORT) {
  return createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // A receiver has the same reason to cap a body as AgentFuse does.
      if (size > 1_000_000) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const answer = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (req.method !== 'POST') return answer(405, { error: 'POST only' });
      if (!verify(secret, body, req.headers[SIGNATURE_HEADER])) {
        return answer(401, { error: 'bad signature' });
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return answer(400, { error: 'not JSON' });
      }
      if (Math.abs(Date.now() - payload.timestamp) > MAX_AGE_MS) {
        return answer(400, { error: 'stale request' });
      }

      answer(200, await decide(payload));
    });
  }).listen(port, '127.0.0.1', () => {
    process.stdout.write(`listening on http://127.0.0.1:${port}/approvals\n`);
  });
}

// Only when run directly, so a test can import `verify` without starting a
// server — and so this file stays checkable rather than merely readable.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.AGENTFUSE_WEBHOOK_SECRET;
  if (secret === undefined || secret === '') {
    process.stderr.write('set AGENTFUSE_WEBHOOK_SECRET to the same value the policy names\n');
    process.exitCode = 2;
  } else {
    listen(secret);
  }
}
