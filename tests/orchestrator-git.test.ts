import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  MockProvider,
  Orchestrator,
  loadTeam,
  type LoadedTeam,
} from "@corpix/agents";
import { defaultSettings, mergeSettings, type RuntimeSettings } from "@corpix/shared";

const run = promisify(execFile);
const created: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@e.st",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@e.st",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return stdout;
}

let repo: string;
let team: LoadedTeam;

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-orch-git-"));
  created.push(repo);
  await git(repo, ["init", "-q", "-b", "main"]);
  await fs.writeFile(path.join(repo, "README.md"), "# project\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "init"]);

  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(`${dir}.worktrees`, { recursive: true, force: true });
  }
});

describe("orchestrator with git isolation", () => {
  it("creates a worktree per task and merges the results", async () => {
    const store = new MemoryStore();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({ git: { enabled: true, integrationBranch: "integration" } }),
      workspacePath: repo,
      projectId: "test",
      runId: "run_git",
      approvalMode: "auto",
      onEvent: (envelope) =>
        events.push({ type: envelope.type, payload: envelope.payload }),
    });

    const outcome = await orchestrator.run("Build two small things");
    expect(outcome.status).toBe("completed");
    const types = events.map((event) => event.type);
    expect(types).toContain("git.ready");
    expect(types).toContain("git.worktree_created");
    expect(types).toContain("git.merged");

    // Every done task has its own branch.
    const done = outcome.tasks.filter((task) => task.status === "done");
    expect(done.length).toBeGreaterThan(1);
    for (const task of done) {
      expect(task.branch).toMatch(/^agent\//);
    }

    // The integration branch exists and contains the agent output.
    const tracked = (await git(repo, ["ls-tree", "-r", "--name-only", "integration"])).split("\n");
    expect(tracked).toContain("README.md");
    expect(tracked.some((file) => file.endsWith("mock-output.ts"))).toBe(true);

    // The integration worktree is released; the branch is the deliverable.
    await expect(fs.access(path.join(`${repo}.worktrees`, ".integration"))).rejects.toThrow();
    const leftovers = await fs.readdir(`${repo}.worktrees`).catch(() => [] as string[]);
    expect(leftovers.filter((entry) => !entry.startsWith("."))).toEqual([]);

    // The user's working copy is untouched: still on main, no agent files.
    const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    expect(branch).toBe("main");
    const userFiles = await git(repo, ["ls-files"]);
    expect(userFiles).not.toContain("mock-output.ts");

    // A dependent task starts only after its dependencies are merged, so its
    // worktree already contains their files.
    const dependent = outcome.tasks.find((task) => task.dependsOn.length > 0);
    expect(dependent).toBeDefined();
    if (!dependent) return;
    const startedAt = events.findIndex(
      (event) => event.type === "task.started" && event.payload.taskId === dependent.id,
    );
    expect(startedAt).toBeGreaterThan(-1);
    for (const dependencyId of dependent.dependsOn) {
      const mergedAt = events.findIndex(
        (event) => event.type === "git.merged" && event.payload.taskId === dependencyId,
      );
      expect(mergedAt).toBeGreaterThan(-1);
      expect(mergedAt).toBeLessThan(startedAt);
    }
  });

  it("falls back to a shared workspace when git is disabled", async () => {
    const store = new MemoryStore();
    const events: string[] = [];
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({ git: { enabled: false } }),
      workspacePath: repo,
      projectId: "test",
      runId: "run_nogit",
      approvalMode: "auto",
      onEvent: (envelope) => events.push(envelope.type),
    });

    await orchestrator.run("Build without isolation");
    expect(events).not.toContain("git.ready");
    // No worktree directory was created.
    await expect(fs.access(`${repo}.worktrees`)).rejects.toThrow();
  });

  it("runs without isolation when the workspace is not a repository", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-plain-"));
    created.push(plain);
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({}),
      workspacePath: plain,
      projectId: "test",
      runId: "run_plain",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("Plain directory");
    expect(outcome.status).toBe("completed");
  });

  it("keeps uncommitted user changes safe by not isolating", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "# edited but not committed\n");
    const store = new MemoryStore();
    const events: string[] = [];
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime: runtimeWith({}),
      workspacePath: repo,
      projectId: "test",
      runId: "run_dirty",
      approvalMode: "auto",
      onEvent: (envelope) => events.push(envelope.type),
    });

    await orchestrator.run("Dirty workspace");
    expect(events).not.toContain("git.ready");
    // The user's edit is still there, untouched.
    expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe(
      "# edited but not committed\n",
    );
  });
});
