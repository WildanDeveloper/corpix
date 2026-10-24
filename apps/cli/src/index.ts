import path from "node:path";
import { loadTeam, renderPrompt, envForRoles } from "@corpix/agents";
import { parseEnv } from "@corpix/shared";
import { openMigrated, SqliteStore } from "@corpix/server/db";
import "dotenv/config";
import { runGoal, loadPricing } from "./run";

const [, , command, ...rest] = process.argv;

async function main(): Promise<number> {
  const env = parseEnv(process.env);
  const configDir = path.join(process.cwd(), "config");

  switch (command) {
    case "run":
      return await runCommand(rest, env);
    case "runs":
      return listRuns(env);
    case "replay":
      return replay(rest[0], env);
    case "team":
      return showTeam(configDir, env);
    case "pricing":
      return showPricing(configDir);
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

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function listRuns(env: ReturnType<typeof parseEnv>): number {
  const store = new SqliteStore(openMigrated(path.join(env.DATA_DIR, "corpix.sqlite")));
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
  const store = new SqliteStore(openMigrated(path.join(env.DATA_DIR, "corpix.sqlite")));
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
  const team = await loadTeam(configDir, "team.default.yaml", envForRoles(env));
  process.stdout.write(`${team.team.name}\n`);
  process.stdout.write(`Boss: ${team.boss.name} (${team.boss.role.id})\n`);
  for (const worker of team.workers) {
    const role = worker.role;
    process.stdout.write(
      `- ${worker.name} (${role.id}): model ${role.model}, ${role.maxSteps} steps, writes ${role.scope.write.join(", ") || "nothing"}\n`,
    );
  }
  process.stdout.write(
    `\nPrompt preview (${team.boss.role.id}):\n${renderPrompt(team.boss.role.systemPrompt, {
      name: team.boss.name,
      title: team.boss.role.title,
      company: "Corpix",
      workspace: process.cwd(),
      role: team.boss.role,
      bossName: team.boss.name,
      roles: [...team.roles.keys()],
    }).slice(0, 400)}...\n`,
  );
  return 0;
}

async function showPricing(configDir: string): Promise<number> {
  const pricing = await loadPricing(configDir);
  const models = Object.keys(pricing);
  if (models.length === 0) {
    process.stdout.write("No pricing entries. Fill in config/pricing.yaml.\n");
    return 0;
  }
  for (const model of models) {
    const p = pricing[model]!;
    process.stdout.write(`${model}: in $${p.input}/M, out $${p.output}/M, cached $${p.cached_input ?? p.input}/M\n`);
  }
  return 0;
}

function migrate(env: ReturnType<typeof parseEnv>): number {
  const store = new SqliteStore(openMigrated(path.join(env.DATA_DIR, "corpix.sqlite")));
  process.stdout.write(`Migrated ${path.join(env.DATA_DIR, "corpix.sqlite")}\n`);
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
      "  pnpm cli team                 Show the loaded team and roles",
      "  pnpm cli pricing              Show the pricing table",
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
