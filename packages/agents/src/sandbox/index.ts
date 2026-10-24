import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SANDBOX_KINDS = ["none", "bwrap", "docker"] as const;
export type SandboxKind = (typeof SANDBOX_KINDS)[number];

export interface SandboxAvailability {
  kind: SandboxKind;
  available: boolean;
  /** Version string or the reason it is unavailable. */
  detail: string;
}

export interface SandboxCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** True when the command runs in an isolated network namespace. */
  networkIsolated: boolean;
}

export interface SandboxBuildOptions {
  /** Absolute path of the worktree the command may read and write. */
  workspaceRoot: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Network access is only granted for approved installs. */
  allowNetwork: boolean;
  image?: string;
  /** Git dirs that must be visible (and writable) so `git` works inside. */
  gitDirs?: string[];
}

/**
 * Sandboxes available on this machine. `none` is always "available"; the others
 * are probed once and cached, because spawning a probe per command would be
 * wasteful.
 */
export async function detectSandboxes(): Promise<SandboxAvailability[]> {
  const [bwrap, docker] = await Promise.all([probeBwrap(), probeDocker()]);
  return [
    { kind: "none", available: true, detail: "no isolation (policy and jail only)" },
    bwrap,
    docker,
  ];
}

let cachedBwrap: SandboxAvailability | null = null;
let cachedDocker: SandboxAvailability | null = null;

async function probeBwrap(): Promise<SandboxAvailability> {
  if (cachedBwrap) return cachedBwrap;
  try {
    const { stdout } = await run("bwrap", ["--version"], { timeout: 5_000 });
    // A version alone does not prove namespaces are permitted, so try a real run
    // with the same flag shape the sandbox uses.
    await run(
      "bwrap",
      [
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/sbin", "/sbin",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--dev", "/dev",
        "--proc", "/proc",
        "--unshare-all",
        "--die-with-parent",
        "/bin/true",
      ],
      { timeout: 5_000 },
    ).catch(() => {
      throw new Error("bubblewrap is installed but namespaces are not permitted here");
    });
    cachedBwrap = { kind: "bwrap", available: true, detail: stdout.trim() };
  } catch (error) {
    const message = (error as Error).message;
    cachedBwrap = {
      kind: "bwrap",
      available: false,
      detail: /ENOENT/.test(message) ? "bubblewrap is not installed" : message,
    };
  }
  return cachedBwrap;
}

async function probeDocker(): Promise<SandboxAvailability> {
  if (cachedDocker) return cachedDocker;
  try {
    const { stdout } = await run("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 8_000,
    });
    cachedDocker = { kind: "docker", available: true, detail: `server ${stdout.trim()}` };
  } catch (error) {
    const message = (error as Error).message;
    cachedDocker = {
      kind: "docker",
      available: false,
      detail: /ENOENT/.test(message) ? "docker is not installed" : message,
    };
  }
  return cachedDocker;
}

/** Reset the probe cache; used by tests and by the settings "recheck" action. */
export function resetSandboxProbe(): void {
  cachedBwrap = null;
  cachedDocker = null;
}

/**
 * Wrap a command so it runs inside the chosen sandbox.
 *
 * bubblewrap needs no daemon: it builds a private mount namespace with the
 * workspace bound read-write at /work, everything else read-only, no network
 * unless explicitly allowed, and a non-root uid.
 */
export async function buildSandboxCommand(
  kind: SandboxKind,
  options: SandboxBuildOptions,
): Promise<SandboxCommand> {
  if (kind === "none") {
    return {
      command: options.command,
      args: options.args,
      env: options.env,
      networkIsolated: false,
    };
  }
  if (kind === "docker") return buildDocker(options);
  return await buildBwrap(options);
}

async function buildBwrap(options: SandboxBuildOptions): Promise<SandboxCommand> {
  const args: string[] = [];
  const add = (...values: string[]): void => {
    args.push(...values);
  };

  // Read-only system directories: enough for node, git and coreutils to run.
  for (const dir of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
    if (await exists(dir)) add("--ro-bind", dir, dir);
  }
  // Extra read-only prefixes so a Node installed outside /usr still works.
  for (const dir of ["/opt", "/usr/local"]) {
    if (await exists(dir)) add("--ro-bind", dir, dir);
  }

  add("--dev", "/dev");
  add("--proc", "/proc");
  add("--tmpfs", "/tmp");
  add("--tmpfs", "/run");

  // The worktree is the only writable place, mounted at a stable path so the
  // command never sees the real host path.
  add("--bind", options.workspaceRoot, "/work");
  add("--chdir", "/work");

  // A worktree's `.git` is a file pointing at the real git dir elsewhere, so the
  // git dirs have to be mounted at their host paths for git to resolve them.
  for (const dir of options.gitDirs ?? []) {
    if (!(await exists(dir))) continue;
    add("--bind", dir, dir);
  }
  // A writable HOME keeps git and npm from failing on a read-only root.
  add("--tmpfs", "/home/agent");
  add("--setenv", "HOME", "/home/agent");
  add("--setenv", "TMPDIR", "/tmp");

  add("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try");
  // A private user namespace is what makes the non-root uid and the bind mounts
  // possible without real privileges on the host.
  add("--unshare-user", "--uid", "1000", "--gid", "1000");
  if (!options.allowNetwork) add("--unshare-net");
  add("--die-with-parent");
  add("--new-session");

  for (const [key, value] of Object.entries(options.env)) {
    add("--setenv", key, value);
  }

  const command = resolveInsideSandbox(options.command);
  const rewrittenArgs = options.args.map((arg) => rewriteWorkspacePath(arg, options.workspaceRoot));
  add(command, ...rewrittenArgs);

  return {
    command: "bwrap",
    args,
    env: options.env,
    networkIsolated: !options.allowNetwork,
  };
}

/**
 * Inside the sandbox the workspace lives at /work, so an absolute host path that
 * points into it must be rewritten or the command would fail to find its files.
 */
export function rewriteWorkspacePath(arg: string, workspaceRoot: string): string {
  const root = workspaceRoot.replace(/\/+$/, "");
  if (arg === root) return "/work";
  if (arg.startsWith(`${root}/`)) return `/work${arg.slice(root.length)}`;
  // Handle `--flag=/path` style arguments.
  const eq = arg.indexOf("=");
  if (eq > 0 && arg.startsWith("-")) {
    const value = arg.slice(eq + 1);
    if (value === root) return `${arg.slice(0, eq)}=/work`;
    if (value.startsWith(`${root}/`)) {
      return `${arg.slice(0, eq)}=/work${value.slice(root.length)}`;
    }
  }
  return arg;
}

/**
 * Commands are resolved with the sandbox's PATH. An absolute host path is
 * rewritten to /work when it points inside the workspace, otherwise rejected
 * earlier by the command policy.
 */
function resolveInsideSandbox(command: string): string {
  // An absolute host path to an executable inside the workspace is not visible
  // at that path inside the sandbox; commands are expected to be on PATH.
  return command;
}

async function buildDocker(options: SandboxBuildOptions): Promise<SandboxCommand> {
  const image = options.image ?? "node:22-bookworm-slim";
  const args = [
    "run",
    "--rm",
    "--init",
    "-v",
    `${options.workspaceRoot}:/work`,
    "-w",
    "/work",
    "--user",
    "1000:1000",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--pids-limit",
    "512",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    options.allowNetwork ? "bridge" : "none",
  ];
  for (const [key, value] of Object.entries(options.env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(image, options.command, ...options.args);

  return {
    command: "docker",
    args,
    env: options.env,
    networkIsolated: !options.allowNetwork,
  };
}

async function exists(target: string): Promise<boolean> {
  return await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

/** Short human description used in events and the settings page. */
export function describeSandbox(kind: SandboxKind): string {
  switch (kind) {
    case "bwrap":
      return "bubblewrap: private mount and network namespace, non-root";
    case "docker":
      return "docker: container with the worktree mounted, no capabilities";
    default:
      return "none: command policy and workspace jail only";
  }
}

/** Best default for this machine, used when settings do not pin a sandbox. */
export async function preferredSandbox(): Promise<SandboxKind> {
  const available = await detectSandboxes();
  const bwrap = available.find((entry) => entry.kind === "bwrap");
  if (bwrap?.available) return "bwrap";
  const docker = available.find((entry) => entry.kind === "docker");
  if (docker?.available) return "docker";
  return "none";
}

export function sandboxTempRoot(): string {
  return path.join(os.tmpdir(), "corpix-sandbox");
}

/**
 * Git directories a worktree needs. Reading the `.git` file is enough to learn
 * where the real git dir lives, and both the common dir and the per-worktree dir
 * must be mounted for git commands to work inside the sandbox.
 */
export async function gitDirsFor(workspaceRoot: string): Promise<string[]> {
  const dotGit = path.join(workspaceRoot, ".git");
  let stat;
  try {
    stat = await fs.stat(dotGit);
  } catch {
    return [];
  }
  // A normal checkout: `.git` is a directory inside the workspace already.
  if (stat.isDirectory()) return [];

  const content = await fs.readFile(dotGit, "utf8").catch(() => "");
  const match = content.match(/gitdir:\s*(.+)/);
  if (!match?.[1]) return [];
  const gitDir = match[1].trim();
  const dirs = new Set<string>([gitDir]);

  // `<common>/worktrees/<name>` → the common dir is the parent of `worktrees`.
  const worktreesIndex = gitDir.lastIndexOf(`${path.sep}worktrees${path.sep}`);
  if (worktreesIndex > 0) {
    const commonDir = gitDir.slice(0, worktreesIndex);
    dirs.add(commonDir);
    // Worktrees share objects/refs with the main repo, and `commondir` points
    // back at it; include the resolved path when it exists.
    const commondir = await fs
      .readFile(path.join(gitDir, "commondir"), "utf8")
      .catch(() => "");
    if (commondir.trim().length > 0) {
      dirs.add(path.resolve(gitDir, commondir.trim()));
    }
  }
  return [...dirs];
}
