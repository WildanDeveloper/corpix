import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  MockProvider,
  Orchestrator,
  loadTeam,
  type LoadedTeam,
} from "@corpix/agents";
import { defaultSettings, mergeSettings, type RuntimeSettings } from "@corpix/shared";

let workspace: string;
let team: LoadedTeam;

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-session-"));
  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("agent sessions", () => {
  it("gives every agent its own conversation, keyed by task", async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_sessions",
      approvalMode: "auto",
    });

    await orchestrator.run("Two agents work at the same time");

    const tasks = store.listTasks("run_sessions");
    expect(tasks.length).toBeGreaterThan(1);

    const firstMessages = tasks.map((task) => {
      const messages = store.listMessages(task.id);
      expect(messages.length).toBeGreaterThan(0);
      return JSON.stringify(messages[0]?.content);
    });

    // Different tasks must not share a transcript.
    expect(new Set(firstMessages).size).toBe(tasks.length);

    // Each message is attributed to exactly one agent.
    for (const task of tasks) {
      const agentIds = new Set(store.listMessages(task.id).map((row) => row.agentId));
      expect(agentIds.size).toBe(1);
    }
  });

  it("does not leak one agent's context into another", async () => {
    const store = new MemoryStore();
    const promptsSeen: string[] = [];
    const provider = new MockProvider({
      respond: (request) => {
        const firstUser = request.messages[0];
        if (firstUser && firstUser.content[0]?.type === "text") {
          promptsSeen.push(firstUser.content[0].text);
        }
        return undefined;
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_isolated",
      approvalMode: "auto",
    });

    await orchestrator.run("Keep contexts isolated");

    // Every worker prompt names its own task and no other task's id.
    const workerPrompts = promptsSeen.filter((prompt) => prompt.startsWith("Task "));
    expect(workerPrompts.length).toBeGreaterThan(1);
    for (const prompt of workerPrompts) {
      const ownTaskId = prompt.slice(5, prompt.indexOf(":"));
      const otherIds = workerPrompts
        .map((other) => other.slice(5, other.indexOf(":")))
        .filter((id) => id !== ownTaskId);
      for (const otherId of otherIds) {
        expect(prompt).not.toContain(otherId);
      }
    }
  });

  it("sizes the context budget per role, not per run", async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({
        limits: { contextTokens: 50_000 },
        models: { roles: { backend: { contextTokens: 1_000_000 } } },
      }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_ctx",
      approvalMode: "auto",
    });

    await orchestrator.run("Check context budgets");

    const backend = team.workers.find((worker) => worker.role.id === "backend")?.role;
    expect(backend?.contextTokens).toBeUndefined();

    // The override is applied to the orchestrator's copy, not the loaded team.
    const roles = (orchestrator as unknown as { team: LoadedTeam }).team;
    expect(roles.roles.get("backend")?.contextTokens).toBe(1_000_000);
    expect(roles.roles.get("qa")?.contextTokens).toBeUndefined();
  });
});
