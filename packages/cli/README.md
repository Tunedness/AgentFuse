# agentfuse

The command line for [AgentFuse](https://github.com/tunedness/agentfuse): put a
fuse in front of your agent's tools. This is the package `npx agentfuse`
downloads.

It wraps one MCP server, sees every `tools/call` between your agent and that
server, and decides whether the call happens — stopping semantic loops,
enforcing budgets, and applying per-tool allow / deny / approve rules from a
single YAML policy. No code change on either side.

```sh
npx agentfuse init                         # write a starter fusepolicy.yaml
npx agentfuse validate                     # check what it resolves to
npx agentfuse wrap --name fs -- <server>   # run the server behind the breaker
npx agentfuse report last                  # read what it would have stopped
```

Requires Node.js ≥ 20.19. Four runtime dependencies and no more:
`@agentfuse/core`, `@agentfuse/proxy`, `gpt-tokenizer`, `yaml`. That list is
pinned by a test, because it is what `npx agentfuse` makes people download.

**Start in `mode: warn`.** It is the default, and the starter policy says so in
a comment. AgentFuse observes, computes every decision and writes the trip
reports, and forwards the call anyway. The `would_trip` count on your own
traffic is what tells you whether `enforce` is safe for you.

See the [project README](https://github.com/tunedness/agentfuse) for the policy
reference, the measured detection and latency numbers, and the limits worth
knowing before relying on it.

## Commands

```
wrap -- <cmd>    Run an MCP server behind the breaker.
serve            Bind an HTTP endpoint and resolve session identity.
init             Write a starter fusepolicy.yaml.
validate         Check a policy file and print what it resolves to.
report           Read the trip reports written when a circuit broke.
approve <id>     Let through a call a policy stopped for a human.
deny <id>        Refuse one.
models install   Download the local embedding model.
```

`agentfuse --help` for the summary, `agentfuse <command> --help` for one
command, `agentfuse --version` for the versions of the three packages that
shipped together.

### `wrap`

```
agentfuse wrap [options] -- <command> [args...]

  --name, -n <alias>      What to call the wrapped server. Part of every
                          fingerprint; guessed from the command otherwise.
  --policy, -p <path>     The policy file. Searched for otherwise.
  --mode, -m <mode>       warn or enforce, overriding the policy.
  --hook <path>           An ES module exporting onDecision.
  --relay <list>          Client capabilities to declare to the server:
                          sampling, elicitation, roots, or none.
  --request-timeout <ms>  Per-request timeout for forwarded calls.
  --quiet, -q             Silence AgentFuse's own stderr output.
```

Everything after the bare `--` is the server's own command line, untouched —
including its flags. The `--` is required.

**stdout carries JSON-RPC frames and nothing else**, asserted on raw bytes by a
test that spawns the built binary as a real process. The child's stderr passes
through byte-for-byte; AgentFuse's own lines are prefixed `[agentfuse]`.

`--request-timeout` exists because the SDK's 60-second default kills a tool
that genuinely takes ten minutes and reports no progress, and AgentFuse would
look like the thing that broke it.

### `serve`

```
agentfuse serve [options] -- <command> [args...]

  --port <n>        Port to bind. Default 8765; 0 asks the OS for one.
  --host <addr>     Address to bind. Default 127.0.0.1, i.e. loopback only.
  --path <route>    Route for the MCP endpoint. Default /mcp.
```

Plus `--name`, `--policy`, `--mode`, `--hook` and `--quiet`, which mean exactly
what they mean for `wrap`. Note that `-h` is `--help`, never `--host`, and
`-p` is `--policy`, never `--port`.

Binds an HTTP endpoint (default `127.0.0.1:8765/mcp`) and resolves session
identity for every request through the documented ladder, reporting which rung
answered. `GET /healthz` reports the policy in force.

**It does not forward tool calls in this release**, and says so in `--help`, on
startup, and in every response. Protection lives in `wrap` mode. What `serve`
is good for today is proving the endpoint is reachable through your proxy or
load balancer, and seeing which session key your requests resolve to before you
depend on it.

### `init` and `validate`

```
agentfuse init [--policy <path>] [--force]
agentfuse validate [<path>] [--policy <path>] [--mode warn|enforce] [--json]
```

`init` writes `./fusepolicy.yaml` unless `--policy` names somewhere else, and
refuses to overwrite an existing file without `--force, -f`. `validate` exits
`0` for a valid policy and `3` for an invalid one, and prints the resolved
settings — including which file it found and how.

### `report`

```
agentfuse report [last | list | <trip id>] [--dir <path>] [--limit, -n <n>] [--json]
```

`--json` prints the stored document with nothing wrapped around it; the default
renders the same report the proxy prints on a live trip, from the same renderer.

### `approve` / `deny`

```
agentfuse approve <approval id> --reason <why>
agentfuse approve --session <id> --reset --reason <why>
agentfuse deny    <approval id> --reason <why>
```

`--reason` is required on both. It is recorded in the wrap's log, in the trip
report, in `agentfuse report` output, and — for denials only — in the refusal
text the agent reads, attributed as a person's statement.

The waiting wrap prints the approval id and the exact command **on stderr**,
and `--quiet` does not silence it: a prompt is the policy's own question, not
chatter. The socket is found at `AGENTFUSE_APPROVAL_SOCKET`, then
`$XDG_RUNTIME_DIR/agentfuse/approvals.sock`, then `~/.agentfuse/approvals.sock`;
`--socket` is only needed when the prompt printed one, which happens when a
second wrap is running.

`--reset` closes the breaker (to `closed`, not `half_open`) without answering a
specific call. Budget counters are not reset, and a loop that is still running
trips again within three calls.

### `models install`

```
agentfuse models install [--model <id>] [--policy <path>]
```

`--model` defaults to the policy's `loop_detection.semantic.model`, or
`Xenova/all-MiniLM-L6-v2` when there is no policy — `models install` has to run
before one exists, because the starter file recommends installing the model
first.

Downloads the ~23 MB embedding model the semantic tier uses, verifying each
file against a pinned sha256. Needs the optional
[`@agentfuse/embeddings-local`](https://www.npmjs.com/package/@agentfuse/embeddings-local)
package, which AgentFuse deliberately does not depend on — it carries ~292 MB of
ONNX runtime binaries. The deterministic loop rules need none of it.

## Exit codes

| | |
| --- | --- |
| `0` | success |
| `2` | usage — a bad flag, a missing file, a typo |
| `3` | a policy file that does not validate |
| `4` | a configured capability is not installed |
| `70` | the wrapped server, or the run itself, failed |

There is no `1`. `wrap` exits `0` when the agent disconnects or on
`SIGINT`/`SIGTERM`, and `70` when the wrapped server dies or never starts.

## Environment

| Variable | What it does |
| --- | --- |
| `AGENTFUSE_POLICY` | Names the policy file. Rung 2 of the search, after `--policy`. |
| `AGENTFUSE_APPROVAL_SOCKET` | Absolute path for the approval socket. |
| `XDG_RUNTIME_DIR`, `HOME` | Where that socket goes otherwise. |

Both explicit policy channels exist because an MCP client sets `args` and `env`
but usually cannot set a working directory — it is often `/`, and the upward
search for `fusepolicy.yaml` cannot be relied on there.

## Library surface

This package is a command, not a library. It exports two things, for a host
that wants to report the same version string:

```ts
import { CLI_VERSION, versionBanner } from 'agentfuse';
```

## License

Apache-2.0
