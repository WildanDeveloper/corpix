import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface MergeOutcome {
  status: "merged" | "conflict" | "failed";
  detail: string;
  /** Files with conflicts, when `status` is "conflict". */
  conflicts: string[];
}

export interface Worktree {
  taskId: string;
  branch: string;
  path: string;
}

/**
 * Git plumbing for task isolation. Every git call runs with a scrubbed
 * environment and without a shell, and never touches the network.
 *
 * Layout:
 *   <repo>                      the user's repository (untouched)
 *   <repo>.worktrees/<taskId>   one checkout per task
 *   integration                 branch created from HEAD at the start of a run
 */
export class GitWorkspace {
  private constructor(
    readonly repoPath: string,
    readonly worktreesRoot: string,
    readonly integrationBranch: string,
  ) {}

  static async open(
    repoPath: string,
    options: { integrationBranch?: string; worktreesDir?: string } = {},
  ): Promise<GitWorkspace> {
    const absolute = path.resolve(repoPath);
    const inside = await git(absolute, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
    if (!inside || inside.stdout.trim() !== "true") {
      throw new Error(`${absolute} is not a git repository`);
    }
    const worktreesRoot = options.worktreesDir
      ? path.resolve(options.worktreesDir)
      : `${absolute}.worktrees`;
    const relative = path.relative(absolute, worktreesRoot);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(
        `worktreesDir must be outside the repository (got ${worktreesRoot}); ` +
          `checkout inside the repo would create a recursive worktree.`,
      );
    }
    return new GitWorkspace(absolute, worktreesRoot, options.integrationBranch ?? "integration");
  }

  /** Current branch, or a detached HEAD description. */
  async currentRef(): Promise<string> {
    const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return branch.stdout.trim();
  }

  async isClean(): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"]);
    return status.stdout.trim().length === 0;
  }

  /** Attach (or reuse) the worktree that holds the integration branch. */
  async ensureIntegrationWorktree(): Promise<string> {
    const integrationPath = path.join(this.worktreesRoot, ".integration");
    await fs.mkdir(this.worktreesRoot, { recursive: true });
    const attached = await this.git(["worktree", "list", "--porcelain"]);
    if (attached.stdout.includes(integrationPath)) return integrationPath;
    if (await exists(integrationPath)) {
      await fs.rm(integrationPath, { recursive: true, force: true });
    }
    await this.git(["worktree", "add", integrationPath, this.integrationBranch]);
    return integrationPath;
  }

  /**
   * Create or reset the integration branch from the current HEAD. Refuses to
   * destroy an existing branch that has commits not in HEAD.
   */
  async ensureIntegrationBranch(): Promise<{ created: boolean; branch: string }> {
    const exists = await this.git(["rev-parse", "--verify", "--quiet", this.integrationBranch])
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      await this.git(["branch", this.integrationBranch, "HEAD"]);
      return { created: true, branch: this.integrationBranch };
    }

    // Reuse it only when it is an ancestor of HEAD or identical; otherwise the
    // user has their own work on that branch and we must not reset it.
    const ahead = await this.git([
      "rev-list",
      "--count",
      `${this.integrationBranch}..HEAD`,
    ]).catch(() => null);
    const behind = await this.git([
      "rev-list",
      "--count",
      `HEAD..${this.integrationBranch}`,
    ]).catch(() => null);
    const diverged = (behind?.stdout.trim() ?? "0") !== "0";
    if (diverged && ahead?.stdout.trim() !== "0") {
      throw new Error(
        `Branch "${this.integrationBranch}" already exists with commits that are not in HEAD. ` +
          `Rename it, merge it, or choose another git.integrationBranch in settings.`,
      );
    }
    return { created: false, branch: this.integrationBranch };
  }

  /** Create a worktree on a fresh branch cut from the integration branch. */
  async createWorktree(taskId: string, roleId: string): Promise<Worktree> {
    const safeTask = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
    const safeRole = roleId.replace(/[^A-Za-z0-9._-]/g, "-");
    const branch = `agent/${safeRole}/${safeTask}`;
    const worktreePath = path.join(this.worktreesRoot, safeTask);

    await fs.mkdir(this.worktreesRoot, { recursive: true });

    // A crashed run can leave the directory behind; prune and retry once.
    await this.git(["worktree", "prune"]).catch(() => undefined);
    if (await exists(worktreePath)) {
      await this.git(["worktree", "remove", "--force", worktreePath]).catch(async () => {
        await fs.rm(worktreePath, { recursive: true, force: true });
      });
    }

    await this.git(["worktree", "add", "-b", branch, worktreePath, this.integrationBranch]);
    return { taskId, branch, path: worktreePath };
  }

  /** Commit everything the agent produced, so the branch is mergeable. */
  async commitAll(worktreePath: string, message: string): Promise<{ committed: boolean; sha?: string }> {
    await this.gitIn(worktreePath, ["add", "-A"]);
    const staged = await this.gitIn(worktreePath, ["status", "--porcelain"]);
    if (staged.stdout.trim().length === 0) return { committed: false };
    await this.gitIn(worktreePath, [
      "-c",
      "user.name=Corpix Agent",
      "-c",
      "user.email=agents@corpix.local",
      "commit",
      "-m",
      message,
      "--no-verify",
    ]);
    const sha = await this.gitIn(worktreePath, ["rev-parse", "HEAD"]);
    return { committed: true, sha: sha.stdout.trim() };
  }

  /** Files changed on a branch relative to the integration branch. */
  async diffNames(branch: string): Promise<string[]> {
    const result = await this.git(["diff", "--name-only", `${this.integrationBranch}...${branch}`]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Merge a task branch into the integration branch. A conflict aborts the
   * merge and is reported; we never guess a resolution.
   */
  async mergeIntoIntegration(branch: string): Promise<MergeOutcome> {
    // Merging requires a checkout of the integration branch. Use a dedicated
    // integration worktree so the user's working copy is never disturbed.
    const integrationPath = await this.ensureIntegrationWorktree();

    try {
      await this.gitIn(integrationPath, [
        "-c",
        "user.name=Corpix",
        "-c",
        "user.email=agents@corpix.local",
        "merge",
        "--no-ff",
        "-m",
        `merge ${branch}`,
        branch,
      ]);
      return { status: "merged", detail: `Merged ${branch}`, conflicts: [] };
    } catch (error) {
      const message = errorText(error);
      const conflicts = await this.gitIn(integrationPath, ["diff", "--name-only", "--diff-filter=U"])
        .then((result) =>
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        )
        .catch(() => []);
      await this.gitIn(integrationPath, ["merge", "--abort"]).catch(() => undefined);
      if (conflicts.length > 0 || /CONFLICT|Automatic merge failed/i.test(message)) {
        return {
          status: "conflict",
          detail: `Merge conflict in ${conflicts.join(", ") || "unknown files"}`,
          conflicts,
        };
      }
      return { status: "failed", detail: message, conflicts: [] };
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", worktreePath]).catch(async () => {
      await fs.rm(worktreePath, { recursive: true, force: true });
    });
    await this.git(["worktree", "prune"]).catch(() => undefined);
  }

  /** Remove the integration worktree but keep the branch. */
  async releaseIntegrationWorktree(): Promise<void> {
    const integrationPath = path.join(this.worktreesRoot, ".integration");
    if (await exists(integrationPath)) {
      await this.removeWorktree(integrationPath);
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    return await this.git(["rev-parse", "--verify", "--quiet", branch])
      .then(() => true)
      .catch(() => false);
  }

  private git(args: string[]): Promise<GitResult> {
    return git(this.repoPath, args);
  }

  private gitIn(cwd: string, args: string[]): Promise<GitResult> {
    return git(cwd, args);
  }
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        LC_ALL: "C",
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    const result: GitResult = {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? errorText(error),
      code: failure.code ?? 1,
    };
    throw Object.assign(new Error(result.stderr.trim() || "git failed"), { result });
  }
}

function errorText(error: unknown): string {
  const failure = error as { stderr?: string; message?: string };
  return (failure.stderr ?? failure.message ?? "unknown git error").trim();
}

async function exists(target: string): Promise<boolean> {
  return await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}
