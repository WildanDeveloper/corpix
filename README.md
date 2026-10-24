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
- **Runtime settings** — provider, API key, per-tier and per-role models, step
  caps, output caps, budget, approval mode and pricing are editable from the web
  UI, the API or the CLI. No restart needed.
- **Web UI (first pass)** — a dispatch/activity/approvals view and a full
  settings panel, built with React + Vite. The pixel-art office is still to come.
- **Safety primitives** — workspace jail (`realpath` + trailing separator),
  protected files, write scopes, command policy, scrubbed child environment.
- **CLI** — `run`, `runs`, `replay`, `team`, `settings`, `pricing`, `migrate`.
- **HTTP/WS server** — health, projects, runs, events, approvals, usage,
  settings, models and a WebSocket event stream with `?since=` reconnect.
- **90 tests** covering the jail, glob matching, command policy, plan
  validation, budget maths, provider mapping, settings precedence and an
  end-to-end mock run.

Not implemented yet: git worktrees and merging, QA review rounds, Docker
sandbox, prompt caching, context summarisation, resume after a crash, the
pixel-art office, and a production packaging step.

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

### Server and web UI

```bash
pnpm dev            # API on :3001, Vite UI on :5173
# or serve the built UI from the API:
pnpm build
pnpm --filter @corpix/server start   # http://127.0.0.1:3001
```

Open the UI, register a project (`POST /api/projects` or the Office tab once a
project exists), then dispatch a goal. Settings are under the **Settings** tab
and apply to the next run immediately.

REST endpoints match the target design; the WebSocket is at
`ws://127.0.0.1:3001/ws?runId=<id>&since=<seq>`.

## Settings (no restart, not hardcoded)

Everything an operator usually edits lives in SQLite and is editable from the
Settings tab, `PATCH /api/settings`, or the CLI — no `.env` editing, no restart.

| Area | What you can change |
|---|---|
| Provider | `mock` or `openai-compatible`, base URL, `max_tokens` vs `max_completion_tokens`, request timeout |
| API key | stored in `data/secrets.json` (mode 600), **never** in SQLite and never returned to the browser |
| Models | Boss / worker / cheap model ids |
| Per-agent | model, max steps, **context tokens** and temperature for any role, overriding the tier default |
| Limits | concurrency, steps per task, **context tokens per agent**, task timeout, tool output cap, max output tokens, budget per goal, budget action |
| Safety | approval mode, sandbox |
| Pricing | USD per million input/output/cached tokens per model |

**Precedence.** On first boot the environment seeds the database. After that the
database wins, so the UI stays editable. To force a value from the environment,
list it in `CORPIX_PIN` (comma separated env names or dotted paths, or `*`):

```bash
CORPIX_PIN=LLM_PROVIDER,LLM_BASE_URL,LLM_API_KEY
```

`GET /api/settings` returns a `locked` array with the dotted paths that are
pinned; the UI disables exactly those controls. Invalid pinned values (a typo in
a number or URL) are ignored instead of crashing the server.

```bash
# CLI equivalents
pnpm cli settings
pnpm cli settings set models.boss=gpt-4o-mini limits.maxStepsPerTask=20
pnpm cli settings set models.roles.qa.model=gpt-4o-mini models.roles.qa.temperature=0.2
pnpm cli settings key sk-...        # data/secrets.json, mode 600
pnpm cli settings test              # one cheap provider round trip
```

```http
GET   /api/settings
PATCH /api/settings
PUT   /api/settings/api-key
POST  /api/settings/test
GET   /api/models
GET   /api/roles
```

`GET /api/models` only lists models; it never spends tokens. Only
`POST /api/settings/test` makes a (tiny) completion call.

Example patch:

```json
{
  "models": {
    "boss": "strong-model",
    "worker": "balanced-model",
    "roles": { "qa": { "model": "cheap-model", "maxSteps": 12, "temperature": 0.2 } }
  },
  "limits": { "maxOutputTokens": 4096, "budgetUsdPerGoal": 3 },
  "safety": { "approvalMode": "ask" }
}
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm cli run "<goal>" --project <path>` | Run one goal |
| `pnpm cli runs` | List runs |
| `pnpm cli replay <run-id>` | Print a run's event log |
| `pnpm cli team` | Show the loaded team and rendered prompt preview |
| `pnpm cli pricing` | Show the pricing table |
| `pnpm cli migrate` | Create or migrate the SQLite database |
| `pnpm cli settings` | Print effective settings |
| `pnpm cli settings set a.b=value` | Change settings from the terminal |
| `pnpm cli settings key <key>` | Store the API key outside the database |
| `pnpm cli settings test` | Probe the provider |
| `pnpm test` | Run the test suite |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm dev` | Server and Vite UI together |

## Sessions and context (per agent, never pooled)

Each running agent has its **own conversation and its own context budget**. A
1M-token model does not give "1M shared by everyone": every agent builds its own
request from its own history, so each one can use up to the model's window
independently.

| Thing | Scope |
|---|---|
| Message history (`messages`) | **Per agent + per task** (`task_id`, `agent_id`) |
| Context budget before compaction | **Per agent** (`limits.contextTokens`, default 120k; override per role with `models.roles.<id>.contextTokens`) |
| Model context window | Per API request, enforced by the provider |
| Email/mailbox (`message_agent`) | Per target agent |
| Shared knowledge | `SPEC.md`, `NOTES.md`, explicit messages — files, not hidden context |
| Budget in USD | **Per run** (one goal, one cap) — this is money, not context |

Set a different budget per agent in the Settings tab; e.g. give the Boss 900k and
QA 200k. When an agent exceeds its budget, only *that agent's* older turns are
compacted; other agents are untouched.

A new task starts a new agent session even for the same role. That is deliberate
isolation: task A cannot quietly pollute task B. Pass knowledge through
`SPEC.md`, `NOTES.md` or `message_agent` instead.



Environment variables are documented in `.env.example`. They only act as
defaults and as optional pins: after the first boot, runtime settings live in
the database and are edited from the UI. Roles and the team are YAML in
`config/roles/*.yaml` and `config/team.default.yaml`; `${BOSS_MODEL}`,
`${WORKER_MODEL}` and `${CHEAP_MODEL}` are filled from the effective settings,
and per-role overrides take precedence over both.

## Architecture

```text
apps/web        React + Vite: dispatch, activity log, approvals, settings
apps/cli        headless runner, settings commands and DB migration
apps/server     Express + ws + SQLite implementation of the Store contract
packages/agents providers, runtime (loop, budget, context), tools, orchestrator, roles
packages/shared Zod schemas, event types, settings schemas, constants, errors
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
