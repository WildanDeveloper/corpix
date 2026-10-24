import { existsSync } from "node:fs";
import path from "node:path";
import {
  Orchestrator,
  applyRoleOverrides,
  createProviderFromSettings,
  envForRoles,
  loadTeam,
  type ApprovalRequest,
} from "@corpix/agents";
import { assertSafeBinding, maskSettings, type Env } from "@corpix/shared";
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
  const configDir = options.configDir ?? path.join(process.cwd(), "config");
  const bundle = openRuntime(env);
  const runtime = bundle.service.load();
  const team = applyRoleOverrides(
    await loadTeam(configDir, options.team ?? "team.default.yaml", envForRoles(env)),
    runtime.settings.models,
  );
  const pricing = { ...(await loadPricing(configDir)), ...runtime.settings.pricing };
  const provider = createProviderFromSettings(runtime);
  const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const rl = createInterface({ input: stdin, output: stdout });
  const approvalMode = options.approval ?? runtime.settings.safety.approvalMode;

  const approve = async (request: ApprovalRequest): Promise<boolean> => {
    if (approvalMode === "auto") return true;
    if (approvalMode === "auto-safe" && request.risk === "exec") {
      // Allowlist checks already happened; ask for installs only.
      if (!/install|add|update|upgrade/.test(request.summary)) return true;
    }
    const answer = await rl.question(
      `\n[approval] ${request.agentId} wants to run: ${request.summary}\nApprove? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  };

  const orchestrator = new Orchestrator({
    store: bundle.store,
    provider,
    team,
    runtime,
    workspacePath: path.resolve(options.project),
    projectId: path.basename(path.resolve(options.project)),
    runId,
    approvalMode,
    budgetUsd: options.budget ?? runtime.settings.limits.budgetUsdPerGoal,
    pricing,
    approve,
    limits: { reviewRounds: team.team.limits.reviewRounds },
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
    const outcome = await orchestrator.run(options.goal);
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
