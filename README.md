# Corpix

> Run your own AI software company. You are the boss; a team of agents plans,
> builds and reports while you watch.

**Status: Phase 0 (headless core).** This repository implements the provider
contract, the agent loop, the mock provider, plan validation, the dependency
scheduler, SQLite persistence and a headless CLI. The pixel-art office, git
worktrees, QA review rounds and the merge flow are planned. The full target
design lives in [`docs/DESIGN.md`](./docs/DESIGN.md).

## What works today

- **Provider contract** — `LLMProvider.complete()` with normalised text, tool
  call and tool result blocks.
- **OpenAI-compatible adapter** — any `/chat/completions` endpoint, with
  defensive tool-argument parsing and `max_tokens` / `max_completion_tokens`.
- **Mock provider** — deterministic scripted planning and worker runs. No
  network, no cost. Used by the tests and demo mode.
- **Agent loop** — step cap, wall-clock timeout, budget guard, loop detection,
  tool errors returned to the model, `submit_plan` / `submit_report` handoff.
- **Boss planning** — a Zod-validated plan with unique ids, existing roles,
  existing dependencies and cycle detection; invalid plans are retried.
- **Scheduler** — topological dependency graph with `MAX_CONCURRENT_AGENTS`.
- **SQLite persistence** — runs, tasks, agents, messages, events, usage and
  approvals, with WAL and `busy_timeout`.
- **Safety primitives** — workspace jail (`realpath` + trailing separator),
  protected files, write scopes, command policy, scrubbed child environment.
- **CLI** — `run`, `runs`, `replay`, `team`, `pricing`, `migrate`.
- **HTTP/WS server** — health, projects, runs, events, approvals, usage and a
  WebSocket event stream with `?since=` reconnect. The web UI is not built yet.
- **57 tests** covering the jail, glob matching, command policy, plan
  validation, budget maths, provider mapping and an end-to-end mock run.

Not implemented yet: git worktrees and merging, QA review rounds, Docker
sandbox, approvals UI, prompt caching, context summarisation, resume after a
crash, the React/PixiJS office, and a production build/packaging step.

## Quick start

Requires Node 22+ and pnpm 9+.

```bash
corepack enable
pnpm install

cp .env.example .env        # set provider, base URL, key and model ids
pnpm cli migrate
```

### Demo mode (free)

```bash
LLM_PROVIDER=mock BOSS_MODEL=boss WORKER_MODEL=worker CHEAP_MODEL=cheap \
  pnpm cli run "Create a tiny API and web page" \
  --project ./workspaces/demo --approval auto --budget 1
```

Create `./workspaces/demo` first (a git repo or any directory).

### Real provider

```bash
pnpm cli run "Add a /health endpoint" \
  --project ./workspaces/my-app --approval ask --budget 3
```

`--approval ask` prompts in the terminal for `exec` and `network` actions.
`auto-safe` allows allowlisted test/lint/build commands, `auto` approves
everything except hard denials.

### Server

```bash
pnpm dev            # http://127.0.0.1:3001
curl http://127.0.0.1:3001/api/health
```

REST endpoints match the target design; the WebSocket is at
`ws://127.0.0.1:3001/ws?runId=<id>&since=<seq>`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm cli run "<goal>" --project <path>` | Run one goal |
| `pnpm cli runs` | List runs |
| `pnpm cli replay <run-id>` | Print a run's event log |
| `pnpm cli team` | Show the loaded team and rendered prompt preview |
| `pnpm cli pricing` | Show the pricing table |
| `pnpm cli migrate` | Create or migrate the SQLite database |
| `pnpm test` | Run the test suite |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm dev` | Start the HTTP/WS server |

## Configuration

Environment variables are documented in `.env.example`. Roles and the team are
YAML in `config/roles/*.yaml` and `config/team.default.yaml`; model ids use
`${BOSS_MODEL}`, `${WORKER_MODEL}` and `${CHEAP_MODEL}`. Put real prices in
`config/pricing.yaml`, otherwise the cost meter and budget cap read 0.

## Architecture

```text
apps/cli        headless runner and DB migration
apps/server     Express + ws + SQLite implementation of the Store contract
packages/agents providers, runtime (loop, budget, context), tools, orchestrator, roles
packages/shared Zod schemas, event types, constants, errors
config/         team, roles, pricing
tests/          vitest suites
```

The orchestrator owns event persistence: every event is appended to SQLite and
then handed to `onEvent`, so the log is authoritative even with no client.

## Security notes

- Agents only touch the workspace through tools; writes are checked against the
  role's `scope.write` and the workspace jail.
- `.git`, `.env*`, `*.pem`, `id_rsa*` and similar are denied by default.
- Commands run without a shell, against a per-role allowlist, with a scrubbed
  environment. `sudo`, `ssh`, `scp`, `git push`, `git remote`, `npm publish`
  and broad recursive deletes are hard-denied.
- The server refuses to bind a non-loopback `HOST` unless `ADMIN_TOKEN` is set.
- This is still an intern with shell access: review every diff.

## License

MIT. See [`LICENSE`](./LICENSE).
