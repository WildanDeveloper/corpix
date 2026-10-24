# Corpix

> Run your own AI software company. You are the boss; a team of agents plans,
> builds and reviews while you watch.

![The Corpix office](docs/screenshots/office.png)

**Status: Phase 3 (working team).** The headless core, settings, git isolation,
QA review loop, crash recovery, prompt caching and a pixel-art office are in
place. See [`docs/DESIGN.md`](./docs/DESIGN.md) for the full target design.

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
- **QA review loop** — a reviewer reads the merged diff, runs the tests and either
  approves or opens fix tasks (bounded by `limits.reviewRounds`). Fix tasks are
  routed to the role that owns the failing area, then re-reviewed.
- **Git isolation** — one worktree and branch per task (`agent/<role>/<task>`), an
  `integration` branch cut from HEAD, merges in dependency order, and conflicts
  escalated instead of guessed. Agents never push; your checkout is untouched.
- **Runtime settings** — provider, API key, per-tier and per-role models, step
  caps, output caps, context budget, budget, approval mode, git and pricing are
  editable from the web UI, the API or the CLI. No restart needed.
- **Pixel-art office** — PixiJS 8 scene driven entirely by events: agents walk to
  their desks with A* pathfinding, type while writing files, glow at a terminal
  while running commands, raise a "!" when blocked and show a speech bubble when
  they report. Characters are drawn programmatically (12x16, palette per role),
  so no third-party art is bundled. Respects `prefers-reduced-motion`.
- **Web UI** — a dispatch/activity/approvals view, the office and a full settings
  panel, built with React + Vite.
- **Prompt caching** — the stable prefix is kept byte-identical and, for gateways
  that only cache leading user messages, the system prompt is folded into the
  first user turn. Cache hits are read from provider usage, priced at the cached
  rate, and reported as a hit percentage.
- **Crash recovery** — interrupted runs are marked paused on restart; resume
  continues only the unfinished tasks, reuses spend already recorded, and never
  re-merges a branch that already landed.
- **Command sandboxing** — `SANDBOX=bwrap` runs each command in a private mount
  and network namespace (no daemon needed), with only the worktree writable and a
  non-root uid; `docker` is supported when the daemon is available. A missing
  sandbox degrades to policy-and-jail with a visible warning.
- **Safety primitives** — workspace jail (`realpath` + trailing separator),
  protected files, write scopes, command policy, scrubbed child environment.
- **CLI** — `run`, `runs`, `replay`, `team`, `settings`, `pricing`, `migrate`.
- **HTTP/WS server** — health, projects, runs, events, approvals, usage,
  settings, models and a WebSocket event stream with `?since=` reconnect.
- **180 tests** covering the jail, glob matching, command policy, plan
  validation, budget maths, provider mapping, settings precedence, git
  isolation and merges, cancellation, and an end-to-end mock run.

Not implemented yet: a production packaging step and meetings.

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
| Provider | `mock` or `openai-compatible`, base URL, `max_tokens` vs `max_completion_tokens`, request timeout, forced-tool format, **prompt caching** |
| API key | stored in `data/secrets.json` (mode 600), **never** in SQLite and never returned to the browser |
| Models | Boss / worker / cheap model ids |
| Per-agent | model, max steps, **context tokens** and temperature for any role, overriding the tier default |
| Limits | concurrency, steps per task, **context tokens per agent**, task timeout, tool output cap, max output tokens, **QA review rounds**, budget per goal, budget action |
| Safety | approval mode, command sandbox (none / bwrap / docker) |
| Git | worktree isolation on/off, integration branch name, worktrees directory |
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
| `pnpm cli resume <run-id>` | Continue an interrupted or paused run |
| `pnpm cli team` | Show the loaded team and rendered prompt preview |
| `pnpm cli pricing` | Show the pricing table |
| `pnpm cli migrate` | Create or migrate the SQLite database |
| `pnpm cli settings` | Print effective settings |
| `pnpm cli settings set a.b=value` | Change settings from the terminal |
| `pnpm cli settings key <key>` | Store the API key outside the database |
| `pnpm cli settings test` | Probe the provider |
| `pnpm cli sandbox` | Show which command sandboxes are available |
| `pnpm test` | Run the test suite |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm dev` | Server and Vite UI together |

## QA review loop

After the first pass is merged, a reviewer (the `qa` role) checks the result:

1. It receives the goal, the list of changed files on `integration`, and the task
   reports. It reads `SPEC.md`, `NOTES.md` and the diffs.
2. It runs the project's tests and type checks through `run_command`, then calls
   `submit_report` with a verdict:
   - `done` — acceptable, the run can finish;
   - `failed` — broken, with every problem listed in `openIssues`;
   - `blocked` — could not verify (an inconclusive verdict ends the review).
3. For a `failed` verdict, each issue becomes a **fix task** (max 3 per round)
   assigned to the role that owns the area, by keyword routing:
   docs / devops / qa / frontend / backend. The fix task runs in its own worktree
   and is merged like any other task.
4. The result is reviewed again, up to `limits.reviewRounds` (default 2, `0`
   disables review entirely).

The run is only `completed` when every deliverable task is `done` **and** the
last review approved. If any deliverable failed, the review is skipped: there is
nothing trustworthy to approve. Review tasks themselves are recorded as tasks so the
transcript and cost stay auditable, but they are excluded from the completion
check.

Cost control: review is a normal agent run, so it consumes tokens. Set
`limits.reviewRounds=0` for cheap exploratory runs, or give the `qa` role a
cheaper model via `models.roles.qa.model`.

## Command sandboxing

Agent commands are the riskiest part of the system, so they can run inside a
sandbox instead of trusting the policy alone.

| `SANDBOX` | What it does | Needs |
|---|---|---|
| `none` | command policy + workspace jail only | nothing |
| `bwrap` | bubblewrap: private mount, PID and network namespace, non-root uid, only the worktree writable | `bwrap` installed and namespaces permitted |
| `docker` | one container per command, worktree mounted at `/work`, `--cap-drop ALL`, `no-new-privileges`, memory/CPU/pids limits | a running Docker daemon |

**Why bubblewrap first:** it needs no daemon and no image, so it works on a
normal Linux laptop and in CI. Inside the sandbox:

- the worktree is the only writable path, mounted at `/work`;
- the rest of the filesystem is read-only, so `/root`, `/home` and other
  projects are invisible;
- the network namespace is empty unless the command was approved as `network`
  (installs), so a prompt-injected `curl | sh` cannot reach the internet;
- the process runs as uid 1000, not root;
- the git directories a worktree points at are mounted so `git status`,
  `git diff` and `git log` keep working.

Check what your machine supports:

```bash
pnpm cli sandbox
# none    available    no isolation (policy and jail only)
# bwrap   available    bubblewrap 0.12.0
# docker  unavailable  docker is not installed
```

The Settings page shows the same list and disables the option when it is not
available. If the configured sandbox cannot start, the run logs
`sandbox_unavailable` and continues with policy and jail only — it never fails
silently.

## Resume after a crash

Runs are durable: the plan, every task, every message and every usage row are in
SQLite, so a crash does not lose the work that already finished.

1. On startup the server finds runs left in `planning`, `running`, `reviewing`
   or `merging` and marks them `paused`, resetting their agents to `idle`. The
   UI shows a **Resume** button; the API is `POST /api/runs/:id/resume`, the CLI
   is `pnpm cli resume <run-id> [--budget N]`.
2. Resume never redoes finished tasks. A task whose branch is already contained
   in `integration` is marked `done` even if the process died before updating
   the row, so a branch is never merged twice.
3. Tasks that were mid-flight, failed or blocked are retried in a fresh
   worktree, with their dependency edges intact.
4. Spend already recorded counts against the cap. A run paused on budget resumes
   paused unless you raise it: the UI asks for a new budget, the API takes
   `{ "budgetUsd": 5 }`, the CLI takes `--budget 5`.
5. Stale review tasks are cancelled and a fresh review runs at the end.

What cannot be resumed: a run that crashed during planning has no plan yet, so
the API refuses it and asks you to dispatch a new run. A run without a
registered project also refuses, because there is no workspace to reopen.



## Git isolation (how your repo stays safe)

With `git.enabled` (the default) each task runs in its own worktree and branch:

```text
<repo>                        your checkout, untouched
<repo>.worktrees/<taskId>     one checkout per task
<repo>.worktrees/.integration temporary checkout used for merges
integration                   branch created from HEAD at the start of the run
agent/<role>/<taskId>         branch for each task
```

1. The orchestrator refuses to isolate when your working tree is dirty, and falls
   back to a shared workspace (with a log line) rather than committing your
   uncommitted work.
2. The Boss writes `SPEC.md` and `NOTES.md`; they are committed on `integration`
   first so every worker sees the contract.
3. Each task gets `agent/<role>/<taskId>` cut from `integration`.
4. When a task reports `done`, its work is committed and merged into
   `integration` **immediately**, so dependent tasks branch from a branch that
   already contains their dependencies.
5. A merge conflict aborts the merge, marks the task `blocked`, and emits
   `git.conflict`. Nothing is guessed.
6. The temporary worktrees are removed; the branches and `integration` remain.

Agents never push and never touch your branch. Review with
`git diff integration -- .` and merge with `git merge integration` when you are
happy.

Set `git.enabled=false` to go back to a shared workspace (useful for a quick
trial), and change `git.integrationBranch` if `integration` clashes with your
own branch names.

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

## Cost control

Agent loops resend the conversation on every step, so costs grow quickly if you
do not manage them.

- **Prompt caching.** The stable prefix (system prompt, tool schemas, task brief)
  comes first and never changes between steps, so providers can cache it. Set
  `provider.promptCaching`:
  - `auto` (default) relies on the provider's implicit prefix caching;
  - `anthropic` adds explicit `cache_control: ephemeral` markers on the system
    prompt and the last tool, for gateways that require them;
  - `off` sends no hints.
  Cached tokens are read from `prompt_tokens_details.cached_tokens`, priced at
  `cached_input` in the pricing table, and shown as a cache-hit percentage in the
  UI and in `GET /api/usage` (`cachedInputTokens`, `cacheHitRate`).
- **Budget guard.** The cap is checked after every API response and after a
  resume, so spend from before a crash still counts. When exceeded, the run
  **pauses** (default) or **stops**.
- **Model tiering.** Strongest model for the Boss, balanced for workers, cheap
  for docs and summaries.
- **Small outputs.** `edit_file` beats rewriting files; tool output is truncated;
  `read_file` accepts line ranges.
- **Hard limits.** `MAX_STEPS_PER_TASK`, `TASK_TIMEOUT_MINUTES`,
  `CONTEXT_TOKENS_PER_AGENT` and `MAX_CONCURRENT_AGENTS`.
- **Review cost.** `limits.reviewRounds=0` disables the QA loop for cheap runs,
  and `models.roles.qa.model` can point QA at a cheaper model.
- **Mock provider and local models.** Free to run; use them while building.

Note: implicit caching only helps when the prefix is byte-identical. Corpix keeps
the system prompt, tool schemas and task brief fixed and appends tool results, so
the prefix stays stable. Compaction rewrites only the middle of the conversation.

## The office

The office is a renderer, not a simulation. Every movement is caused by an event
that already exists in the run log, so what you see is always what happened.

| Event | Office reaction |
|---|---|
| `task.assigned` / `task.started` | agent walks from the entrance to its role's desk |
| `agent.state_changed` | thought bubble (`thinking`), typing (`working`), "!" (`blocked`), ✓ (`done`), ✖ (`error`) |
| `tool.called` with `write_file` / `edit_file` | typing pose; the desk monitor lights in the role colour |
| `tool.called` with `run_command` | terminal `>_` indicator |
| `message.sent` | speech bubble on the sender |
| `task.completed` / `task.failed` | wave and a summary bubble, or a red flag |
| `review.started` | the QA agent walks to its desk and announces the review |
| `run.finished` | everyone returns to idle |

Implementation notes:

- `apps/web/src/office/layout.ts` is pure data: 32x20 tiles, five zones, desks,
  props, and a `isWalkable` grid.
- `pathfinding.ts` is A* on a 4-neighbour grid, with path simplification.
- `sprites.ts` draws each frame into a 12x16 RGBA buffer, palette-swapped per
  role, so one character generator serves the whole team and nothing is
  downloaded.
- `scene.ts` owns the Pixi application, depth-sorts by screen position (an agent
  walking past a desk occludes it, a seated agent tucks behind), and is destroyed
  cleanly on unmount.
- `prefers-reduced-motion` replaces walking with instant moves.

The layout and pathfinding are covered by unit tests; the scene itself is
verified with Playwright screenshots.

## Architecture

```text
apps/web        React + Vite: office (PixiJS), dispatch, activity, approvals, settings
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
