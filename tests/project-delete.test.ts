import { describe, expect, it } from "vitest";
import { MemoryStore } from "@corpix/agents";

function seed(store: MemoryStore, projectId: string, runId: string): void {
  store.createProject({
    id: projectId,
    name: "demo",
    repoPath: "/tmp/does-not-matter",
    createdAt: new Date().toISOString(),
  });
  store.createRun({
    id: runId,
    projectId,
    goal: "build something",
    status: "completed",
    plan: null,
    budgetUsd: 1,
    spentUsd: 0,
    summary: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  store.appendEvent(runId, "run.started", { goal: "build something" });
  store.createTask({
    id: `${runId}_t1`,
    runId,
    parentId: null,
    role: "frontend",
    title: "Do the thing",
    instructions: "do it",
    status: "done",
    dependsOn: [],
    acceptanceCriteria: ["it exists"],
    branch: null,
    report: null,
    startedAt: null,
    finishedAt: null,
  });
  store.writeAgentSession({
    runId,
    role: "frontend",
    memory: "- did the thing",
    tasks: 1,
    inputTokens: 10,
    outputTokens: 2,
    updatedAt: new Date().toISOString(),
  });
}

describe("deleting a project", () => {
  it("removes the project, its runs, tasks, events and sessions", () => {
    const store = new MemoryStore();
    seed(store, "prj_a", "run_a");
    seed(store, "prj_b", "run_b");

    store.deleteProject("prj_a");

    expect(store.listProjects().map((project) => project.id)).toEqual(["prj_b"]);
    expect(store.getRun("run_a")).toBeNull();
    expect(store.listTasks("run_a")).toEqual([]);
    expect(store.listEvents("run_a")).toEqual([]);
    expect(store.readAgentSession("run_a", "frontend")).toBeNull();
    // The other project is untouched.
    expect(store.getRun("run_b")).not.toBeNull();
    expect(store.listEvents("run_b").length).toBe(1);
  });
});
