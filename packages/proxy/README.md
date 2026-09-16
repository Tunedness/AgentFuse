# @agentfuse/proxy

The MCP adapter for [AgentFuse](https://github.com/tunedness/agentfuse): a
server/client pair that sits between an agent and one tool server, forwards
everything untouched, and puts `@agentfuse/core`'s decision in front of every
`tools/call`.

**Most people do not install this.** Use the `agentfuse` command line, which
is this package plus a policy loader, a report directory and a lifecycle.
Install it directly when you are building a host of your own and want the
guarded `tools/call` path without the CLI around it.

```sh
npm install @agentfuse/proxy
```

## The whole product in one call

```ts
import { wrapStdioServer } from '@agentfuse/proxy';

const handle = wrapStdioServer({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv'],
  engine,                    // a configured FuseEngine
  serverName: 'filesystem',  // part of every fingerprint
});

// handle.sessionId, handle.bridge, await handle.close()
```

The agent connects over this process's stdio; the wrapped server is spawned as
a child. One child process is one downstream connection is one session — exact,
identical on both protocol eras, with nothing to configure.

## What passes through, and what does not

Built on the low-level `Server` class rather than `McpServer`, with
`fallbackRequestHandler` / `fallbackNotificationHandler` as the pass-through
seam. Explicit handlers exist only for `tools/call` and `tools/list`;
everything else is relayed as-is.

Two lifecycle methods cannot go through the fallback and are answered here
instead:

- **`initialize`**, answered with the upstream's mirrored identity,
  capabilities and `instructions`. The SDK always answers it itself, and has to
  — without it the instance never learns its own era and every later request is
  decoded with the wrong codec. Mirroring is better than blind forwarding
  anyway: the agent negotiates against the real server's capabilities.
- **`server/discover`**, which on a legacy connection throws synchronously
  before reaching any transport, and on a modern one is answered by the serving
  entry point.

Cancellation and progress need no translation tables: chaining the incoming
`AbortSignal` onto the forwarded request makes the installed SDK emit its own
`notifications/cancelled` (or abort the per-request stream on the modern era),
and `Protocol.request` already rewrites `_meta.progressToken` and routes the
replies. The one table that remains is keyed by downstream request id, and a
test asserts it returns to empty after every settled request — result, error
and cancellation alike.

**Era translation is out of scope.** Both eras are served
(`legacy` = `2024-10-07`…`2025-11-25`, `modern` = `2026-07-28`), but a legacy
client in front of a modern server is not this proxy's problem; both sides must
speak the same era, and `assertSameEra` checks it once the connection is up.

## Two rules this package keeps

**Nothing here writes to stdout.** In wrap mode stdout *is* the agent's
JSON-RPC stream, and one `console.log` in a shared module corrupts every frame
after it — with the wrapped server getting the blame. Diagnostics go to stderr
through `Diagnostics`, one line of prefixed JSON at a time, rate-limited. A test
forbids `console.*` and `process.stdout` in every source file.

**Only two files know the engine exists.** `bridge.ts`, `era.ts`, `remap.ts`
and `diagnostics.ts` never import `@agentfuse/core`; `tools-call.ts` and
`trip-result.ts` do. A test pins that list, so adding a file to it is a
decision rather than a slip. It is what keeps this MCP plumbing liftable into a
package shared with McpGuard later.

**And this package does no file I/O.** The report path the agent sees is
whatever the host's `writeReport` hook returns. Where reports live is the CLI's
business.

## Public surface

### Entry points

| Export | What it is |
| --- | --- |
| `wrapStdioServer(options)` | The whole of `agentfuse wrap`. Returns `StdioWrapHandle`. |
| `createBridge(options)` | The layer beneath it, for a host that owns its own transports. Its `client` must be **already connected** — the bridge mirrors the upstream's identity. |
| `createToolCallGuard(options)` | The guarded `tools/call` path on its own. |
| `buildTripResult(input)` | The refusal the agent receives. |

Companion types: `StdioWrapOptions` · `StdioWrapHandle` · `BridgeOptions` ·
`Bridge` · `GuardedToolCall` · `ToolCallGate` · `ToolCallGuardOptions` ·
`ToolCallGuard` · `TripResultInput` · `TripStructuredContent`

`ToolCallGuardOptions` carries the three host hooks: `writeReport(decision)`
returns the path the agent is told about, `annotationsFor(toolName)` supplies
the server's own behaviour hints (read only when
`annotations.trust_hints: true`), `onSessionEnd(summary)` is where a host drops
per-session state, and `traceparentFor(call, decision)` injects the host's span
into the forwarded `_meta`.

### The refusal text

`renderTripText` · `primaryReason` · `RETRY_WARNING` · `TRIP_META_KEY` ·
`renderTripDiagnostic`

A block comes back as `isError: true` on a normal `tools/call` result, never as
a JSON-RPC error. That distinction is the point: a protocol error is a
transport failure and clients retry, reconnect or crash on it, while an
`isError` result lands in the model's context as text it can read and act on.

The text is snapshot-tested and carries four things: what happened, **that
retrying will be blocked too** (the one load-bearing sentence — without it the
agent retries the breaker in a tight loop and you have built a second loop on
top of the first), two or three concrete alternatives, and where the report is.
Around 120 tokens. Every trip code gets its own variant, so adding a code
breaks the build until somebody writes it advice.

For a human denial the operator's reason is included, attributed: `A human
denied this call. Reason given: …`. Attributed rather than stated, so free-form
prose written at a terminal reads as a report of what a person said rather than
as one more instruction. Denials only — an approved call is forwarded and has
no refusal text.

`renderTripDiagnostic` is a deliberate pass-through to core's
`renderTripReport`: one renderer, so the CLI, a control plane and the snapshots
all reach the same text.

### Protocol era

`eraOfProtocolVersion` · `eraOfConnection` · `detectRequestEra` ·
`declaredProtocolVersion` · `assertSameEra` · `EraMismatchError` ·
`FIRST_MODERN_PROTOCOL_VERSION` · `ProtocolEra` · `EraSignals` ·
`EraReporting` · `MetaBag`

Revisions are ISO dates, so a lexicographic comparison is chronological: one
`version >= '2026-07-28'` is the whole test, with no version parsing, and an
unknown future revision falls to `modern` rather than `legacy`.

### Session identity over HTTP

`SessionKeyResolver` · `sessionIdResolverFor` · `traceIdOf` ·
`clientAddressKey` · `describeSessionRegime` · `SESSION_BAGGAGE_KEY` ·
`SessionKeyInput` · `SessionKeyResolution` · `SessionKeySource`

The ladder: `traceparent` in `_meta` → the `tunedness.session-id` entry in
`baggage` → `Mcp-Session-Id` on a legacy-era request → a best-effort hash of
client identity and remote address. Baggage sits **above** the transport header
on purpose: it is the chaining contract with McpGuard and names one session for
the whole chain, while `Mcp-Session-Id` names only that hop.

This package holds the ladder, not a guarded HTTP gateway. A gateway needs one
upstream connection per downstream connection and therefore a pool keyed by the
resolved session; that design is post-v0.1.0, and its entry point belongs here
rather than in the CLI.

### Plumbing

`Diagnostics` · `DIAGNOSTIC_PREFIX` · `DiagnosticSink` · `DiagnosticsOptions` ·
`RequestRemap` · `forwardedMeta` · `upstreamParams` · `mergeMeta` ·
`baggageEntry` · `traceparentOf` · `clientInfoOf` · `splitProgressToken` ·
`FORWARDED_META_KEYS` · `PASSTHROUGH_RESULT` ·
`RELAYABLE_CLIENT_CAPABILITIES` · `PROXY_VERSION` and their types

`Diagnostics.block(text)` writes a rendered report as-is after one marker line;
`emit()` prefixes every line and would destroy the report's ruled table.

## License

Apache-2.0
