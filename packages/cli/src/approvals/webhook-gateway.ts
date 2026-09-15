/**
 * `approvals.gateways: [webhook]` — an HMAC-signed POST, and a verdict back.
 *
 * ## The secret comes from the environment, never from the policy
 *
 * `fusepolicy.yaml` is meant to be committed, diffed and — per ADR-004 —
 * distributed by a Control Plane. So the policy names the *variable*
 * (`approvals.webhook.secret_env`) and the value is read from the environment.
 * A schema that accepted the secret itself would be a schema that invites
 * people to commit it, and the first `git log -p` would publish it.
 *
 * ## The signature
 *
 * `X-AgentFuse-Signature: v1=<hex>` where `<hex>` is
 * `HMAC-SHA256(secret, exact request body bytes)`. The body carries a
 * `timestamp` field, so the timestamp is inside the signed payload rather than
 * beside it in a header: a receiver that rejects stale requests to stop a
 * replay needs the age it checks to be covered by the MAC, otherwise an
 * attacker replays an old body with a fresh header and the check proves
 * nothing.
 *
 * The signature is over the **exact bytes sent**, which is why the body string
 * is serialised once and both signed and posted, rather than being rebuilt by
 * the receiver from parsed JSON. Two JSON serialisers agree on meaning and not
 * on bytes.
 *
 * ## The response is untrusted input
 *
 * It arrives from a network endpoint and it can release a tool call, so:
 * the body is size-capped while it is being read (not after), the shape is
 * validated field by field, redirects are refused outright — following one
 * would re-send the signed body to a host the operator never named — and the
 * whole exchange is bounded by the policy's `approvals.timeout`.
 *
 * Failure directions are deliberate and not interchangeable:
 *
 * | what happened | verdict | why |
 * | --- | --- | --- |
 * | a well-formed `approved` | `approved` | a human said yes |
 * | a well-formed `denied` | `denied` | a human said no |
 * | no answer within the timeout | `timeout` | `approvals.on_timeout` decides |
 * | HTTP error, transport error, redirect, oversized or malformed body | `denied` | fail closed |
 *
 * The last row is the one worth stating: a broken channel is **not** routed
 * through `on_timeout`. An operator who sets `on_timeout: allow` is saying "do
 * not let a slow human block my agent", not "approve everything whenever the
 * network breaks" — and an attacker who can break the network must not be able
 * to convert that setting into blanket consent.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ApprovalAnswer,
  ApprovalGateway,
  ApprovalRequest,
  ApprovalVerdict,
} from '@agentfuse/core';
import type { Diagnostics } from '@agentfuse/proxy';
import { messageOf } from '../errors.js';

/** The header the signature travels in. */
export const SIGNATURE_HEADER = 'X-AgentFuse-Signature';

/** The scheme prefix on that header's value. */
export const SIGNATURE_SCHEME = 'v1';

/** The body version, so a receiver can branch on shape changes. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** The most response body the gateway will read, in bytes. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** The subset of `fetch` this gateway uses, so a test can supply one. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The JSON posted to the endpoint. Also the thing the signature covers. */
export interface WebhookPayload {
  readonly v: typeof WEBHOOK_PAYLOAD_VERSION;
  readonly type: 'approval_request';
  /** Epoch milliseconds. Inside the signed body on purpose; see the module doc. */
  readonly timestamp: number;
  readonly approvalId: string;
  readonly sessionId: string;
  readonly server: string;
  readonly tool: string;
  /** Already reduced to a fingerprint when `report.redact_args` is on. */
  readonly argsPreview: string;
  readonly reasons: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly timeoutMs: number;
}

/** How a {@link WebhookApprovalGateway} is built. */
export interface WebhookGatewayOptions {
  readonly url: string;
  /** The shared secret, already read out of the environment. */
  readonly secret: string;
  readonly diagnostics: Diagnostics;
  /** Injected for tests. Node 20 has `fetch` globally; no dependency is added. */
  readonly fetch?: FetchLike | undefined;
  /** Injected for tests. */
  readonly now?: (() => number) | undefined;
  readonly maxResponseBytes?: number | undefined;
  /** Identifies this build in the `User-Agent`. */
  readonly userAgent?: string | undefined;
}

/** `HMAC-SHA256(secret, body)`, hex. The value of the signature header, unprefixed. */
export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** The full header value, scheme included. */
export function signatureHeaderValue(secret: string, body: string): string {
  return `${SIGNATURE_SCHEME}=${signBody(secret, body)}`;
}

/**
 * Whether a header value matches a body under a secret.
 *
 * Exported because a receiver has to do exactly this, and because the property
 * worth testing — a tampered body fails — is a property of the pair. Compared
 * with `timingSafeEqual` on equal-length buffers: the digests are fixed-length
 * hex, so a length mismatch is a malformed header rather than a near miss.
 */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (header === undefined) return false;
  const expected = signatureHeaderValue(secret, body);
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(expected, 'utf8'));
}

/** Builds the body for one request. */
export function webhookPayload(request: ApprovalRequest, now: number): WebhookPayload {
  return {
    v: WEBHOOK_PAYLOAD_VERSION,
    type: 'approval_request',
    timestamp: now,
    approvalId: request.approvalId,
    sessionId: request.sessionId,
    server: request.serverName,
    tool: request.toolName,
    argsPreview: request.argsPreview,
    // Code and message only. A reason's `evidence` is assembled by the guards
    // and is not needed to decide; sending less over the wire is free.
    reasons: request.reasons.map((reason) => ({ code: reason.code, message: reason.message })),
    timeoutMs: request.timeoutMs,
  };
}

/** What a validated response says. */
export type WebhookAnswer =
  | { readonly ok: true; readonly verdict: 'approved' | 'denied'; readonly reason: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validates the endpoint's answer.
 *
 * Total, and unforgiving: this is the value that decides whether a call the
 * policy stopped goes ahead. Anything that is not exactly the documented shape
 * is an error, and an error is a denial.
 */
export function readAnswer(text: string): WebhookAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the response body is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'the response body is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const verdict = record['verdict'];
  if (verdict !== 'approved' && verdict !== 'denied') {
    return {
      ok: false,
      error: `the response verdict must be "approved" or "denied", not ${JSON.stringify(verdict)}`,
    };
  }
  const reason = record['reason'];
  return { ok: true, verdict, reason: typeof reason === 'string' ? reason : '' };
}

/**
 * Reads a response body, giving up at `limit` bytes.
 *
 * Capped **while** reading rather than after: `await response.text()` on an
 * endpoint that streams for ever is an out-of-memory error whose trigger is the
 * network.
 */
export async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/** Asks an HTTP endpoint. */
export class WebhookApprovalGateway implements ApprovalGateway {
  readonly #url: string;
  readonly #secret: string;
  readonly #diagnostics: Diagnostics;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #limit: number;
  readonly #userAgent: string;

  constructor(options: WebhookGatewayOptions) {
    this.#url = options.url;
    this.#secret = options.secret;
    this.#diagnostics = options.diagnostics;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#limit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.#userAgent = options.userAgent ?? 'agentfuse';
  }

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    const body = JSON.stringify(webhookPayload(request, this.#now()));
    const controller = new AbortController();
    let expired = false;

    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, request.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    this.#diagnostics.emit('approval_posted', {
      approvalId: request.approvalId,
      sessionId: request.sessionId,
      url: this.#url,
      timeoutMs: request.timeoutMs,
    });

    try {
      return await this.#ask(request, body, controller.signal);
    } catch (error) {
      if (expired) {
        return this.#resolved(request, 'timeout', 'the endpoint did not answer in time');
      }
      // An abort from the engine means the session is gone; a denial is the one
      // answer that cannot be re-routed by `on_timeout`. Everything else here
      // is a transport failure, which fails closed for the same reason.
      return this.#resolved(
        request,
        'denied',
        signal.aborted ? 'the session ended' : messageOf(error),
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async #ask(request: ApprovalRequest, body: string, signal: AbortSignal): Promise<ApprovalAnswer> {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': this.#userAgent,
        [SIGNATURE_HEADER]: signatureHeaderValue(this.#secret, body),
      },
      body,
      // Following one would re-send the signed body to a host the operator
      // never named, and hand the verdict to it.
      redirect: 'error',
      signal,
    });

    if (!response.ok) {
      return this.#resolved(request, 'denied', `the endpoint answered HTTP ${response.status}`);
    }

    const text = await readCapped(response, this.#limit);
    if (text === undefined) {
      return this.#resolved(request, 'denied', `the response body exceeded ${this.#limit} bytes`);
    }

    const answer = readAnswer(text);
    if (!answer.ok) return this.#resolved(request, 'denied', answer.error);
    return this.#resolved(request, answer.verdict, answer.reason);
  }

  /**
   * Logs how this ended and hands the same words back to the engine.
   *
   * One place, so the diagnostic line and the audit record cannot disagree.
   * The reason is whatever the endpoint sent or whatever went wrong with it —
   * untrusted either way, and sanitised by the engine before it is recorded.
   * The secret is not in it and cannot be: nothing here reads the secret except
   * the HMAC.
   */
  #resolved(request: ApprovalRequest, verdict: ApprovalVerdict, reason: string): ApprovalAnswer {
    this.#diagnostics.emit('approval_resolved', {
      approvalId: request.approvalId,
      sessionId: request.sessionId,
      verdict,
      source: 'webhook',
      ...(reason === '' ? undefined : { reason }),
    });
    return { verdict, ...(reason === '' ? undefined : { reason }) };
  }
}
