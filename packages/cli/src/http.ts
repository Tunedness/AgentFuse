/**
 * A `node:http` server that speaks the Fetch API to whatever it wraps.
 *
 * ## Why this exists rather than a dependency
 *
 * The SDK's HTTP entry, `createMcpHandler`, is web-standard: it answers
 * `(Request) => Promise<Response>`. Node frameworks are expected to bridge that
 * with `toNodeHandler` from `@modelcontextprotocol/node`, which is not
 * installed — and installing it would pull `@hono/node-server` transitively
 * into a published CLI whose whole pitch is being a frictionless drop-in. Node
 * 20 already ships global `Request`, `Response`, `Headers` and
 * `ReadableStream`, so the bridge is this file instead.
 *
 * The handler shape is deliberately the one `createMcpHandler().fetch` has, so
 * the P1 HTTP gateway is a substitution here rather than a rewrite. The one
 * addition is {@link RequestContext}: a web-standard `Request` has no notion of
 * a remote address, and ADR-006's bottom rung needs one.
 *
 * ## What it does with the four things that are easy to get wrong
 *
 * - **Bodies are bounded.** An unbounded read is a memory bug with a network
 *   trigger. Over the limit is `413`, and the handler is never called.
 * - **Responses stream.** The body is pumped from its `ReadableStream` with
 *   backpressure honoured rather than buffered, because an SSE response — which
 *   is how the modern era delivers a call that reports progress — never ends.
 * - **A disconnect aborts the handler.** The `Request` carries an
 *   `AbortSignal` fired when the socket closes early. In the modern era closing
 *   the per-request stream *is* the cancellation signal, so this is the wire on
 *   which a cancelled tool call actually gets cancelled.
 * - **A handler that throws still answers.** `500` and one diagnostic, never a
 *   hung socket.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the transport knows and a `Request` cannot carry. */
export interface RequestContext {
  /**
   * The peer's address, for ADR-006's bottom rung.
   *
   * Straight off the socket, deliberately not read from `X-Forwarded-For`:
   * behind a load balancer the header an operator should trust is theirs to
   * nominate, and trusting one by default lets any caller choose its own
   * session by sending a header.
   */
  readonly remoteAddress: string | undefined;
}

/** The handler shape, chosen to match `createMcpHandler().fetch`. */
export type FetchHandler = (request: Request, context: RequestContext) => Promise<Response>;

/** How a {@link startHttpEndpoint} behaves. */
export interface HttpEndpointOptions {
  readonly handler: FetchHandler;
  /** Address to bind. */
  readonly host: string;
  /** Port to bind. `0` asks the OS for a free one, which is what tests use. */
  readonly port: number;
  /** Largest request body accepted, in bytes. */
  readonly maxBodyBytes?: number;
  /** Out-of-band error reporting. Never changes what goes on the wire. */
  readonly onError?: ((error: Error) => void) | undefined;
}

/** A listening endpoint. */
export interface HttpEndpoint {
  /** The port actually bound, which differs from the request when it was `0`. */
  readonly port: number;
  /** The address actually bound. */
  readonly host: string;
  /** Stops listening and waits for the sockets to go. */
  close(): Promise<void>;
}

/** Default body limit. Generous for JSON-RPC, far below a memory problem. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Methods that may not carry a body, per the Fetch specification. */
const BODILESS = new Set(['GET', 'HEAD']);

/** Reads a request body, or rejects once it is too large. */
async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) throw new BodyTooLarge(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Raised by {@link readBody}, answered with `413`. */
class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * Turns the request's headers into a `Headers`, keeping repeated values.
 *
 * Built from `rawHeaders` — the flat name/value list off the wire — rather than
 * from the parsed bag. The bag joins most repeats into one string and keeps
 * `set-cookie` as an array, so reading it means handling two shapes and an
 * `undefined` that cannot occur; appending the raw pairs preserves every value
 * of every header with none of that.
 */
function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    // Pairs, by construction; the indexed reads cannot be holes.
    headers.append(raw[index] as string, raw[index + 1] as string);
  }
  return headers;
}

/**
 * Awaits a drain when the socket is full, so a stream cannot outrun it.
 *
 * The rejecting arm is the one a test cannot force without a race — it needs a
 * write already in flight when the socket dies, and {@link send} checks for a
 * destroyed response before every write. It is still the arm that matters: a
 * write that failed has to stop the pump rather than be swallowed.
 */
function write(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    response.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/** Copies a Fetch `Response` onto a Node one. */
async function send(response: Response, node: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    // `getSetCookie` is the only header that legitimately repeats here.
    headers[name] = name === 'set-cookie' ? response.headers.getSetCookie() : value;
  });
  node.writeHead(response.status, headers);

  if (response.body === null) {
    node.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (node.destroyed) {
        // The caller went away mid-stream. The producer is told, so a source
        // that would otherwise go on generating frames for nobody stops.
        await reader.cancel();
        break;
      }
      await write(node, value);
    }
  } finally {
    reader.releaseLock();
    node.end();
  }
}

/** Answers a request the bridge refused before the handler saw it. */
function refuse(node: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${message}\n`, 'utf8');
  node.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
  });
  node.end(body);
}

/** Starts an HTTP endpoint in front of a Fetch handler. */
export async function startHttpEndpoint(options: HttpEndpointOptions): Promise<HttpEndpoint> {
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const report = (error: unknown): void => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const serveOne = async (node: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Fired when the peer goes away before the response finished, which in the
    // modern era is exactly how a tool call is cancelled.
    const aborted = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) aborted.abort();
    });

    // `method` and `url` are always present on a server request; the optional
    // types belong to `IncomingMessage`'s client-side shape. Asserted rather
    // than defaulted, so there is no arm nothing can reach.
    const method = node.method as string;
    let body: Uint8Array | undefined;
    if (!BODILESS.has(method)) {
      try {
        body = await readBody(node, limit);
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          refuse(response, 413, error.message);
          return;
        }
        report(error);
        refuse(response, 400, 'could not read the request body');
        return;
      }
    }

    // `host` is absent on HTTP/1.0; the bound address is the honest stand-in,
    // and only the path and query are ever read from the result.
    const authority = node.headers.host ?? `${options.host}:${options.port}`;
    const request = new Request(`http://${authority}${node.url as string}`, {
      method,
      headers: headersOf(node),
      signal: aborted.signal,
      ...(body !== undefined && body.byteLength > 0 ? { body } : undefined),
    });

    try {
      const answer = await options.handler(request, { remoteAddress: node.socket.remoteAddress });
      await send(answer, response);
    } catch (error) {
      report(error);
      if (!response.headersSent) refuse(response, 500, 'the endpoint failed to handle the request');
      else response.end();
    }
  };

  const server: Server = createServer((node, response) => {
    void serveOne(node, response);
  });
  server.on('error', report);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // A listening TCP server always reports an `AddressInfo`; the `string` arm of
  // the signature is for a Unix socket, which this never binds. Asserted rather
  // than branched on, so there is no arm nothing can reach.
  const bound = server.address() as AddressInfo;

  return {
    port: bound.port,
    host: bound.address,
    close: () =>
      new Promise<void>((resolve) => {
        // `closeAllConnections` rather than a bare `close`: a keep-alive socket
        // nobody is using would otherwise hold the process open, and a shutting
        // down endpoint has to actually shut down.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
