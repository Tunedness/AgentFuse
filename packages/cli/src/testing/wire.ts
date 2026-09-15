/**
 * An MCP client that talks to a spawned process over the raw wire.
 *
 * Wrap mode makes three claims that can only be checked from outside the
 * process: stdout carries protocol frames and nothing else, the wrapped
 * server's stderr arrives byte-for-byte, and the exit code says what happened.
 * All three need a test that owns the child's stdio, so the tests spawn
 * `dist/main.js` for real and drive it with this.
 *
 * It speaks newline-delimited JSON-RPC directly rather than through the SDK's
 * `Client`, for the same two reasons `raw-server.mjs` is raw: this package
 * declares no dependency on the MCP SDK, and the assertions are about the exact
 * bytes on the pipe — which is a thing a client that parses for you cannot
 * show. What arrives is kept as a `Buffer` and only decoded where a test asks
 * for text.
 *
 * Not exported from the package: it is test scaffolding, and `src/testing/` is
 * excluded from the build and from the coverage report.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

/** A JSON-RPC message, as loosely as this needs to know. */
export interface WireMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | undefined;
}

/** How a process ended. */
export interface WireExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** How to start one. */
export interface WireClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
}

/** The legacy-era handshake parameters an agent opens with. */
export const HANDSHAKE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'wire-test-client', version: '0.0.0' },
} as const;

/** A spawned process, driven over JSON-RPC. */
export class WireClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  readonly #pending = new Map<number, (message: WireMessage) => void>();
  readonly #notifications: WireMessage[] = [];
  readonly #exit: Promise<WireExit>;
  #buffered = '';
  #nextId = 1;

  private constructor(options: WireClientOptions) {
    this.#child = spawn(options.command, [...options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env !== undefined ? { env: { ...options.env } } : undefined),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : undefined),
    }) as ChildProcessWithoutNullStreams;

    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#stdout.push(chunk);
      this.#consume(chunk.toString('utf8'));
    });
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr.push(chunk);
    });

    this.#exit = new Promise((resolve) => {
      this.#child.on('close', (code, signal) => resolve({ code, signal }));
    });
  }

  /** Starts a process. */
  static spawn(options: WireClientOptions): WireClient {
    return new WireClient(options);
  }

  /** Every byte the process wrote to stdout so far. */
  get stdout(): Buffer {
    return Buffer.concat(this.#stdout);
  }

  /** Every byte the process wrote to stderr so far. */
  get stderr(): Buffer {
    return Buffer.concat(this.#stderr);
  }

  /** Notifications the process sent, in order. */
  get notifications(): readonly WireMessage[] {
    return this.#notifications;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  /** Sends a request and resolves with the whole response message. */
  request(method: string, params?: unknown): Promise<WireMessage> {
    const id = this.#nextId;
    this.#nextId += 1;
    const answered = new Promise<WireMessage>((resolve) => {
      this.#pending.set(id, resolve);
    });
    this.#write({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : undefined),
    });
    return answered;
  }

  /** Sends a request and resolves with its `result`, throwing on an error response. */
  async call(method: string, params?: unknown): Promise<unknown> {
    const message = await this.request(method, params);
    if (message.error !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
    }
    return message.result;
  }

  /** Sends a notification. */
  notify(method: string, params?: unknown): void {
    this.#write({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : undefined),
    });
  }

  /** The legacy opening exchange: `initialize`, then `notifications/initialized`. */
  async initialize(): Promise<unknown> {
    const result = await this.call('initialize', HANDSHAKE);
    this.notify('notifications/initialized');
    return result;
  }

  /** Closes the write end, which is how an agent says it is finished. */
  endInput(): void {
    this.#child.stdin.end();
  }

  /** Sends a signal to the process. */
  signal(signal: NodeJS.Signals): void {
    this.#child.kill(signal);
  }

  /** Waits for the process to exit. */
  exit(): Promise<WireExit> {
    return this.#exit;
  }

  /** Kills the process and waits, for a test that is finished with it. */
  async dispose(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill('SIGKILL');
    }
    await this.#exit;
  }

  #write(message: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consume(text: string): void {
    this.#buffered += text;
    for (;;) {
      const newline = this.#buffered.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffered.slice(0, newline);
      this.#buffered = this.#buffered.slice(newline + 1);
      if (line.trim() === '') continue;
      // Anything that is not a frame is kept in the buffer and ignored here,
      // never thrown on: this same client also drives commands like
      // `agentfuse report`, whose stdout is a rendered table. Asserting that a
      // *wrap*'s stdout holds nothing else is {@link nonProtocolLines}'s job,
      // and it reads the raw bytes rather than this parse.
      let message: WireMessage;
      try {
        message = JSON.parse(line) as WireMessage;
      } catch {
        continue;
      }
      if (typeof message.id === 'number') {
        const resolve = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        resolve?.(message);
      } else {
        this.#notifications.push(message);
      }
    }
  }
}

/**
 * The lines of a stdout buffer that are not protocol frames.
 *
 * The assertion is on the bytes, not on parsed messages: a diagnostic that
 * happened to be valid JSON would still corrupt the stream, so every non-empty
 * line has to be a JSON-RPC envelope and nothing else may be there at all.
 */
export function nonProtocolLines(stdout: Buffer): string[] {
  return stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .filter((line) => {
      try {
        const parsed = JSON.parse(line) as WireMessage;
        return parsed.jsonrpc !== '2.0';
      } catch {
        return true;
      }
    });
}
