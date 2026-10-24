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
    // Transcripts are still per task (that is what the audit trail needs), but
    // the session memory below is per role and survives across tasks.
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

    // Every worker prompt names its own task and no other task's id. The task
    // line is not always first: a second task for the same role is prefixed
    // with that agent's session memory.
    const workerPrompts = promptsSeen.filter((prompt) => /(^|\n)Task [\w-]+:/.test(prompt));
    expect(workerPrompts.length).toBeGreaterThan(1);
    const taskIds = workerPrompts.map((prompt) => /(?:^|\n)Task ([\w-]+):/.exec(prompt)?.[1] ?? "");
    for (const prompt of workerPrompts) {
      const ownTaskId = /(?:^|\n)Task ([\w-]+):/.exec(prompt)?.[1] ?? "";
      for (const otherId of taskIds.filter((id) => id !== ownTaskId)) {
        expect(prompt).not.toContain(`Task ${otherId}:`);
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

describe("per-agent sessions", () => {
  async function runTwice() {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_session_memory",
      approvalMode: "auto",
    });
    await orchestrator.run("Ship something with several tasks");
    return { store };
  }

  it("creates one session per role, not one shared session", async () => {
    const { store } = await runTwice();
    const sessions = store.listAgentSessions("run_session_memory");
    expect(sessions.length).toBeGreaterThan(1);
    const roles = sessions.map((session) => session.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("records a memory and a task count per role", async () => {
    const { store } = await runTwice();
    for (const session of store.listAgentSessions("run_session_memory")) {
      expect(session.tasks).toBeGreaterThan(0);
      expect(session.memory.length).toBeGreaterThan(0);
      expect(session.memory).toContain("->");
    }
  });

  it("never leaks one role's memory into another role's session", async () => {
    const { store } = await runTwice();
    for (const session of store.listAgentSessions("run_session_memory")) {
      for (const other of store.listAgentSessions("run_session_memory")) {
        if (other.role === session.role) continue;
        // Each memory only names the tasks that role actually worked on.
        const tasks = store.listTasks("run_session_memory").filter((task) => task.role === other.role);
        for (const task of tasks) {
          expect(session.memory).not.toContain(task.title);
        }
      }
    }
  });

  it("carries the memory into the next task for the same role", async () => {
    const store = new MemoryStore();
    const prompts: string[] = [];
    const provider = new MockProvider({
      respond: (request) => {
        const first = request.messages[0];
        if (first?.content[0]?.type === "text") prompts.push(first.content[0].text);
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
      runId: "run_carry",
      approvalMode: "auto",
    });
    await orchestrator.run("Two tasks for the same role");

    // Seed a second task for a role that already has a session.
    const sessions = store.listAgentSessions("run_carry");
    const seeded = sessions[0];
    expect(seeded).toBeTruthy();
    store.writeAgentSession({ ...seeded!, memory: "- earlier work: added the API", tasks: 1 });

    const brief = {
      id: "t99",
      title: "Second pass",
      instructions: "continue",
      acceptanceCriteria: ["ok"],
      memory: store.readAgentSession("run_carry", seeded!.role)?.memory ?? "",
      previousTasks: 1,
    };
    const { buildTaskPrompt } = await import("@corpix/agents");
    const prompt = buildTaskPrompt(brief, team.workers[0]!.role);
    expect(prompt).toContain("not your first task here");
    expect(prompt).toContain("added the API");
  });
});
