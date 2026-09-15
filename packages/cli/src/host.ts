/**
 * The four things a serving command has to ask the process for.
 *
 * `main.ts` is the only file allowed to touch the process's *streams*, and
 * `discipline.test.ts` enforces that. This is the second — and last — file that
 * touches the process at all, and for a different set of things: the read end
 * of the agent's pipe, the two signals a supervisor sends, and the ability to
 * pass one of those on to a child. A command cannot be written without them,
 * and a command that reached for them directly would be untestable without
 * spawning a process for every case.
 *
 * So they are an interface with one real implementation, injected the same way
 * {@link CliContext} injects the streams. `wrap.test.ts` drives every lifecycle
 * path — the agent going away, the wrapped server dying, SIGINT, SIGTERM — by
 * passing a fake, and the real one is exercised end to end by spawning
 * `dist/main.js`.
 *
 * `process.stdin` is here rather than on `CliContext` deliberately: no other
 * command reads it, and in wrap mode it is not "input" at all — it is the
 * agent's half of the JSON-RPC pipe, owned by the SDK's transport. The only
 * thing the CLI wants from it is the moment it closes, which is the moment the
 * wrap is over.
 */

/** The signals a wrap forwards and shuts down on. */
export const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** One of {@link FORWARDED_SIGNALS}. */
export type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

/**
 * The minimum of an event emitter the CLI needs.
 *
 * Deliberately not `NodeJS.EventEmitter`: a fake in a test should be five
 * lines, and the only events anybody listens for here are `end` and `close`.
 */
export interface EventSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** What a serving command is allowed to know about the process it runs in. */
export interface ProcessHost {
  /**
   * The agent's end of the pipe.
   *
   * Only ever listened to, never read: the SDK's `StdioServerTransport` owns
   * the bytes. `end` or `close` here means the agent has gone away, which is
   * the ordinary way a wrap finishes.
   */
  readonly stdin: EventSource;
  /** Registers a signal handler. */
  onSignal(signal: ForwardedSignal, listener: () => void): void;
  /** Removes one, so a finished command leaves no listener behind. */
  offSignal(signal: ForwardedSignal, listener: () => void): void;
  /**
   * Sends a signal to a process by pid, reporting whether it landed.
   *
   * Used to pass SIGINT or SIGTERM on to the wrapped server. `false` means the
   * process was already gone, which is not a failure — it is the common case
   * when a terminal delivered the signal to the whole foreground group and the
   * child had already handled it.
   */
  kill(pid: number, signal: ForwardedSignal): boolean;
}

/** The real one. The only place in the CLI that names these process members. */
export function nodeProcessHost(): ProcessHost {
  return {
    stdin: process.stdin,
    onSignal: (signal, listener) => {
      process.on(signal, listener);
    },
    offSignal: (signal, listener) => {
      process.off(signal, listener);
    },
    kill: (pid, signal) => {
      try {
        return process.kill(pid, signal);
      } catch {
        // ESRCH: the child is already gone. Nothing to forward to, and nothing
        // worth telling the operator — a wrap that printed a warning every
        // time Ctrl-C reached the child first would cry wolf on every run.
        return false;
      }
    },
  };
}
