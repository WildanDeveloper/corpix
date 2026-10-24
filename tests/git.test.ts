import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "@corpix/agents";

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

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-git-"));
  created.push(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await fs.writeFile(path.join(dir, "README.md"), "# repo\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(`${dir}.worktrees`, { recursive: true, force: true });
  }
});

describe("GitWorkspace", () => {
  it("refuses a directory that is not a git repository", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-nogit-"));
    created.push(dir);
    await expect(GitWorkspace.open(dir)).rejects.toThrow(/not a git repository/);
  });

  it("creates the integration branch from HEAD", async () => {
    const repo = await makeRepo();
    const workspace = await GitWorkspace.open(repo);
    const result = await workspace.ensureIntegrationBranch();
    expect(result.created).toBe(true);
    expect(result.branch).toBe("integration");
    expect(await workspace.branchExists("integration")).toBe(true);
    // Idempotent on a second call.
    expect((await workspace.ensureIntegrationBranch()).created).toBe(false);
  });

  it("creates one worktree per task on its own branch", async () => {
    const repo = await makeRepo();
    const workspace = await GitWorkspace.open(repo);
    await workspace.ensureIntegrationBranch();

    const a = await workspace.createWorktree("task_a", "backend");
    const b = await workspace.createWorktree("task_b", "frontend");

    expect(a.branch).toBe("agent/backend/task_a");
    expect(b.branch).toBe("agent/frontend/task_b");
    expect(a.path).not.toBe(b.path);
    expect(await fs.readdir(a.path)).toContain("README.md");

    // A write in one worktree must not appear in the other.
    await fs.writeFile(path.join(a.path, "only-a.txt"), "a\n");
    await expect(fs.access(path.join(b.path, "only-a.txt"))).rejects.toThrow();
    // Nor in the user's checkout.
    await expect(fs.access(path.join(repo, "only-a.txt"))).rejects.toThrow();
  });

  it("commits agent output and reports changed files", async () => {
    const repo = await makeRepo();
    const workspace = await GitWorkspace.open(repo);
    await workspace.ensureIntegrationBranch();
    const worktree = await workspace.createWorktree("task_c", "backend");

    await fs.mkdir(path.join(worktree.path, "apps/server"), { recursive: true });
    await fs.writeFile(path.join(worktree.path, "apps/server/index.ts"), "export const a = 1;\n");

    const commit = await workspace.commitAll(worktree.path, "backend: add index");
    expect(commit.committed).toBe(true);
    expect(commit.sha).toBeTruthy();

    const changed = await workspace.diffNames(worktree.branch);
    expect(changed).toContain("apps/server/index.ts");
  });

  it("reports no commit when nothing changed", async () => {
    const repo = await makeRepo();
    const workspace = await GitWorkspace.open(repo);
    await workspace.ensureIntegrationBranch();
    const worktree = await workspace.createWorktree("task_empty", "qa");
    const commit = await workspace.commitAll(worktree.path, "qa: nothing");
    expect(commit.committed).toBe(false);
  });

  it("merges a task branch into the integration branch", async () => {
    const repo = await makeRepo();
    const workspace = await GitWorkspace.open(repo);
    await workspace.ensureIntegrationBranch();

    const worktree = await workspace.createWorktree("task_merge", "backend");
    await fs.writeFile(path.join(worktree.path, "feature.ts"), "export const ok = true;\n");
    await workspace.commitAll(worktree.path, "backend: feature");

    const outcome = await workspace.mergeIntoIntegration(worktree.branch);
    expect(outcome.status).toBe("merged");

    // The file is now on the integration branch, and the user's branch is clean.
    const integrationPath = await workspace.ensureIntegrationWorktree();
    expect(await fs.readFile(path.join(integrationPath, "feature.ts"), "utf8")).toContain("ok");
    expect(await workspace.currentRef()).toBe("main");
    await expect(fs.access(path.join(repo, "feature.ts"))).rejects.toThrow();
  });

  it("reports a conflict and aborts the merge instead of guessing", async () => {
    const repo = await makeRepo();
    const workspace = await GitWorkspace.open(repo);
    await workspace.ensureIntegrationBranch();

    // Two branches diverge from the same base and edit the same line.
    const first = await workspace.createWorktree("task_first", "backend");
    const second = await workspace.createWorktree("task_second", "frontend");
    await fs.writeFile(path.join(first.path, "README.md"), "# changed by first\n");
    await workspace.commitAll(first.path, "first");
    await fs.writeFile(path.join(second.path, "README.md"), "# changed by second\n");
    await workspace.commitAll(second.path, "second");

    expect((await workspace.mergeIntoIntegration(first.branch)).status).toBe("merged");
    const outcome = await workspace.mergeIntoIntegration(second.branch);
    expect(outcome.status).toBe("conflict");
    expect(outcome.conflicts).toContain("README.md");

    // The integration branch is left usable, not mid-merge.
    const integrationPath = await workspace.ensureIntegrationWorktree();
    const status = await git(integrationPath, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");
  });

  it("refuses to reset an integration branch that has diverged", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-q", "-b", "integration"]);
    await fs.writeFile(path.join(repo, "own.txt"), "mine\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "own work"]);
    await git(repo, ["checkout", "-q", "main"]);
    // Main moves on separately, so integration is neither ahead nor behind only.
    await fs.writeFile(path.join(repo, "later.txt"), "later\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "later work"]);

    const workspace = await GitWorkspace.open(repo);
    await expect(workspace.ensureIntegrationBranch()).rejects.toThrow(/already exists with commits/);
  });

  it("refuses a worktrees directory inside the repository", async () => {
    const repo = await makeRepo();
    await expect(
      GitWorkspace.open(repo, { worktreesDir: path.join(repo, "wt") }),
    ).rejects.toThrow(/must be outside the repository/);
  });

  it("exposes the git dirs a worktree needs for sandboxing", async () => {
    const { gitDirsFor } = await import("@corpix/agents");
    const repository = await makeRepo();
    expect(await gitDirsFor(repository)).toEqual([]);

    const worktree = path.join(os.tmpdir(), `corpix-wt-${Date.now()}`);
    created.push(worktree);
    await git(repository, ["worktree", "add", "-q", "-b", "wt", worktree, "main"]);

    const dirs = await gitDirsFor(worktree);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      await expect(fs.access(dir)).resolves.toBeUndefined();
    }
  });

  it("detects a dirty working tree", async () => {
    const repo = await makeRepo();
    const workspace = await GitWorkspace.open(repo);
    expect(await workspace.isClean()).toBe(true);
    await fs.writeFile(path.join(repo, "README.md"), "# dirty\n");
    expect(await workspace.isClean()).toBe(false);
  });
});

describe("commit hygiene", () => {
  it("never commits node_modules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-git-"));
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "t@t"]);
    await git(dir, ["config", "user.name", "t"]);
    await fs.writeFile(path.join(dir, "README.md"), "test\n");
    await git(dir, ["add", "README.md"]);
    await git(dir, ["commit", "-qm", "init"]);
    await fs.mkdir(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports=1\n");
    await fs.writeFile(path.join(dir, "app.js"), "console.log(1)\n");

    const workspace = await GitWorkspace.open(dir);
    const commit = await workspace.commitAll(dir, "test: keep node_modules out");
    expect(commit.committed).toBe(true);
    const tracked = await git(dir, ["ls-files"]);
    expect(tracked).not.toContain("node_modules");
    expect(tracked).toContain("app.js");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
