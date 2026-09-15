# AgentFuse

AgentFuse is a transparent MCP proxy that sits between an agent and its tool
servers, intercepts `tools/call` traffic, and acts as a circuit breaker for it:
it detects semantic loops (the agent calling the same thing over and over in
slightly different words), enforces budget limits on calls and tokens, and
applies a per-tool allow / deny / approve policy. Tool results pass straight
through when nothing trips; when something does, the agent gets a structured
refusal instead of another wasted round trip.

> **Under construction.** This repository is currently a workspace scaffold —
> the packages exist but the product logic has not landed yet. Interfaces will
> change without notice until the first tagged release.

## Workspace layout

| Package | Name | Role |
| --- | --- | --- |
| `packages/core` | `@agentfuse/core` | Domain types, policy engine, detectors. Depends on `zod` only. |
| `packages/proxy` | `@agentfuse/proxy` | The MCP server/client pair that does the intercepting. |
| `packages/embeddings-local` | `@agentfuse/embeddings-local` | Optional local embedding backend, loaded via dynamic import. |
| `packages/cli` | `agentfuse` | The `npx agentfuse` entry point. |
| `bench` | `@agentfuse/bench` | Private benchmark harness. |

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run build
npm test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
