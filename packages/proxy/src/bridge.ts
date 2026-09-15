/**
 * The `Server` + `Client` pair, and the seams everything else hangs off.
 *
 * ## Topology: one upstream `Client` per downstream connection
 *
 * Multiplexing N downstream connections onto one upstream connection breaks
 * sampling, elicitation, roots and multi-round-trip requests, because in the
 * legacy era the server pushes those *without naming the caller*: a
 * `sampling/createMessage` arriving on a shared upstream connection cannot be
 * attributed to the agent that provoked it. A bridge is therefore one pair, and
 * a serving entry makes one bridge per connection.
 *
 * ## Only two methods are ours
 *
 * ```
 * downstream ⇄ Server ── explicit: tools/call, tools/list
 *                     ── fallbackRequestHandler      → client.request
 *                     ── fallbackNotificationHandler → client.notification
 * upstream   ⇄ Client ── fallbackRequestHandler      → server.request
 *                     ── fallbackNotificationHandler → server.notification
 * ```
 *
 * Everything else passes through blind, with no schema of ours in the way. The
 * proxy is not a validator: a method it has never heard of has to work.
 *
 * ## What the SDK answers locally, and why that is not a bug
 *
 * The low-level `Server` is not a blank slate. Its constructor — and
 * `Protocol`'s — install handlers the proxy does not get to see:
 *
 * | method | who answers | why it is fine |
 * | --- | --- | --- |
 * | `initialize` | `Server` | The handshake *is* the connection. It has to be answered locally, or the SDK never learns its own era and every later request is decoded with the wrong codec. The bridge answers it with the identity and capabilities it mirrored from upstream, which is more truthful than blind forwarding: the downstream client negotiates against the real server's capabilities. |
 * | `server/discover` | the serving entry | Same reasoning, modern era. `serveStdio` installs the handler and answers from the mirrored capabilities. |
 * | `ping` | `Protocol` | A liveness check on the connection it was sent on. The proxy answering it is honest — the proxy *is* alive. Upstream liveness is a different question and not one `ping` asks. |
 * | `notifications/cancelled` | `Protocol` | Aborts the matching request handler, which is exactly what makes cancellation propagate upstream for free. See {@link remap}. |
 * | `notifications/progress` | `Protocol` | Routed to the `onprogress` callback of the request that asked for it. See {@link remap}. |
 * | `subscriptions/listen` | `serveStdio` | The entry owns the subscription router on a modern stdio connection. |
 *
 * This is recorded rather than worked around: the alternatives all require SDK
 * internals (`setNegotiatedProtocolVersion`, `installModernOnlyHandlers`) that
 * are not part of the public surface.
 *
 * This module imports neither `@agentfuse/core` nor any file that does. See
 * `boundary.test.ts`.
 */

import type { Client } from '@modelcontextprotocol/client';
import {
  type CallToolRequest,
  type CallToolResult,
  type Implementation,
  isCallToolResult,
  type JSONRPCRequest,
  type ListToolsResult,
  type Notification,
  type RequestOptions,
  type Result,
  Server,
  type ServerCapabilities,
  type ServerContext,
  type StandardSchemaV1,
} from '@modelcontextprotocol/server';
import type { MetaBag } from './era.js';
import {
  type ClientIdentity,
  mergeMeta,
  type Params,
  RequestRemap,
  splitProgressToken,
  upstreamParams,
} from './remap.js';

/**
 * A result schema that accepts anything.
 *
 * `Protocol.request` resolves a spec method's result schema from the era
 * registry, but a proxy forwards methods it has never heard of, and for those
 * the SDK demands an explicit schema. Standard Schema is a three-property
 * interface, so the honest "do not validate" schema is ten lines and no new
 * dependency — which matters, because this package deliberately does not
 * declare `zod`.
 *
 * Passing it for spec methods too is deliberate: validating a forwarded result
 * would make the proxy reject a response the agent's own client would have
 * accepted, and "transparent" has to mean transparent.
 */
export const PASSTHROUGH_RESULT: StandardSchemaV1<unknown, Result> = {
  '~standard': {
    version: 1,
    vendor: 'agentfuse',
    validate: (value: unknown) => ({ value: value as Result }),
  },
};

/** A `tools/call` the bridge has intercepted and not yet forwarded. */
export interface GuardedToolCall {
  /** The request exactly as the agent sent it. */
  readonly request: CallToolRequest;
  /** The SDK's handler context: request id, abort signal, related-message sends. */
  readonly ctx: ServerContext;
  /**
   * `_meta` with the lifted `io.modelcontextprotocol/*` envelope merged back
   * in, so a reader does not have to know which era stripped what.
   */
  readonly meta: MetaBag | undefined;
  /**
   * Forwards the call upstream and resolves with the upstream's result.
   *
   * Calling it is the decision: a gate that returns without calling it has
   * blocked the call, and nothing reached the guarded server.
   */
  forward(): Promise<CallToolResult>;
}

/**
 * The guarded path.
 *
 * `tools-call.ts` implements this against `@agentfuse/core`; the bridge only
 * knows it is a function that turns an intercepted call into a result.
 */
export type ToolCallGate = (call: GuardedToolCall) => Promise<CallToolResult>;

/** How a {@link Bridge} is built. */
export interface BridgeOptions {
  /**
   * The upstream connection, already connected.
   *
   * It must be connected first: the bridge mirrors the upstream's identity and
   * capabilities into the `Server` it presents downstream, and those are only
   * known after the upstream handshake.
   */
  client: Client;
  /** Identity to present downstream. Normally the upstream's, verbatim. */
  serverInfo: Implementation;
  /** Capabilities to present downstream. Normally the upstream's, verbatim. */
  capabilities?: ServerCapabilities | undefined;
  /** `instructions` to present downstream. Normally the upstream's, verbatim. */
  instructions?: string | undefined;
  /** The guarded `tools/call` path. */
  onToolCall: ToolCallGate;
  /** Out-of-band error reporting. Never alters what goes on the wire. */
  onError?: ((error: Error) => void) | undefined;
  /**
   * Per-request timeout for forwarded requests, in milliseconds.
   *
   * Omitted means the SDK's own 60 s default. Every forwarded request is sent
   * with `resetTimeoutOnProgress`, so a tool that reports progress is not
   * killed by a proxy timeout the agent never asked for.
   */
  requestTimeoutMs?: number | undefined;
}

/** A running proxy: the two halves and the bookkeeping between them. */
export interface Bridge {
  /** Downstream face: what the agent connects to. */
  readonly server: Server;
  /** Upstream face: the real tool server being guarded. */
  readonly client: Client;
  /** In-flight request bookkeeping. Asserted on by the leak tests. */
  readonly remap: RequestRemap;
  /** Closes both halves. Safe to call twice. */
  close(): Promise<void>;
}

/** Whether a mirrored capability set lets the `Server` own `tools/*`. */
function servesTools(capabilities: ServerCapabilities | undefined): boolean {
  return capabilities?.tools !== undefined;
}

/**
 * Wires a downstream `Server` to an upstream `Client`.
 *
 * The upstream client must already be connected; see {@link BridgeOptions.client}.
 */
export function createBridge(options: BridgeOptions): Bridge {
  const { client, onToolCall } = options;
  const remap = new RequestRemap();

  const server = new Server(options.serverInfo, {
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : undefined),
    ...(options.instructions !== undefined ? { instructions: options.instructions } : undefined),
  });

  const report = (error: unknown): void => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  /**
   * The caller's self-reported identity as the `initialize` handshake gave it.
   *
   * Read through a closure rather than captured once, because on a legacy
   * connection the handshake happens after the bridge is built. `_meta` on a
   * modern-era request wins over this; see `forwardedMeta`.
   */
  const handshakeClientInfo = (): ClientIdentity | undefined => {
    // Deprecated in favour of the per-request envelope, which only the modern
    // era has. On a legacy connection this accessor is the only source there
    // is, and the SDK keeps it functional for exactly that reason.
    const identity = server.getClientVersion();
    return identity === undefined ? undefined : (identity as ClientIdentity);
  };

  /**
   * Forwards one request upstream, translating the progress plumbing.
   *
   * - the agent's `progressToken` is peeled off (the SDK mints its own for the
   *   outbound leg) and stamped back onto every notification re-emitted
   *   downstream, related to the originating request so Streamable HTTP can
   *   place it;
   * - the agent's identity and trace context are grafted onto the outbound
   *   `_meta`, so the guarded server sees the real caller;
   * - the handler's `AbortSignal` is chained in, which is what makes
   *   `notifications/cancelled` propagate across the proxy;
   * - the in-flight entry is released in a `finally`, so no path — result,
   *   error, or cancellation — can leak one.
   */
  const forward = async (
    method: string,
    rawParams: Params | undefined,
    ctx: ServerContext,
    meta: MetaBag | undefined,
  ): Promise<Result> => {
    const { params, progressToken } = splitProgressToken(rawParams);
    const outbound = upstreamParams(params, meta, handshakeClientInfo());
    const downstreamRequestId = ctx.mcpReq.id;
    remap.begin(downstreamRequestId, progressToken);

    const requestOptions: RequestOptions = {
      signal: ctx.mcpReq.signal,
      resetTimeoutOnProgress: true,
      // An `input_required` result is the upstream's business, not the proxy's:
      // auto-fulfilling it here would answer the guarded server with the
      // *proxy's* (empty) elicitation handlers instead of the agent's.
      allowInputRequired: true,
      ...(options.requestTimeoutMs !== undefined
        ? { timeout: options.requestTimeoutMs }
        : undefined),
      ...(progressToken !== undefined
        ? {
            onprogress: (progress) => {
              const token = remap.progressTokenFor(downstreamRequestId);
              // `undefined` means the request already settled; a notification
              // the agent can no longer place is worse than none.
              if (token === undefined) return;
              ctx.mcpReq
                .notify({
                  method: 'notifications/progress',
                  params: { ...progress, progressToken: token },
                })
                .catch(report);
            },
          }
        : undefined),
    };

    try {
      return await client.request(
        { method, ...(outbound !== undefined ? { params: outbound } : undefined) },
        PASSTHROUGH_RESULT,
        requestOptions,
      );
    } finally {
      remap.settle(downstreamRequestId);
    }
  };

  const metaOf = (ctx: ServerContext): MetaBag | undefined =>
    mergeMeta(ctx.mcpReq._meta as MetaBag | undefined, ctx.mcpReq.envelope as MetaBag | undefined);

  const guardToolCall = async (
    request: CallToolRequest,
    ctx: ServerContext,
  ): Promise<CallToolResult> => {
    const meta = metaOf(ctx);
    return onToolCall({
      request,
      ctx,
      meta,
      forward: async () => {
        const result = await forward('tools/call', request.params as Params, ctx, meta);
        if (!isCallToolResult(result)) {
          throw new Error(
            `The upstream server answered tools/call with something that is not a CallToolResult: ${JSON.stringify(result).slice(0, 200)}`,
          );
        }
        return result;
      },
    });
  };

  // `Server` refuses a `tools/*` handler unless the mirrored capabilities
  // declare `tools`. An upstream that serves tools without declaring them is
  // violating the spec, but the fallback below still routes `tools/call`
  // through the gate so that violation cannot become an unguarded hole.
  if (servesTools(options.capabilities)) {
    server.setRequestHandler('tools/call', guardToolCall);
    server.setRequestHandler('tools/list', async (request, ctx) => {
      // Forwarded verbatim, cursor and all. Filtering the advertised list by
      // policy is a real idea — advertising a tool that will always be denied
      // invites the loop AgentFuse exists to stop — but it changes what the
      // agent can see, and that is a product decision with its own ADR, not a
      // side effect of this seam.
      const result = await forward(
        'tools/list',
        request.params as Params | undefined,
        ctx,
        metaOf(ctx),
      );
      return result as ListToolsResult;
    });
  }

  server.fallbackRequestHandler = async (request: JSONRPCRequest, ctx: ServerContext) => {
    if (request.method === 'tools/call') {
      return guardToolCall(request as unknown as CallToolRequest, ctx);
    }
    return forward(request.method, request.params as Params | undefined, ctx, metaOf(ctx));
  };

  server.fallbackNotificationHandler = async (notification: Notification) => {
    await client.notification(notification);
  };

  // The reverse direction: sampling, elicitation and roots in the legacy era,
  // where the guarded server pushes a request at whoever is downstream. This is
  // the reason the topology is one pair per connection.
  client.fallbackRequestHandler = async (request) =>
    server.request(request as unknown as JSONRPCRequest, PASSTHROUGH_RESULT);

  client.fallbackNotificationHandler = async (notification) => {
    await server.notification(notification as Notification);
  };

  let closed = false;
  return {
    server,
    client,
    remap,
    close: async () => {
      if (closed) return;
      closed = true;
      remap.clear();
      // Both, always, and in this order: the downstream face stops accepting
      // work before the upstream connection it would have needed goes away.
      const results = await Promise.allSettled([server.close(), client.close()]);
      for (const result of results) if (result.status === 'rejected') report(result.reason);
    },
  };
}
