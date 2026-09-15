import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_BODY_BYTES,
  type FetchHandler,
  type HttpEndpoint,
  startHttpEndpoint,
} from './http.js';

/**
 * The bridge is tested over a real socket, with `fetch` as the client.
 *
 * Nothing here is mocked, deliberately: the whole point of this file is the
 * translation between Node's streams and the Fetch API, so a test that faked
 * either side would be testing the fake. Every endpoint binds port `0` and asks
 * the OS which port it got.
 */

let endpoints: HttpEndpoint[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

async function listen(
  handler: FetchHandler,
  options: { maxBodyBytes?: number; onError?: (error: Error) => void } = {},
): Promise<string> {
  const endpoint = await startHttpEndpoint({
    handler,
    host: '127.0.0.1',
    port: 0,
    ...options,
  });
  endpoints.push(endpoint);
  return `http://127.0.0.1:${endpoint.port}`;
}

function portOf(base: string): number {
  return Number(new URL(base).port);
}

/**
 * Sends a request `fetch` will not send, and waits for the answer.
 *
 * Two cases need it: a repeated `set-cookie` request header, which `fetch`
 * treats as forbidden, and an HTTP/1.0 request line with no `Host` at all.
 */
async function raw(base: string, request: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(portOf(base), '127.0.0.1', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    // HTTP/1.1 keeps the socket open after the response; the answer is complete
    // once the terminating chunk of the body has arrived.
    socket.setTimeout(200, () => socket.destroy());
  });
}

describe('the node to fetch bridge', () => {
  it('reports the port the OS actually gave it', async () => {
    const endpoint = await startHttpEndpoint({
      handler: async () => new Response('ok'),
      host: '127.0.0.1',
      port: 0,
    });
    endpoints.push(endpoint);

    expect(endpoint.port).toBeGreaterThan(0);
    expect(endpoint.host).toBe('127.0.0.1');
  });

  it('hands the handler the method, the path, the query and the headers', async () => {
    let seen: Request | undefined;
    const base = await listen(async (request) => {
      seen = request;
      return new Response('ok');
    });

    await fetch(`${base}/mcp?probe=1`, {
      method: 'POST',
      headers: { 'x-one': 'a', 'content-type': 'application/json' },
      body: '{}',
    });

    expect(seen?.method).toBe('POST');
    expect(new URL(seen?.url ?? '').pathname).toBe('/mcp');
    expect(new URL(seen?.url ?? '').searchParams.get('probe')).toBe('1');
    expect(seen?.headers.get('x-one')).toBe('a');
  });

  it('joins a repeated header the way Node hands it over', async () => {
    let joined: string | null = null;
    const base = await listen(async (request) => {
      joined = request.headers.get('accept');
      return new Response('ok');
    });

    await fetch(`${base}/`, { headers: { accept: 'text/plain, application/json' } });

    expect(joined).toBe('text/plain, application/json');
  });

  it('keeps every value of the one header Node hands over as an array', async () => {
    let seen: string[] = [];
    const base = await listen(async (request) => {
      seen = request.headers.getSetCookie();
      return new Response('ok');
    });

    // `set-cookie` is the single header Node does not join, and `fetch` will
    // not send it at all, so this goes out over a raw client.
    await raw(base, 'GET / HTTP/1.1\r\nHost: x\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n');

    expect(seen).toEqual(['a=1', 'b=2']);
  });

  it('sends every value of a repeated response header', async () => {
    const base = await listen(
      async () =>
        new Response('ok', {
          headers: [
            ['set-cookie', 'one=1'],
            ['set-cookie', 'two=2'],
          ],
        }),
    );

    const answer = await fetch(`${base}/`);

    expect(answer.headers.getSetCookie()).toEqual(['one=1', 'two=2']);
  });

  it('serves a request with no Host header at all', async () => {
    let path: string | undefined;
    const base = await listen(async (request) => {
      path = new URL(request.url).pathname;
      return new Response('ok');
    });

    // HTTP/1.0 has no Host, and a `Request` must still be constructible: only
    // the path and the query are ever read back out of the URL.
    await raw(base, 'GET /still-works HTTP/1.0\r\n\r\n');

    expect(path).toBe('/still-works');
  });

  it('serves a POST with no body', async () => {
    let length: number | undefined;
    const base = await listen(async (request) => {
      length = (await request.arrayBuffer()).byteLength;
      return new Response('ok');
    });

    await fetch(`${base}/`, { method: 'POST' });

    expect(length).toBe(0);
  });

  it('reports a body it could not finish reading', async () => {
    const errors: string[] = [];
    let called = 0;
    const base = await listen(
      async () => {
        called += 1;
        return new Response('ok');
      },
      { onError: (error) => errors.push(error.name) },
    );

    // Promises a hundred bytes, sends ten, then vanishes.
    await new Promise<void>((resolve) => {
      const socket = connect(portOf(base), '127.0.0.1', () => {
        socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n0123456789');
        setTimeout(() => {
          socket.destroy();
          setTimeout(resolve, 30);
        }, 10);
      });
    });

    expect(called).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('gives the handler the request body', async () => {
    let body: unknown;
    const base = await listen(async (request) => {
      body = await request.json();
      return new Response('ok');
    });

    await fetch(`${base}/`, { method: 'POST', body: '{"hello":"world"}' });

    expect(body).toEqual({ hello: 'world' });
  });

  it('sends a body of exactly the bytes the handler returned', async () => {
    const base = await listen(async () => new Response(new Uint8Array([0xff, 0x00, 0xfe])));

    const answer = await fetch(`${base}/`);

    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(new Uint8Array([0xff, 0, 0xfe]));
  });

  it('copies the status and the headers back', async () => {
    const base = await listen(
      async () => new Response('nope', { status: 418, headers: { 'x-brew': 'tea' } }),
    );

    const answer = await fetch(`${base}/`);

    expect(answer.status).toBe(418);
    expect(answer.headers.get('x-brew')).toBe('tea');
  });

  it('answers a response with no body at all', async () => {
    const base = await listen(async () => new Response(null, { status: 202 }));

    const answer = await fetch(`${base}/`, { method: 'POST', body: 'x' });

    expect(answer.status).toBe(202);
    expect(await answer.text()).toBe('');
  });

  it('streams a response rather than buffering it', async () => {
    // An SSE response never ends, so a bridge that waited for the whole body
    // would hang the request the modern era delivers progress on.
    const base = await listen(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: one\n\n'));
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('event: two\n\n'));
                controller.close();
              }, 5);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    const answer = await fetch(`${base}/`);
    const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();

    // The first frame arrives before the second has been produced.
    expect(new TextDecoder().decode(first.value)).toBe('event: one\n\n');

    const rest: string[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest.push(new TextDecoder().decode(chunk.value));
    }
    expect(rest.join('')).toBe('event: two\n\n');
  });

  it('refuses a body over the limit without calling the handler', async () => {
    let called = 0;
    const base = await listen(
      async () => {
        called += 1;
        return new Response('ok');
      },
      { maxBodyBytes: 8 },
    );

    const answer = await fetch(`${base}/`, { method: 'POST', body: 'x'.repeat(64) });

    expect(answer.status).toBe(413);
    expect(await answer.text()).toContain('exceeds 8 bytes');
    expect(called).toBe(0);
  });

  it('has a limit that is generous for JSON-RPC and far below a memory problem', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
  });

  it('answers 500 and reports when the handler throws', async () => {
    const errors: string[] = [];
    const base = await listen(
      async () => {
        throw new Error('the handler fell over');
      },
      { onError: (error) => errors.push(error.message) },
    );

    const answer = await fetch(`${base}/`);

    expect(answer.status).toBe(500);
    expect(await answer.text()).toContain('failed to handle');
    expect(errors).toEqual(['the handler fell over']);
  });

  it('reports a handler that threw something that is not an Error', async () => {
    const errors: string[] = [];
    const base = await listen(
      async () => {
        // A non-Error throw is the case `messageOf` exists for.
        throw 'a string';
      },
      { onError: (error) => errors.push(error.message) },
    );

    expect((await fetch(`${base}/`)).status).toBe(500);
    expect(errors).toEqual(['a string']);
  });

  it('does not try to send a second response when the first had already begun', async () => {
    const errors: string[] = [];
    const base = await listen(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('half'));
              controller.error(new Error('the stream broke'));
            },
          }),
        ),
      { onError: (error) => errors.push(error.message) },
    );

    // The response is already on the wire, so the failure can only be reported
    // out of band and the socket ended.
    await fetch(`${base}/`)
      .then((answer) => answer.text())
      .catch(() => undefined);

    expect(errors).toEqual(['the stream broke']);
  });

  it('aborts the handler when the caller goes away', async () => {
    let aborted = false;
    const base = await listen(
      async (request) =>
        await new Promise<Response>((resolve) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            resolve(new Response('too late'));
          });
        }),
    );

    const caller = new AbortController();
    const pending = fetch(`${base}/`, { signal: caller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    caller.abort();
    await pending;

    // In the modern era closing the per-request stream *is* the cancellation
    // signal, so this is the wire a cancelled tool call travels on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aborted).toBe(true);
  });

  it('stops pumping a stream when the caller goes away mid-body', async () => {
    const errors: string[] = [];
    let cancelled = false;
    let produced = 0;
    const base = await listen(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              produced += 1;
              controller.enqueue(new TextEncoder().encode(`frame ${produced}\n`));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      { onError: (error) => errors.push(error.message) },
    );

    const caller = new AbortController();
    const answer = await fetch(`${base}/`, { signal: caller.signal });
    const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    caller.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Told rather than left running: an endless source with nobody reading it
    // is a leak that looks like nothing at all.
    expect(cancelled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('tells the handler where the caller is, which a Request cannot carry', async () => {
    let remote: string | undefined;
    const base = await listen(async (_request, context) => {
      remote = context.remoteAddress;
      return new Response('ok');
    });

    await fetch(`${base}/`);

    expect(remote).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });

  it('reports a listen that cannot bind rather than hanging', async () => {
    const first = await startHttpEndpoint({
      handler: async () => new Response('ok'),
      host: '127.0.0.1',
      port: 0,
    });
    endpoints.push(first);

    await expect(
      startHttpEndpoint({
        handler: async () => new Response('ok'),
        host: '127.0.0.1',
        port: first.port,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
  });

  it('stops answering once it is closed', async () => {
    const base = await listen(async () => new Response('ok'));
    const endpoint = endpoints[endpoints.length - 1];

    await endpoint?.close();

    await expect(fetch(`${base}/`)).rejects.toThrow();
  });
});
