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
import {
  defaultSettings,
  mergeSettings,
  type RuntimeSettings,
  type TaskStatus,
} from "@corpix/shared";

let workspace: string;
let team: LoadedTeam;

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-resume-"));
  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Seed a run as if a previous process had died mid-flight. */
function seedInterruptedRun(store: MemoryStore, runId: string, taskStates: TaskStatus[]) {
  store.createRun({
    id: runId,
    projectId: "test",
    goal: "Finish the work",
    status: "running",
    plan: {
      summary: "two tasks",
      tasks: [
        {
          id: "t1",
          role: "backend",
          title: "Create the API entry point",
          instructions: "make it",
          dependsOn: [],
          acceptanceCriteria: ["exists"],
        },
        {
          id: "t2",
          role: "frontend",
          title: "Create the web entry point",
          instructions: "make it",
          dependsOn: ["t1"],
          acceptanceCriteria: ["exists"],
        },
      ],
    },
    budgetUsd: 5,
    spentUsd: 0.25,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    summary: null,
  });

  const ids = ["task_a", "task_b"];
  taskStates.forEach((status, index) => {
    const id = ids[index] as string;
    store.createTask({
      id,
      runId,
      parentId: null,
      role: index === 0 ? "backend" : "frontend",
      title: index === 0 ? "Create the API entry point" : "Create the web entry point",
      instructions: "make it",
      status,
      dependsOn: index === 0 ? [] : ["task_a"],
      acceptanceCriteria: ["exists"],
      branch: null,
      report: null,
      startedAt: null,
      finishedAt: null,
    });
  });
}

describe("resume after a crash", () => {
  it("finishes the remaining tasks and keeps the spend", async () => {
    const store = new MemoryStore();
    const events: string[] = [];
    seedInterruptedRun(store, "run_resume", ["done", "running"]);

    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 0 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_resume",
      approvalMode: "auto",
      onEvent: (event) => events.push(event.type),
    });

    const outcome = await orchestrator.resume("Finish the work");

    expect(outcome.status).toBe("completed");
    expect(events[0]).toBe("run.resumed");
    // The already-done task is not executed again.
    const started = events.filter((type) => type === "task.started");
    expect(started.length).toBe(1);
    expect(store.getRun("run_resume")?.status).toBe("completed");
  });

  it("counts spend recorded before the crash against the budget", async () => {
    const store = new MemoryStore();
    seedInterruptedRun(store, "run_spent", ["pending", "pending"]);
    // Simulate a run that already burned most of its cap.
    store.updateRun("run_spent", { spentUsd: 4.999 });

    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({
        limits: { reviewRounds: 0, budgetUsdPerGoal: 5 },
        pricing: {
          "boss-model": { input: 1_000_000, output: 1_000_000 },
          "worker-model": { input: 1_000_000, output: 1_000_000 },
        },
      }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_spent",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.resume("Finish the work");
    // The first model call pushes past the cap, so the run pauses instead of
    // silently starting from zero.
    expect(outcome.status).toBe("paused");
    expect(outcome.spentUsd).toBeGreaterThanOrEqual(4.999);
  });

  it("refuses to resume a completed run", async () => {
    const store = new MemoryStore();
    seedInterruptedRun(store, "run_done", ["done", "done"]);
    store.updateRun("run_done", { status: "completed" });

    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_done",
      approvalMode: "auto",
    });

    await expect(orchestrator.resume("again")).rejects.toThrow(/already completed/);
  });

  it("needs a run id", async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      approvalMode: "auto",
    });
    await expect(orchestrator.resume("x")).rejects.toThrow(/needs the run id/);
  });

  it("cancels stale review tasks instead of rerunning them", async () => {
    const store = new MemoryStore();
    seedInterruptedRun(store, "run_stale", ["done", "done"]);
    store.createTask({
      id: "review_old",
      runId: "run_stale",
      parentId: null,
      role: "qa",
      title: "Review round 1 of 1",
      instructions: "review",
      status: "blocked",
      dependsOn: [],
      acceptanceCriteria: ["verdict"],
      branch: null,
      report: null,
      startedAt: null,
      finishedAt: null,
    });

    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 0 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_stale",
      approvalMode: "auto",
    });

    await orchestrator.resume("Finish the work");
    expect(store.getTask("review_old")?.status).toBe("cancelled");
  });
});
