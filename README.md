# AgentFuse

**A circuit breaker for an agent's tool calls.** AgentFuse is a transparent MCP
proxy: it sits between your agent and one of its tool servers, sees every
`tools/call`, and decides whether that call happens. It stops semantic loops —
the agent asking the same thing over and over in slightly different words —
enforces per-session budgets, and applies per-tool allow / deny / approve
rules. Nothing trips, nothing changes: results pass straight through. Something
trips, and the agent gets a refusal it can read and act on instead of another
wasted round trip.

It is framework-agnostic on purpose. LangGraph, CrewAI, the Claude Agent SDK, a
hand-rolled loop — if the agent reaches its tools over MCP, AgentFuse gets in
between, with no code change on either side.

- **Default mode is `warn`.** It observes and writes reports; it breaks nothing
  until you tell it to. See [Start in warn mode](#start-in-warn-mode).
- **Measured, on a corpus committed to this repository:** 87.0% loop detection
  at **0.0% false positives**. The design target was ≥90% detection and
  v0.1.0 does not meet it. [What that trade actually
  was](#detection-what-it-catches-and-what-it-does-not).
- **Added latency:** p95 **4.84 ms** per call in the worst configuration
  measured — a real stdio pipe with the semantic tier and telemetry both on.
  [Why it is 4.8 ms and not 0.2](#latency).

> **Not published to npm yet.** v0.1.0 is prepared but unreleased, so the
> `npx agentfuse` lines below describe the shape of the command rather than
> something you can run today. To try it now, clone this repository, run
> `npm install && npm run build`, and use `node packages/cli/dist/main.js`
> wherever the examples say `agentfuse`.

---

## Quickstart

Requires Node.js ≥ 20.19.

### 1. Write a policy

```sh
npx agentfuse init
```

That writes `fusepolicy.yaml`: a commented starter file that spells out every
default and starts in `mode: warn`. Check what it resolves to:

```sh
npx agentfuse validate
```

### 2. Put the fuse in front of one server

Everything after the bare `--` is the wrapped server's own command line,
untouched:

```sh
npx agentfuse wrap --name filesystem -- \
  npx -y @modelcontextprotocol/server-filesystem /srv/projects
```

Your agent talks to AgentFuse over stdio; AgentFuse talks to the server. One
child process is one session, exactly — so the budgets mean precisely what they
say.

### 3. Point your MCP client at it

In an MCP client's server configuration, `agentfuse wrap` takes the place of the
server's own command. [`examples/claude-desktop.json`](./examples/claude-desktop.json)
is a working configuration with three entries, and it is checked against the
real argument parser by a test — a `--mode warm` typo in a file people paste
from is a support burden nobody can see.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y", "agentfuse", "wrap",
        "--name", "filesystem",
        "--policy", "/absolute/path/to/fusepolicy.yaml",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/projects"
      ]
    }
  }
}
```

An MCP client launches the server in a working directory you did not choose —
often `/` — so name the policy explicitly, with `--policy` or with
`AGENTFUSE_POLICY` in the entry's `env`. The upward search for `fusepolicy.yaml`
cannot be relied on there.

### 4. Read what it would have done

```sh
npx agentfuse report list      # what is on disk, newest first
npx agentfuse report last      # the most recent trip, rendered
npx agentfuse report last --json
```

### 5. Only then enforce

```sh
npx agentfuse wrap --mode enforce --name filesystem -- <server command>
```

---

## Start in warn mode

This is the first risk in the product's own requirements document, and the
mitigation is the default: **a circuit breaker that cuts in the wrong place
gets removed, and then it catches nothing at all.** A loop it misses is only
expensive.

So `mode: warn` is a first-class code path, not a disabled one. The breaker
machinery runs, every decision is computed, the trip reports are written — and
the call is forwarded anyway. Each decision that *would* have broken the
circuit is recorded with `wouldTrip: true` and emitted on stderr as a
`would_trip` line. That number, on your own traffic, is what tells you whether
`enforce` is safe for you:

```sh
# Run your agent normally for a while, then look at what it would have stopped.
npx agentfuse report list
```

Nothing in this repository asks you to trust our false-positive rate on your
workload. The measured numbers below are on a corpus we wrote; the `warn`-mode
counter is on yours.

---

## The policy file

One declarative YAML file, versioned, with a published JSON Schema so editors
validate it as you type. `version: 1` on its own is a complete, valid policy.

What follows is a tour of the keys rather than a printout of the defaults —
`on_exceeded` is shown as `halt`, while the schema default is
`require_approval`, and the `session` and `annotations` groups are left out
entirely. For the defaults exactly as the schema states them, run `agentfuse
validate`, which prints the policy it resolved, or read the
[Configuration](https://github.com/Tunedness/AgentFuse/wiki/Configuration) page
in the wiki.

```yaml
version: 1
mode: warn                      # warn | enforce

budgets:
  max_duration: 30m             # exact
  max_calls: 200                # exact
  max_tokens_estimated: 400000  # an estimate — see below
  max_usd_estimated: 5          # an estimate — see below
  on_exceeded: halt             # halt | require_approval | warn

loop_detection:
  window: 5
  min_calls: 5                  # gates the semantic rule only
  exact_repeat: { count: 3 }    # identical tool + arguments, 3 times
  error_repeat: { count: 3 }    # same error signature, 3 times
  cycle: { max_period: 4 }      # A→B→A→B and longer rotations
  semantic:
    enabled: true
    provider: local             # local | openai | none
    model: Xenova/all-MiniLM-L6-v2
    threshold: 0.905
    consecutive_windows: 1
  on_trip: halt                 # halt | require_approval | warn
  cooldown: { calls: 3, duration: 2m }

tools:
  - match: "fs__read_*"         # glob against "<server>__<tool>"
    action: allow               # allow | warn | deny | require_approval
    idempotent: true            # doubles the exact-repeat threshold here
  - match: "shell__*"
    action: deny
    note: "no shell access for this agent"
  - match: "*"
    action: allow               # first match wins; unmatched is allowed

report:
  dir: .agentfuse/reports       # relative paths resolve against THIS FILE
  recent_calls: 20
  redact_args: false

pricing:                        # USD per million tokens — your numbers
  input_per_mtok_usd: 3
  output_per_mtok_usd: 15

approvals:
  timeout: 120s
  on_timeout: deny              # deny | allow — `allow` fails OPEN
  gateways: [cli]               # cli | webhook

telemetry:
  enabled: false                # off unless you ask
  otlp_endpoint: http://localhost:4318
  service_name: agentfuse
```

The schema is `strict`: a misspelled key is a load-time error with a line
number, not a silently ignored setting. A relative `report.dir` resolves
against the policy file rather than the process working directory, for the same
reason step 3 above names the policy explicitly.

**Where the policy comes from**, in order — each step is a hard stop if it
names a file that does not exist:

1. `--policy <path>`
2. `AGENTFUSE_POLICY`
3. `fusepolicy.yaml`, `fusepolicy.yml`, `.agentfuse/fusepolicy.yaml`,
   `.agentfuse/fusepolicy.yml`, searched **upward** from the working directory
   to the filesystem root.

Both explicit channels exist because an MCP client can set `args` and `env` but
usually cannot set a working directory. The resolved absolute path is always
printed in the `policy_loaded` diagnostic and by `validate`, so a surprising
choice is visible rather than mysterious.

`--mode warn|enforce` overrides the file without editing it.

---

## Budgets are honest about what they cannot see

AgentFuse stands on `tools/call`. It sees the arguments going into a tool and
the result coming back. **It does not see your model's tokens** — not the system
prompt, not the completion, not reasoning tokens, not a single turn that called
no tool.

So every token and dollar figure it produces measures one thing: the content
your tools injected into the context. It is a **lower bound** on real usage,
sometimes by a lot. That is why the names carry the suffix they carry, and the
suffix is binding across the schema, the reports and the telemetry:

| Limit | What it is |
| --- | --- |
| `budgets.max_duration` | **Exact.** Wall-clock, `now - startedAt`. |
| `budgets.max_calls` | **Exact.** Forwarded `tools/call` count. |
| `budgets.max_tokens_estimated` | An estimate of tool I/O only. |
| `budgets.max_usd_estimated` | That estimate × your own `pricing` table. |

`max_duration` and `max_calls` are the **anchor limits**: reach for them first
and trust them. Use the estimates as a tripwire — "something is very wrong" —
never as an invoice. Every report that carries one prints the floor warning as
plain text beside it.

The token count is not a `bytes/4` guess: it comes from a real tokenizer
(`gpt-tokenizer`, `o200k_base`) over the serialised arguments and results,
because that heuristic drifts badly on the code and JSON that tools actually
carry. The dollar figure needs your `pricing` table because a `tools/call`
proxy cannot know which model is running.

The route to an exact number is a local usage-ingest endpoint that an LLM
gateway pushes real usage to, and it is deliberately not in v0.1.0.

---

## Detection: what it catches, and what it does not

Two tiers, and the first one works entirely on its own.

**The rule tier** — no model, no network, no measurable latency:

- **exact repeat** (`R1`): the same tool with byte-identical arguments, N times
  — *and* the results agreeing too. The rule's message says "the result will not
  change", and it now checks that before saying it. Without the check it stopped
  every converging build-test session in the corpus. Measured at `window: 8`,
  the pre-calibration default: 31% false positives from the rule tier alone
  without the check, 9% with it. At the shipped `window: 5` the rule tier
  produces none at all on this corpus.
- **error repeat** (`R2`): the same error signature N times, with volatile
  parts (temp paths, hex ids) masked so two instances of one failure land
  together.
- **short cycle** (`R3`): A→B→A→B and longer rotations, where no single tool
  ever reaches the exact-repeat threshold.

**The semantic tier** — the loop that changes shape every turn and makes no
progress. Each completed call is embedded off the hot path; a sliding window
scores as `min(average pairwise cosine similarity, answer staleness)`, and
crossing the threshold leaves a verdict the next call consumes. Two axes rather
than one, because on similarity alone the positives sat *below* the negatives:
page 1 versus page 2 of a paginated search scores 0.9971, while a genuine
reworded retry scores 0.9791. The most distant pair should have been the
closest. Staleness — how much of each answer was already in one of the others —
is what separates them.

It requires the optional [`@agentfuse/embeddings-local`](./packages/embeddings-local)
package. The rule tier is fully functional without it.

### The measured numbers

200 labelled sessions, 2084 calls, 100 positive / 100 negative, generated by a
seeded generator and committed to this repository as
[`bench/detection/corpus.jsonl`](./bench/detection) with its hash pinned by a
test. Replayed through the real engine with the real embedder at the calibrated
operating point (`window: 5`, `min_calls: 5`, `threshold: 0.905`,
`consecutive_windows: 1`):

| | |
| --- | --- |
| detection (recall) | **87.0%** |
| false positive rate | **0.0%** |
| precision | 1.000 |
| F1 | 0.930 |
| detection latency | mean 3.53 turns · p50 3 · **p95 5** |
| caught by | rules 60, semantic 27 |

The design target was **≥90% detection at <5% false positives**. The
false-positive half is met with room to spare. **The detection half is not:
87.0%, not 90%.**

Here is what the three points cost and why they were not bought. All 13 missed
sessions are one scenario — the same request asked again in different words —
and on every axis measured they sit *below* the hardest honest sessions in the
corpus (median 0.8491 against a negative maximum of 0.8982). The only threshold
that catches them is 0.845, and there the false-positive rate is **16%**.

In-between points exist and are excluded for two different reasons, worth
keeping apart. 0.870 reaches 88% at exactly **5.0%** false positives, and the
requirement is `< 5%`, so it fails the target itself rather than anybody's
judgement. 0.890 reaches 88% at 1%, and it is excluded because its margin to
the nearest honest session falls below the ±0.002 resolution floor of the
quantised model — which makes it a property of this corpus rather than of the
product.

**So: three points of recall, for 0% instead of 16% false positives.** That is
a deliberate product decision, taken with the numbers on the table, not a
rounding afterwards. Both routes to 90% are known and both are post-v0.1.0: a
second tier for windows near the threshold, or a stronger embedding model
(which reopens the install-size decision below).

CI gates on the measured recall and prints the verdict against the target on
every run. The target was not softened; where we stand was written down.

### Limits worth knowing before you rely on it

- **Rewording is not separable with this embedder.** 7 of 20 reworded-retry
  sessions are caught. The half whose answers echo the query back are
  especially hopeless: request and response both move every turn, and "the
  intent is unchanged" is not present in any in-band signal.
- **One pagination shape is held by a single axis.** A postgres-style sweep
  with the offset inside the SQL and no `cursor` argument reaches 0.99 on the
  cosine axis; the only thing holding it is answer staleness. A server that
  truncates its result text weakens that protection.
- **The threshold errs conservative, on purpose.** The binding negative is a
  list-then-read-each-file run, and the corpus makes it *harder* than reality:
  the file contents are templated, so they look more alike than real files do.
  The margin on real traffic should be wider than the measured 0.0068.
- **The calibration belongs to one model.** `Xenova/all-MiniLM-L6-v2`, int8.
  **Changing `loop_detection.semantic.model` invalidates `threshold`** and means
  recalibrating: the number 0.905 is a property of that model's embedding space,
  not of loop detection in general. Nothing stops you changing it; do not expect
  the threshold to survive.
- **Thresholds below ±0.002 are noise.** The int8 model is dynamically
  quantised, so one text embedded alongside different neighbours comes back
  slightly differently (worst measured: cosine 0.9983 against itself). Anything
  finer than that is not measurement.

### Latency

1000 warm calls per configuration, 200 discarded first. Added latency is the
difference against the same traffic with no proxy in between:

| configuration | p50 | p95 | p99 |
| --- | --- | --- | --- |
| in-memory · rules · telemetry off | 0.017 | 0.022 | 0.020 |
| in-memory · semantic · telemetry off | 0.013 | 0.007 | ~0 |
| stdio · rules · telemetry off | 0.072 | 0.134 | 0.315 |
| stdio · rules · telemetry on | 0.082 | 0.207 | 0.571 |
| stdio · semantic · telemetry off | 4.455 | 4.737 | 7.388 |
| **stdio · semantic · telemetry on** | **4.473** | **4.835** | **7.837** |

All in milliseconds. The budget is p95 < 50 ms and the worst case uses under a
tenth of it — 4.835 of 50.

**But do not read the 0.2 ms rows as the number for a real installation.** With
the semantic tier on, through a real pipe, it is **~4.8 ms** — twenty times the
rule-only figure — and the reason matters. In memory the client calls faster
than any model can keep up; the queue sheds load and the semantic tier is
genuinely free. Over a pipe the calls are slow enough for the queue to keep up,
so the tier actually runs — and ONNX competes with the proxy for the same
process and the same cores. Measured: 300 calls, 300 batches. Under a steady
arrival rate the worker is always idle when the next call finishes, so it takes
a batch of one and pays the model's fixed per-call cost every time. The queue
cannot wait for company because it deliberately owns no timer. With ten times
the budget still unspent, that was left alone rather than traded against
detection coverage.

Telemetry's own contribution is +0.089 ms at p95 with the semantic tier on.

---

## Human approval

For rules whose `action` is `require_approval`. Only resolved in `mode:
enforce` — warn mode never asks anybody.

The pending call is printed **on stderr**, with the tool, the policy's own
reason for asking, the trimmed arguments, the approval id and the exact command
to answer it:

```sh
npx agentfuse approve <approval id> --reason "checked the path by hand"
npx agentfuse deny    <approval id> --reason "not on prod"
```

- **`--quiet` does not silence the prompt.** `--quiet` exists to stop
  AgentFuse being chatty in a terminal you are reading. A prompt is not
  chatter: it is the policy's own question, and silencing it turns every
  `require_approval` into a two-minute hang followed by a denial nobody can
  explain. The machine-readable `approval_pending` event *does* respect
  `--quiet`, so the two are separable.
- **`--reason` is required** on both commands. It is recorded in the wrap's
  log, in the trip report, in `agentfuse report` output — and, **for denials
  only**, in the refusal text the agent reads, attributed: `A human denied this
  call. Reason given: …`. An approved call is forwarded and has no refusal text
  to put one in. The text is stripped of ANSI and control characters and capped
  at 500 characters, wherever it came from.
- **The socket** is found at `AGENTFUSE_APPROVAL_SOCKET`, then
  `$XDG_RUNTIME_DIR/agentfuse/approvals.sock`, then
  `~/.agentfuse/approvals.sock` (macOS, where `XDG_RUNTIME_DIR` is
  conventionally unset). Mode 0600 inside a 0700 directory. A second wrap does
  not steal the first one's socket — it binds a fallback path and prints
  `--socket <path>` in its own prompts.
- **`agentfuse approve --session <id> --reset --reason "…"` closes the
  breaker** — all the way to `closed`, not to `half_open`. The two other routes
  into `half_open` are a standing policy instruction and a cooldown expiring;
  in both, nobody looked. A `--reset` typed by hand means a person read the trip
  report and overruled it, and waking them again for the next three calls adds
  friction, not information. Budget counters are **not** reset, and if the loop
  is genuinely still running the rule tier trips again within three calls. A
  mistaken `--reset` costs three calls, not unlimited licence.
- **`approvals.on_timeout: allow` fails OPEN and is not recommended.** It
  forwards the one call your policy singled out for a human, unattended, which
  is the opposite of what asking was for. AgentFuse warns about it on every
  start. A *broken* channel does not go through `on_timeout` at all — it
  denies, so an attacker who can break your network cannot convert the setting
  into blanket consent.
- **Two gateways may be configured**, and then the first definite answer wins;
  a channel timing out does not end the request, and a channel that throws
  denies. Configuring two means "either of these reaches somebody who can
  answer for me" — redundancy — so requiring both to agree would make a silent
  channel refuse everything.
- **A channel that cannot be opened warns loudly and keeps running.** Refusing
  to start would take your MCP server down with it and leave the agent with no
  fuse at all. Approvals then resolve to denials, which is stricter than asked
  for and never looser.

`approvals.webhook` POSTs the request instead, signed `HMAC-SHA256` over the
exact bytes of the body, with the timestamp *inside* the signed body. The policy
names the **environment variable** holding the shared secret
(`secret_env`), never the secret: this file is meant to be committed and
diffed. [`examples/approval-webhook.mjs`](./examples/approval-webhook.mjs) is a
dependency-free receiver, and the three things a receiver must get right —
verify the raw body, compare in constant time, check the age of the *signed*
timestamp — are written at the top of it. A test runs it against the real
signer.

---

## Telemetry

**Off by default**, and off means nothing is constructed: no queue, no timer,
no socket, not a line on stderr.

```yaml
telemetry:
  enabled: true
  otlp_endpoint: http://localhost:4318
  service_name: agentfuse
```

Three keys, and that is the whole surface. Spans go to `<endpoint>/v1/traces`,
events to `<endpoint>/v1/logs`, as OTLP/HTTP JSON.

Four event types, fixed by the platform's shared telemetry contract, all under
the `tunedness.*` attribute namespace:

| Event | When |
| --- | --- |
| `tunedness.tool_call` | every forwarded `tools/call` (plus an `mcp.tools/call` span) |
| `tunedness.policy_decision` | every decision that is not a plain `allow` |
| `tunedness.budget_event` | crossing 50% / 80% / 100% of a budget |
| `tunedness.loop_detection` | a rule or the semantic tier firing, `warn`-mode `wouldTrip` included |

There is no fifth type, and a test makes a fifth impossible. In particular
AgentFuse never emits `security_event` — that one belongs to McpGuard.

- **Enabling telemetry installs nothing.** The OTLP JSON encoding is written by
  hand and the transport is Node's global `fetch`; no OpenTelemetry package is
  in the dependency tree, and four tests keep it that way. The attributes are
  `tunedness.*`, so the official semantic-conventions package (12 MB on its own)
  had nothing to sell us. Install size is identical with telemetry on or off.
- **`--quiet` does not silence export.** `--quiet` is about a terminal; it is
  not an instruction to stop recording what the circuit breaker did.
- **A dead collector costs one diagnostic line.** Failed batches are dropped
  and counted, never retried — retrying piles load onto a collector that is
  already struggling, and the data is observational: the decisions themselves
  are on stderr and in the trip reports. One line per outage (the first failure
  of a streak), one on recovery, and a counter summary at shutdown. A typo in
  `otlp_endpoint` warns and keeps running; taking your MCP server down over a
  telemetry misconfiguration would leave the agent with no fuse.
- **Trace context is joined, never invented.** If the agent's request carries a
  `traceparent`, our span is its child and the wrapped server's work hangs
  beneath ours. If it does not, our span is the root of a new trace and nothing
  is written to the wire; `tunedness.session_id` is then the correlation key,
  and every span and event carries it.

To see it work, with no collector to install:

```sh
node examples/otlp-receiver.mjs            # prints what arrives
npx agentfuse wrap --name fs -- <server>   # with telemetry.enabled: true
```

---

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
command. `agentfuse --version` prints the versions of the three packages that
shipped together.

Exit codes: **0** success · **2** usage (bad flag, missing file, typo) · **3** a
policy file that does not validate · **4** a configured capability is not
installed · **70** the wrapped server or the run itself failed.

### `serve` is not a guarded gateway in v0.1.0

`agentfuse serve` binds a real HTTP endpoint (default `127.0.0.1:8765/mcp`,
loopback), loads the policy exactly as `wrap` does, resolves session identity
for every request through the documented ladder, reports which rung answered in
both the response and the diagnostics, and serves `GET /healthz`.

**It does not forward tool calls.** Every MCP method is answered with a
JSON-RPC error that names the session it resolved and points at `agentfuse
wrap`. That is stated in `--help`, in the startup line, and in every single
response — so nobody deploys it and believes they are covered.

The reason is structural. Guarding traffic needs one upstream connection per
downstream connection; multiplexing callers onto one upstream would quietly
break sampling, elicitation and roots, because on the legacy protocol era the
server pushes those without naming the caller. Over HTTP that means an upstream
pool keyed by the resolved session, which is a design that deserves its own
decision record and is deliberately post-v0.1.0.

**Protection lives in `wrap` mode.** Install AgentFuse there. What `serve` is
good for today: proving the endpoint is reachable through your proxy or load
balancer, and seeing which session key your agent's requests resolve to before
you depend on it. The command line is already the one the gateway will take, so
a configuration written today keeps working.

### How a session is decided

Budgets are per session, so this matters.

- **`wrap` (stdio) is exact.** One wrapped child process is one downstream
  connection is one session, identified by a ULID when the transport connects
  and ended when the pipe closes. Identical on both protocol eras, no
  heuristics, nothing to configure.
- **HTTP resolves a ladder**, in this order: the `traceparent` in the request's
  `_meta` → the `tunedness.session-id` entry in `baggage` → `Mcp-Session-Id` on
  a legacy-era request → a best-effort hash of the client identity and remote
  address, bounded by `session.idle_timeout`. The last rung is documented as
  best-effort, not as a guarantee, and the tool always says which rung answered.

HTTP `traceparent` and `baggage` **headers** are deliberately not read: the
ladder lives in `_meta`, and a second source would mean two answers to "which
session is this" with no rule for which wins.

---

## Chaining with McpGuard

[McpGuard](../../McpGuard) is the sibling tool in the same platform, and the two
are designed to chain. The division is clean:

| | AgentFuse | McpGuard |
| --- | --- | --- |
| Decides **whether a call happens** | ✅ loops, budgets, per-tool policy, human approval | — |
| **Rewrites** content in flight | ❌ never | ✅ PII masking, injection strip |
| **Egress** and content control | ❌ out of scope | ✅ injection scanning, manifest pinning, audit log |

AgentFuse's `onDecision` hook can raise or lower an action and add a reason. It
**cannot change the arguments**. Being the proxy that rewrites is McpGuard's
job, and keeping that line sharp is what lets the two sit in the same pipeline
without fighting over ownership of the message.

**The contract between them is a baggage entry: `tunedness.session-id`.** The
outermost proxy resolves the session and injects it; inner proxies adopt it.
That is why `Mcp-Session-Id` sits *below* baggage in the ladder above: a baggage
entry names one session for the whole chain, while `Mcp-Session-Id` names only
that transport hop, and an inner proxy should defer to the outer one's answer
rather than prefer its own transport's identity.

Both tools emit into the same `tunedness.*` OTLP namespace, so one collector
sees one story. `security_event` is McpGuard's event type and AgentFuse never
sends it.

---

## Packages

| Package | Role |
| --- | --- |
| [`@agentfuse/core`](./packages/core) | The decision engine. Pure: no I/O, no protocol, no clock of its own. Depends on `zod` and nothing else. |
| [`@agentfuse/proxy`](./packages/proxy) | The MCP adapter — the server/client pair that does the intercepting. |
| [`agentfuse`](./packages/cli) | The command line. What `npx agentfuse` downloads. |
| [`@agentfuse/embeddings-local`](./packages/embeddings-local) | **Optional.** The local embedding backend for the semantic tier. Nothing depends on it. |

### Installing the semantic tier, and what it costs

```sh
# On linux/x64, do it this way:
ONNXRUNTIME_NODE_INSTALL=skip npm install @agentfuse/embeddings-local
npx agentfuse models install
```

This is a deliberate second step, and the numbers are why.

- **`onnxruntime-node` is 113.5 MB compressed and 292 MB unpacked** — the
  registry reports `dist.unpackedSize` as 301,068,136 bytes, and 292 MB is what
  it actually occupies once installed, so both figures are real and the CLI's
  own messages quote the larger one. It ships
  every platform's binaries in one tarball, with no per-platform
  `optionalDependencies` to narrow it down. A 300 MB `npx agentfuse` would end
  adoption for a tool whose whole pitch is a frictionless drop-in, so the
  runtime lives in a companion package that no published AgentFuse package
  depends on. The CLI finds it by dynamic `import()` and, failing that, runs the
  rule tier at full strength.
- **On linux/x64 its postinstall also fetches 236 MB of CUDA runtime from
  nuget.org — which AgentFuse never loads.** The platform manifest asks for
  `cuda12` there and those binaries are deliberately absent from the npm
  tarball, so every install downloads `Microsoft.ML.OnnxRuntime.Gpu.Linux`:
  measured at 236,037,232 bytes, outside any npm cache, for a GPU runtime this
  code will never touch. `ONNXRUNTIME_NODE_INSTALL=skip` skips it and costs
  nothing at all — the session is pinned to `executionProviders: ['cpu']`,
  because this is a background embedding queue on a developer's machine, not a
  training rig. This repository's CI sets it workflow-wide. Note that a **clone
  pays this too**: a workspace `npm install` builds every package including the
  companion, so set the variable when you clone on linux/x64, not only when you
  opt into the semantic tier.
- **The model is ~23 MB, downloaded on first use.** Three files under
  `~/.cache/agentfuse/models/<owner>--<model>/<revision>/` (`XDG_CACHE_HOME`
  and `AGENTFUSE_CACHE_DIR` are honoured), each verified against a pinned
  sha256 before it is moved into place. A model id that is not in the pinned
  table is refused: "we have no digest, so skip verification" is not a gate.
- **`AGENTFUSE_OFFLINE=1` disables downloading** — as a wall, before any socket
  is opened, with a message naming both the variable and the path it wanted.
- **`agentfuse models install` fetches it**, and is also a repair tool:
  verification is a precondition of loading rather than a side effect of
  downloading, so a cache corrupted later is caught by the same check and only
  the bad file is re-fetched.

With the package configured but missing, `mode: warn` prints a warning and runs
the rule tier; `mode: enforce` refuses to start (exit 4). You asked to be
protected by something named in your policy, and deciding on your behalf that a
subset was close enough would be the wrong call. Set
`loop_detection.semantic.provider: none` to turn the tier off deliberately and
silence both.

The platform's open-core rule is that the open core has to be genuinely useful
without the commercial layer — no crippleware. Here that cashes out as: the rule
tier is complete without the second install step, and it catches 60 of the 87
loops in the benchmark on its own.

### Environment variables

| Variable | Read by | What it does |
| --- | --- | --- |
| `AGENTFUSE_POLICY` | CLI | Names the policy file. Rung 2 of the search. |
| `AGENTFUSE_APPROVAL_SOCKET` | CLI | Absolute path for the approval socket. |
| `XDG_RUNTIME_DIR`, `HOME` | CLI | Where the approval socket goes otherwise. |
| `AGENTFUSE_CACHE_DIR`, `XDG_CACHE_HOME` | `embeddings-local` | Where the model cache lives. |
| `AGENTFUSE_OFFLINE` | `embeddings-local` | `1` forbids every download. |
| `ONNXRUNTIME_NODE_INSTALL` | npm, at install time | `skip` avoids the 236 MB CUDA fetch. |

---

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run build
npm test
npm run schema:check
```

The suite needs neither the network nor the model: a fake `fetch`, a fake
tokenizer and a fake session cover every line of the download gate and the
pooling recipe. The one test that opens a socket to the internet is gated behind
`AGENTFUSE_TEST_DOWNLOAD=1`. The real-model tests run by themselves once
`agentfuse models install` has been run, so a developer who has the model gets
them for free.

Benchmarks live in `bench/` (private, never published) and run separately:

```sh
npm run bench:corpus     --workspace @agentfuse/bench
npm run bench:detection  --workspace @agentfuse/bench
npm run bench:latency    --workspace @agentfuse/bench
```

Coverage is gated at 90% on `packages/core/src/**` only — that package is the
whole product's safety net; padding the others' numbers would tell nobody
anything.

## What is deliberately not in v0.1.0

- **A guarded HTTP gateway.** `serve` is an endpoint, not a gateway; see above.
- **A Python in-process SDK.** Deferred until the core API settles.
- **Usage ingest.** The route from estimated to exact token accounting.
- **≥90% loop detection.** Measured at 87.0%, at 0.0% false positives.
- **A2A traffic**, framework plugins, and a cost dashboard — the last belongs to
  the Control Plane, not here.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
