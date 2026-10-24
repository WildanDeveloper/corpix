import path from "node:path";
import {
  SettingsService,
  applyRoleOverrides,
  capTeamSteps,
  detectSandboxes,
  envForRoles,
  loadTeam,
  probeProvider,
} from "@corpix/agents";
import {
  findRepoRoot,
  maskSettings,
  parseEnv,
  resolveDataDir,
  type SettingsPatch,
} from "@corpix/shared";
import { openMigrated, SqliteStore } from "@corpix/server/db";
import { config as loadDotenv } from "dotenv";
import { runGoal, loadPricing } from "./run";

const repoRoot = findRepoRoot();
loadDotenv({ path: path.join(repoRoot, ".env") });

const [, , command, ...rest] = process.argv;

async function main(): Promise<number> {
  const env = parseEnv(process.env);
  const configDir = path.join(repoRoot, "config");

  switch (command) {
    case "run":
      return await runCommand(rest, env);
    case "runs":
      return listRuns(env);
    case "replay":
      return replay(rest[0], env);
    case "resume":
      return await resumeCommand(rest, env);
    case "team":
      return showTeam(configDir, env);
    case "pricing":
      return showPricing(configDir);
    case "settings":
      return settingsCommand(rest, env);
    case "sandbox":
      return showSandbox();
    case "migrate":
      return migrate(env);
    case "help":
    case undefined:
      printHelp();
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printHelp();
      return 2;
  }
}

function openStore(env: ReturnType<typeof parseEnv>): SqliteStore {
  const dataDir = resolveDataDir(env.DATA_DIR, repoRoot);
  return new SqliteStore(
    openMigrated(path.join(dataDir, "corpix.sqlite")),
    path.join(dataDir, "secrets.json"),
  );
}

async function runCommand(args: string[], env: ReturnType<typeof parseEnv>): Promise<number> {
  const goal = args[0];
  if (!goal) {
    process.stderr.write('Usage: pnpm cli run "your goal" --project ./workspaces/my-app\n');
    return 2;
  }
  const project = flag(args, "--project") ?? ".";
  const budget = flag(args, "--budget");
  const approval = flag(args, "--approval");
  const team = flag(args, "--team");
  const quiet = args.includes("--quiet");

  if (!["ask", "auto-safe", "auto"].includes(approval ?? "ask")) {
    process.stderr.write("--approval must be ask, auto-safe or auto\n");
    return 2;
  }

  return await runGoal(
    {
      goal,
      project,
      budget: budget ? Number(budget) : undefined,
      approval: approval as "ask" | "auto-safe" | "auto" | undefined,
      team,
      quiet,
    },
    env,
  );
}

async function resumeCommand(
  args: string[],
  env: ReturnType<typeof parseEnv>,
): Promise<number> {
  const runId = args[0];
  if (!runId) {
    process.stderr.write("Usage: pnpm cli resume <run-id> [--budget 3]\n");
    return 2;
  }
  const store = openStore(env);
  const run = store.getRun(runId);
  if (!run) {
    process.stderr.write(`Unknown run: ${runId}\n`);
    store.close();
    return 1;
  }
  if (run.status === "completed") {
    process.stderr.write(`Run ${runId} is already completed.\n`);
    store.close();
    return 1;
  }
  const project = store.getProject(run.projectId);
  store.close();
  if (!project) {
    process.stderr.write(
      `Project ${run.projectId} is not registered; register it before resuming.\n`,
    );
    return 1;
  }
  const budget = flag(args, "--budget");
  return await runGoal(
    {
      goal: run.goal,
      project: project.repoPath,
      budget: budget ? Number(budget) : run.budgetUsd,
      resumeRunId: runId,
      approval: flag(args, "--approval") as "ask" | "auto-safe" | "auto" | undefined,
    },
    env,
  );
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function listRuns(env: ReturnType<typeof parseEnv>): number {
  const store = openStore(env);
  const runs = store.listRuns();
  if (runs.length === 0) {
    process.stdout.write("No runs yet.\n");
    return 0;
  }
  for (const run of runs) {
    process.stdout.write(
      `${run.id}  ${run.status.padEnd(9)}  $${run.spentUsd.toFixed(4)}  ${run.startedAt}  ${run.goal.slice(0, 60)}\n`,
    );
  }
  store.close();
  return 0;
}

function replay(runId: string | undefined, env: ReturnType<typeof parseEnv>): number {
  if (!runId) {
    process.stderr.write("Usage: pnpm cli replay <run-id>\n");
    return 2;
  }
  const store = openStore(env);
  const events = store.listEvents(runId);
  if (events.length === 0) {
    process.stderr.write(`No events for ${runId}\n`);
    return 1;
  }
  for (const event of events) {
    process.stdout.write(
      `${String(event.seq).padStart(4)} ${event.ts} ${event.type} ${JSON.stringify(event.payload)}\n`,
    );
  }
  store.close();
  return 0;
}

async function showTeam(configDir: string, env: ReturnType<typeof parseEnv>): Promise<number> {
  const store = openStore(env);
  const service = new SettingsService(store, process.env, env);
  const runtime = service.load();
  const team = capTeamSteps(
    applyRoleOverrides(
      await loadTeam(configDir, "team.default.yaml", envForRoles(env)),
      runtime.settings.models,
      runtime.settings.team.names,
    ),
    runtime.settings.limits.maxStepsPerTask,
  );
  process.stdout.write(`${team.team.name}\n`);
  process.stdout.write(`Boss: ${team.boss.name} (${team.boss.role.id}) -> ${team.boss.role.model}\n`);
  for (const worker of team.workers) {
    const role = worker.role;
    process.stdout.write(
      `- ${worker.name} (${role.id}) -> ${role.model}, ${role.maxSteps} steps, writes ${role.scope.write.join(", ") || "nothing"}\n`,
    );
  }
  if (runtime.locked.length > 0) {
    process.stdout.write(`\nPinned by environment: ${runtime.locked.join(", ")}\n`);
  }
  store.close();
  return 0;
}

async function showPricing(configDir: string): Promise<number> {
  const pricing = await loadPricing(configDir);
  const models = Object.keys(pricing);
  if (models.length === 0) {
    process.stdout.write("No pricing entries. Fill in config/pricing.yaml or use the settings page.\n");
    return 0;
  }
  for (const model of models) {
    const p = pricing[model]!;
    process.stdout.write(`${model}: in $${p.input}/M, out $${p.output}/M, cached $${p.cached_input ?? p.input}/M\n`);
  }
  return 0;
}

/**
 * `pnpm cli settings` prints the effective settings.
 * `pnpm cli settings set models.boss=gpt-4o-mini limits.maxStepsPerTask=20`
 * `pnpm cli settings key sk-...` stores the API key outside the database.
 * `pnpm cli settings test` probes the provider.
 */
async function settingsCommand(args: string[], env: ReturnType<typeof parseEnv>): Promise<number> {
  const store = openStore(env);
  const service = new SettingsService(store, process.env, env);

  try {
    if (args[0] === "key") {
      const key = args[1];
      if (!key) {
        process.stderr.write("Usage: pnpm cli settings key <api-key>\n");
        return 2;
      }
      const runtime = service.setApiKey(key);
      process.stdout.write(`API key saved. ${maskSettings(runtime).apiKeyPreview}\n`);
      return 0;
    }

    if (args[0] === "test") {
      const runtime = service.load();
      const result = await probeProvider(runtime, runtime.settings.models.boss);
      process.stdout.write(`${result.ok ? "OK" : "FAILED"}: ${result.detail}\n`);
      if (result.models.length > 0) {
        process.stdout.write(`Models: ${result.models.slice(0, 20).join(", ")}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (args[0] === "set") {
      const patch: Record<string, Record<string, unknown>> = {};
      for (const pair of args.slice(1)) {
        const index = pair.indexOf("=");
        if (index === -1) {
          process.stderr.write(`Ignoring "${pair}": expected path=value\n`);
          continue;
        }
        const dotted = pair.slice(0, index);
        const raw = pair.slice(index + 1);
        const [section, key, ...rest] = dotted.split(".");
        if (!section || !key) {
          process.stderr.write(`Ignoring "${pair}": expected section.key=value\n`);
          continue;
        }
        const value = coerce(raw);
        if (section === "team" && key === "names" && rest.length === 1) {
          const [roleId] = rest as [string];
          const names = (patch.team?.names as Record<string, string>) ?? {};
          names[roleId] = String(value);
          patch.team = { ...(patch.team ?? {}), names };
          continue;
        }
        if (section === "models" && key === "roles" && rest.length === 2) {
          const [roleId, field] = rest as [string, string];
          const roles = (patch.models?.roles as Record<string, Record<string, unknown>>) ?? {};
          roles[roleId] = { ...(roles[roleId] ?? {}), [field]: value };
          patch.models = { ...(patch.models ?? {}), roles };
          continue;
        }
        if (section === "pricing" && rest.length === 1) {
          const [field] = rest as [string];
          const pricing = (patch.pricing ?? {}) as Record<string, Record<string, unknown>>;
          pricing[key] = { ...(pricing[key] ?? {}), [field]: value };
          patch.pricing = pricing;
          continue;
        }
        if (rest.length > 0) {
          process.stderr.write(`Ignoring "${pair}": unknown path\n`);
          continue;
        }
        patch[section] = { ...(patch[section] ?? {}), [key]: value };
      }
      const runtime = service.save(patch as SettingsPatch);
      process.stdout.write(`${JSON.stringify(runtime.settings, null, 2)}\n`);
      if (runtime.locked.length > 0) {
        process.stdout.write(`Pinned by environment (ignored): ${runtime.locked.join(", ")}\n`);
      }
      return 0;
    }

    const runtime = service.load();
    process.stdout.write(`${JSON.stringify(maskSettings(runtime), null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

async function showSandbox(): Promise<number> {
  const available = await detectSandboxes();
  for (const entry of available) {
    const mark = entry.available ? "available" : "unavailable";
    process.stdout.write(`${entry.kind.padEnd(7)} ${mark.padEnd(12)} ${entry.detail}\n`);
  }
  return 0;
}

function migrate(env: ReturnType<typeof parseEnv>): number {
  const store = openStore(env);
  process.stdout.write(`Migrated ${path.join(resolveDataDir(env.DATA_DIR, repoRoot), "corpix.sqlite")}\n`);
  store.close();
  return 0;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Corpix CLI",
      "",
      "  pnpm cli run \"Build a REST API\" --project ./workspaces/todo --budget 3 --approval ask",
      "  pnpm cli runs                 List past runs",
      "  pnpm cli replay <run-id>      Replay a run from its event log",
      "  pnpm cli resume <run-id>      Continue an interrupted or paused run",
      "  pnpm cli team                 Show the team with effective models",
      "  pnpm cli pricing              Show the pricing table",
      "  pnpm cli settings             Print effective settings",
      "  pnpm cli settings set models.boss=gpt-4o limits.maxStepsPerTask=20",
      "  pnpm cli settings set models.roles.qa.model=gpt-4o-mini",
      "  pnpm cli settings set team.names.backend=Bruno team.company=\"Acme Corp\"",
      "  pnpm cli settings key <key>   Store the API key (data/secrets.json, mode 600)",
      "  pnpm cli settings test        Probe the provider",
      "  pnpm cli sandbox              Show available command sandboxes",
      "  pnpm cli migrate              Create or migrate the SQLite database",
      "",
    ].join("\n"),
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
