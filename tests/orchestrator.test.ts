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
import type { EventEnvelope, EventType } from "@corpix/shared";

let workspace: string;
let configDir: string;
let team: LoadedTeam;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-ws-"));
  configDir = path.resolve(__dirname, "..", "config");
  team = await loadTeam(configDir, "team.default.yaml", {
    BOSS_MODEL: "boss-model",
    WORKER_MODEL: "worker-model",
    CHEAP_MODEL: "cheap-model",
  });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function collect() {
  const events: EventEnvelope[] = [];
  return {
    events,
    onEvent: (event: EventEnvelope) => events.push(event),
    types: (): EventType[] => events.map((event) => event.type),
  };
}

describe("Orchestrator with the mock provider", () => {
  it("plans, schedules and completes every task", async () => {
    const store = new MemoryStore();
    const sink = collect();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_test",
      approvalMode: "auto",
      budgetUsd: 5,
      onEvent: sink.onEvent,
    });

    const outcome = await orchestrator.run("Build something small");

    expect(outcome.status).toBe("completed");
    expect(outcome.tasks.length).toBeGreaterThan(0);
    expect(outcome.tasks.every((task) => task.status === "done")).toBe(true);

    const types = sink.types();
    expect(types[0]).toBe("run.started");
    expect(types).toContain("plan.created");
    expect(types).toContain("task.started");
    expect(types).toContain("tool.called");
    expect(types.at(-1)).toBe("run.finished");

    const persisted = store.listEvents("run_test");
    expect(persisted.length).toBe(sink.events.length);
    expect(persisted.map((event) => event.seq)).toEqual(
      persisted.map((_, index) => index + 1),
    );
  });

  it("respects dependencies: a dependent task starts after its dependency", async () => {
    const store = new MemoryStore();
    const sink = collect();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_deps",
      approvalMode: "auto",
      onEvent: sink.onEvent,
      limits: { maxConcurrentAgents: 3 },
    });

    await orchestrator.run("Do two things");

    const tasks = store.listTasks("run_deps");
    const dependent = tasks.find((task) => task.dependsOn.length > 0);
    expect(dependent).toBeDefined();
    if (!dependent) return;
    const dependency = tasks.find((task) => task.id === dependent.dependsOn[0]);
    expect(dependency).toBeDefined();
    if (!dependency) return;
    expect(dependency.finishedAt).not.toBeNull();
    expect(dependent.startedAt).not.toBeNull();
    expect(new Date(dependent.startedAt as string).getTime()).toBeGreaterThanOrEqual(
      new Date(dependency.finishedAt as string).getTime(),
    );
  });

  it("never exceeds the concurrency limit", async () => {
    const store = new MemoryStore();
    let maxInFlight = 0;
    let inFlight = 0;

    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_conc",
      approvalMode: "auto",
      limits: { maxConcurrentAgents: 1 },
      onEvent: (event) => {
        if (event.type === "task.started") {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
        }
        if (event.type === "task.completed" || event.type === "task.failed") {
          inFlight -= 1;
        }
      },
    });

    await orchestrator.run("Do several things");
    expect(maxInFlight).toBe(1);
  });

  it("pauses when the budget is exceeded", async () => {
    const store = new MemoryStore();
    const sink = collect();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_budget",
      approvalMode: "auto",
      budgetUsd: 0.0000001,
      pricing: { "boss-model": { input: 1_000_000, output: 1_000_000 } },
      onEvent: sink.onEvent,
    });

    const outcome = await orchestrator.run("Spend money");
    expect(outcome.status).toBe("paused");
    expect(sink.types()).toContain("run.paused");
  });

  it("retries planning when the Boss submits an invalid plan", async () => {
    const store = new MemoryStore();
    let attempt = 0;
    const provider = new MockProvider({
      respond: (request) => {
        const planning = request.tools.some((tool) => tool.name === "submit_plan");
        if (!planning) return undefined;
        attempt += 1;
        if (attempt === 1) {
          return {
            content: [
              {
                type: "tool_call",
                id: "bad",
                name: "submit_plan",
                input: {
                  summary: "broken",
                  tasks: [
                    {
                      id: "t1",
                      role: "nonexistent",
                      title: "x",
                      instructions: "y",
                      dependsOn: [],
                      acceptanceCriteria: ["z"],
                    },
                  ],
                },
              },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return undefined;
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_retry",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("Needs a retry");
    expect(attempt).toBe(2);
    expect(outcome.status).toBe("completed");
    expect(store.listEvents("run_retry").some((event) => event.type === "error")).toBe(true);
  });

  it("records usage rows for every model call", async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_usage",
      approvalMode: "auto",
      pricing: { "boss-model": { input: 1, output: 1 }, "worker-model": { input: 1, output: 1 } },
    });

    await orchestrator.run("Track usage");
    const usage = store.listUsage("run_usage");
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.usage.inputTokens > 0)).toBe(true);
    expect(store.getRun("run_usage")?.spentUsd).toBeGreaterThan(0);
  });
});
