import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, Orchestrator, loadTeam, type LoadedTeam, type LLMProvider } from "@corpix/agents";
import { defaultSettings, mergeSettings, type RuntimeSettings } from "@corpix/shared";

let workspace: string;
let team: LoadedTeam;

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-cache-"));
  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * A planner/worker that reports usage with a large cached prefix, so we can
 * assert that cache hits survive the whole pipeline.
 */
function cachedProvider(): LLMProvider {
  let planCalls = 0;
  return {
    name: "cached",
    async complete(request) {
      planCalls += 1;
      const isBoss = request.tools.some((tool) => tool.name === "submit_plan");
      if (isBoss) {
        return {
          content: [
            {
              type: "tool_call",
              id: "plan",
              name: "submit_plan",
              input: {
                summary: "one task",
                tasks: [
                  {
                    id: "t1",
                    role: "backend",
                    title: "Do the thing",
                    instructions: "do it",
                    dependsOn: [],
                    acceptanceCriteria: ["done"],
                  },
                ],
              },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1_000, outputTokens: 50, cachedInputTokens: 800 },
        };
      }
      const alreadyReported = request.messages.some(
        (message) =>
          message.role === "user" && message.content.some((block) => block.type === "tool_result"),
      );
      if (!alreadyReported) {
        return {
          content: [
            {
              type: "tool_call",
              id: "w1",
              name: "write_file",
              input: { path: `apps/server/file-${planCalls}.ts`, content: "export const a = 1;\n" },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 2_000, outputTokens: 80, cachedInputTokens: 1_500 },
        };
      }
      return {
        content: [
          {
            type: "tool_call",
            id: "r1",
            name: "submit_report",
            input: {
              status: "done",
              summary: "done",
              filesChanged: [],
              commandsRun: [],
              openIssues: [],
            },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 2_500, outputTokens: 60, cachedInputTokens: 2_000 },
      };
    },
  };
}

describe("prompt caching observability", () => {
  it("carries cached tokens into usage events and the store", async () => {
    const store = new MemoryStore();
    const updates: Array<Record<string, unknown>> = [];
    const orchestrator = new Orchestrator({
      store,
      provider: cachedProvider(),
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 0 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_cache",
      approvalMode: "auto",
      onEvent: (event) => {
        if (event.type === "usage.updated") updates.push(event.payload);
      },
    });

    await orchestrator.run("Use the cache");

    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.cachedInputTokens).toBeGreaterThan(0);
      expect(update.cacheHitRate).toBeGreaterThan(0);
    }

    const usage = store.listUsage("run_cache");
    expect(usage.every((row) => (row.usage.cachedInputTokens ?? 0) > 0)).toBe(true);
  });

  it("charges cached tokens at the cached rate", async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: cachedProvider(),
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 0 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_cache_cost",
      approvalMode: "auto",
      pricing: {
        "boss-model": { input: 1_000, output: 2_000, cached_input: 100 },
        "worker-model": { input: 1_000, output: 2_000, cached_input: 100 },
      },
    });

    await orchestrator.run("Price the cache");
    const rows = store.listUsage("run_cache_cost");
    expect(rows.length).toBeGreaterThan(0);
    // 800 cached of 1000 input on the plan call, at the cheap cached rate.
    const plan = rows.find((row) => row.usage.cachedInputTokens === 800);
    expect(plan).toBeDefined();
    if (!plan) return;
    const expected =
      (200 / 1_000_000) * 1_000 + (800 / 1_000_000) * 100 + (50 / 1_000_000) * 2_000;
    expect(plan.costUsd).toBeCloseTo(expected, 8);
  });
});
