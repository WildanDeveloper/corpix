import { existsSync } from "node:fs";
import path from "node:path";
import {
  Orchestrator,
  applyRoleOverrides,
  approvalDecider,
  createProviderFromSettings,
  envForRoles,
  loadTeam,
} from "@corpix/agents";
import { assertSafeBinding, findRepoRoot, maskSettings, type Env } from "@corpix/shared";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import "dotenv/config";
import YAML from "yaml";
import { readFile } from "node:fs/promises";
import { openRuntime } from "./runtime";

export interface CliOptions {
  goal: string;
  project: string;
  budget?: number;
  approval?: "ask" | "auto-safe" | "auto";
  team?: string;
  configDir?: string;
  quiet?: boolean;
  /** Continue this run instead of starting a new one. */
  resumeRunId?: string;
}

export async function loadPricing(configDir: string): Promise<Record<string, { input: number; output: number; cached_input?: number }>> {
  const file = path.join(configDir, "pricing.yaml");
  if (!existsSync(file)) return {};
  const parsed = YAML.parse(await readFile(file, "utf8")) as Record<
    string,
    { input: number; output: number; cached_input?: number }
  > | null;
  return parsed ?? {};
}

export async function runGoal(options: CliOptions, env: Env): Promise<number> {
  assertSafeBinding(env);
  const configDir = options.configDir ?? path.join(findRepoRoot(), "config");
  const bundle = openRuntime(env);
  const runtime = bundle.service.load();
  const team = applyRoleOverrides(
    await loadTeam(configDir, options.team ?? "team.default.yaml", envForRoles(env)),
    runtime.settings.models,
  );
  const pricing = { ...(await loadPricing(configDir)), ...runtime.settings.pricing };
  const provider = createProviderFromSettings(runtime);
  const runId =
    options.resumeRunId ??
    `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const projectPath = path.resolve(options.project);

  // Remember the repo so `pnpm cli resume` can find it later.
  if (!options.resumeRunId) {
    const projectId = path.basename(projectPath);
    if (!bundle.store.getProject(projectId)) {
      bundle.store.createProject({
        id: projectId,
        name: projectId,
        repoPath: projectPath,
        createdAt: new Date().toISOString(),
      });
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const approvalMode = options.approval ?? runtime.settings.safety.approvalMode;

  const approve = approvalDecider(approvalMode, async (request) => {
    const answer = await rl.question(
      `\n[approval] ${request.agentId} wants to run: ${request.summary}\nApprove? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  });

  const orchestrator = new Orchestrator({
    store: bundle.store,
    provider,
    team,
    runtime,
    workspacePath: projectPath,
    projectId: path.basename(projectPath),
    runId,
    approvalMode,
    budgetUsd: options.budget ?? runtime.settings.limits.budgetUsdPerGoal,
    pricing,
    approve,
    onEvent: (envelope) => {
      if (options.quiet) return;
      const stamp = envelope.ts.slice(11, 19);
      const detail = summariseEvent(envelope.type, envelope.payload);
      process.stdout.write(`${stamp} ${envelope.type}${detail ? ` ${detail}` : ""}\n`);
    },
    log: (message) => {
      if (!options.quiet) process.stdout.write(`${message}\n`);
    },
  });

  try {
    const outcome = options.resumeRunId
      ? await orchestrator.resume(options.goal)
      : await orchestrator.run(options.goal);
    process.stdout.write(`\n${outcome.summary}\n`);
    process.stdout.write(
      `\nRun ${outcome.runId}: ${outcome.status}, spent $${outcome.spentUsd.toFixed(4)}\n`,
    );
    return outcome.status === "completed" ? 0 : 1;
  } finally {
    rl.close();
    bundle.close();
  }
}

export { maskSettings };
function summariseEvent(type: string, payload: Record<string, unknown>): string {
  if (type === "tool.called") return `${payload.agentId} -> ${payload.tool}`;
  if (type === "task.started") return `${payload.role}: ${payload.title}`;
  if (type === "task.completed" || type === "task.failed") return `${payload.role}: ${payload.status}`;
  if (type === "usage.updated") return `$${Number(payload.spentUsd).toFixed(4)}`;
  if (type === "error") return String(payload.message ?? "");
  if (type === "plan.created") return `${payload.taskCount} tasks`;
  return "";
}
