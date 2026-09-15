/**
 * An in-process OTLP/HTTP receiver, on a real socket.
 *
 * ADR-010 moved the correctness of the wire format onto us, so the tests do not
 * get to assert that "a POST happened". They assert the bytes a collector would
 * actually receive, which means something has to receive them over a real
 * loopback socket and hand back exactly what arrived: the URL, the headers, and
 * the parsed body.
 *
 * It can also be told to misbehave — a slow answer, an HTTP error, a body that
 * is not JSON — because "the collector is down, slow or nonsense" is a
 * behaviour of the exporter that has to be tested, not hoped for.
 *
 * Not exported from the package: `src/testing/` is scaffolding, excluded from
 * the build and from the coverage report.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request, as the collector saw it. */
export interface ReceivedExport {
  readonly method: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly raw: string;
  /** The parsed body, or `undefined` when it was not JSON. */
  readonly body: Record<string, unknown> | undefined;
}

/** How the receiver should answer. */
export interface OtlpReceiverBehaviour {
  /** HTTP status to answer with. Default 200. */
  status?: number;
  /** Milliseconds to wait before answering. Default 0. */
  delayMs?: number;
  /** Body to answer with. Default `{}`, which is what a collector sends. */
  body?: string;
  /** Answer by destroying the socket instead of replying. */
  hangUp?: boolean;
}

/** A listening receiver. */
export class OtlpReceiver {
  readonly #server: Server;
  readonly #port: number;
  readonly received: ReceivedExport[] = [];
  behaviour: OtlpReceiverBehaviour = {};

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.#port = port;
  }

  /** Binds to a free loopback port. */
  static async start(behaviour: OtlpReceiverBehaviour = {}): Promise<OtlpReceiver> {
    const chunks = new WeakMap<IncomingMessage, Buffer[]>();
    let receiver: OtlpReceiver | undefined;

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const parts: Buffer[] = [];
      chunks.set(request, parts);
      request.on('data', (chunk: Buffer) => parts.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8');
        let body: Record<string, unknown> | undefined;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
        receiver?.received.push({
          method: request.method ?? '',
          url: request.url ?? '',
          contentType: request.headers['content-type'],
          raw,
          body,
        });

        const answer = (): void => {
          const current = receiver?.behaviour ?? {};
          if (current.hangUp === true) {
            request.destroy();
            response.destroy();
            return;
          }
          response.writeHead(current.status ?? 200, { 'content-type': 'application/json' });
          response.end(current.body ?? '{}');
        };

        const delay = receiver?.behaviour.delayMs ?? 0;
        if (delay > 0) setTimeout(answer, delay).unref();
        else answer();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    receiver = new OtlpReceiver(server, port);
    receiver.behaviour = behaviour;
    return receiver;
  }

  /** The base endpoint to configure, exactly as a policy would carry it. */
  get endpoint(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** Every request sent to `/v1/traces`. */
  get traceExports(): ReceivedExport[] {
    return this.received.filter((entry) => entry.url === '/v1/traces');
  }

  /** Every request sent to `/v1/logs`. */
  get logExports(): ReceivedExport[] {
    return this.received.filter((entry) => entry.url === '/v1/logs');
  }

  /** Every span across every trace export, in arrival order. */
  get spans(): Record<string, unknown>[] {
    return this.traceExports.flatMap((entry) =>
      dig(entry.body, 'resourceSpans', 'scopeSpans', 'spans'),
    );
  }

  /** Every log record across every logs export, in arrival order. */
  get logRecords(): Record<string, unknown>[] {
    return this.logExports.flatMap((entry) =>
      dig(entry.body, 'resourceLogs', 'scopeLogs', 'logRecords'),
    );
  }

  /** Waits until a condition holds, or fails the caller by timing out. */
  async waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('the receiver waited too long');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.closeAllConnections();
      this.#server.close(() => resolve());
    });
  }
}

/** Walks the three-deep `resourceX → scopeX → records` nesting. */
function dig(
  body: Record<string, unknown> | undefined,
  outer: string,
  middle: string,
  inner: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const resource of asArray(body?.[outer])) {
    for (const scope of asArray(resource[middle])) {
      for (const record of asArray(scope[inner])) out.push(record);
    }
  }
  return out;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}
