import path from "node:path";
import type { RiskLevel } from "@corpix/shared";

export interface CommandDecision {
  allowed: boolean;
  risk: RiskLevel;
  reason?: string;
}

/**
 * Hard denials. These are denied even in `auto` mode: they either escape the
 * workspace, leak credentials or publish code.
 */
const DENIED_EXECUTABLES = new Set([
  "sudo",
  "su",
  "doas",
  "ssh",
  "scp",
  "sftp",
  "telnet",
  "nc",
  "ncat",
  "shutdown",
  "reboot",
  "mount",
  "umount",
]);

const DENIED_GIT_SUBCOMMANDS = new Set(["push", "remote", "credential", "config"]);
const DENIED_NPM_SUBCOMMANDS = new Set(["publish", "unpublish", "adduser", "login", "token"]);
/**
 * Dependency installation is hard-denied. An agent that runs `npm install
 * prettier` mid-task burns its step budget on a formatter, commits node_modules
 * into the repository, and can pull arbitrary code from the network. If a
 * project needs its own dependencies, the operator installs them.
 */
const INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "dlx", "exec"]);
const NETWORK_SUBCOMMANDS = new Set([
  "install",
  "i",
  "add",
  "update",
  "upgrade",
  "create",
  "dlx",
  "exec",
]);

/** Commands that mutate dependencies or fetch from the network. */
function isNetworkCommand(executable: string, args: readonly string[]): boolean {
  const first = args[0] ?? "";
  if (["curl", "wget", "git"].includes(executable)) return executable === "git" ? first === "clone" : true;
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) return NETWORK_SUBCOMMANDS.has(first);
  if (["pip", "pip3", "uv", "cargo", "go"].includes(executable)) {
    return ["install", "add", "get"].includes(first);
  }
  return false;
}

function looksLikeEscape(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg === ".." || arg.startsWith("../")) return true;
    if (path.isAbsolute(arg) && !arg.startsWith("/dev/null")) return true;
    if (arg.includes("\0")) return true;
    return false;
  });
}
export interface CommandPolicyOptions {
  allow: readonly string[];
  deny?: readonly string[];
  /** Absolute paths outside this root are rejected. */
  workspaceRoot?: string;
}

const INTERPRETERS = new Set(["node", "sh", "bash", "zsh", "python", "python3", "perl", "ruby"]);

/**
 * Validate an executable/argument pair. No shell is involved, so characters
 * like `|`, `;` and `$()` are inert and never interpreted.
 */
export function checkCommand(
  command: string,
  args: readonly string[],
  options: CommandPolicyOptions,
): CommandDecision {
  const executable = path.basename(command);
  if (executable !== command && command.includes("/")) {
    return { allowed: false, risk: "exec", reason: "Absolute or relative executable paths are not allowed" };
  }
  if (DENIED_EXECUTABLES.has(executable)) {
    return { allowed: false, risk: "exec", reason: `${executable} is hard-denied` };
  }
  if (options.deny?.includes(executable)) {
    return { allowed: false, risk: "exec", reason: `${executable} is denied for this role` };
  }
  if (!options.allow.includes(executable)) {
    return {
      allowed: false,
      risk: "exec",
      reason: `${executable} is not on this role's allowlist (${options.allow.join(", ") || "empty"})`,
    };
  }

  const sub = args[0] ?? "";
  if (executable === "git" && DENIED_GIT_SUBCOMMANDS.has(sub)) {
    return { allowed: false, risk: "network", reason: `git ${sub} is hard-denied` };
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable) && DENIED_NPM_SUBCOMMANDS.has(sub)) {
    return { allowed: false, risk: "network", reason: `${executable} ${sub} is hard-denied` };
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable) && INSTALL_SUBCOMMANDS.has(sub)) {
    return {
      allowed: false,
      risk: "network",
      reason:
        `${executable} ${sub} is denied: agents must not install dependencies. ` +
        "Use what the workspace already provides and report what is missing.",
    };
  }
  if (executable === "npx" && !args.includes("--no-install") && !args.includes("--offline")) {
    return {
      allowed: false,
      risk: "network",
      reason: "npx is denied unless it is run with --no-install (no fetching from the network)",
    };
  }
  if (executable === "rm") {
    const recursive = args.some((a) => /^-[a-z]*r/i.test(a) || /^-[a-z]*R/.test(a));
    if (recursive && args.some((a) => a === "/" || a === "~" || a === ".")) {
      return { allowed: false, risk: "exec", reason: "Recursive delete of a broad path is denied" };
    }
    if (recursive && looksLikeEscape(args)) {
      return {
        allowed: false,
        risk: "exec",
        reason: "Recursive delete outside the worktree is denied",
      };
    }
  }

  const risky = isNetworkCommand(executable, args);

  // `npx node -e ...` (and friends) is arbitrary code execution that sidesteps
  // the tool layer's workspace jail. Keep the package runners to real binaries.
  if (executable === "npx") {
    const evalish = args.some((arg) =>
      ["-e", "--eval", "-p", "--print", "--package"].includes(arg),
    );
    const target = args.find((arg) => !arg.startsWith("-")) ?? "";
    if (evalish || INTERPRETERS.has(target)) {
      return {
        allowed: false,
        risk: "exec",
        reason: "npx may not launch an interpreter or evaluate code; run the local binary directly",
      };
    }
  }
  if ((executable === "npm" || executable === "pnpm" || executable === "yarn") && args[0] === "exec") {
    if (args.some((arg) => INTERPRETERS.has(arg))) {
      return {
        allowed: false,
        risk: "exec",
        reason: `${executable} exec may not launch an interpreter; run the local binary directly`,
      };
    }
  }

  // Commands may not reach outside the workspace by absolute path.
  if (options.workspaceRoot) {
    const root = options.workspaceRoot.endsWith("/")
      ? options.workspaceRoot
      : `${options.workspaceRoot}/`;
    for (const arg of args) {
      if (arg === "/dev/null") continue;
      const candidate = arg.includes("=") && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
      if (!candidate.startsWith("/")) continue;
      if (candidate === root.slice(0, -1) || candidate.startsWith(root)) continue;
      return {
        allowed: false,
        risk: "exec",
        reason: `explicit path outside the workspace: ${candidate}`,
      };
    }
  }

  return { allowed: true, risk: risky ? "network" : "exec" };
}

/** Minimal environment for child processes: no API keys, no tokens. */
export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SHELL", "USER"];
  const env: Record<string, string> = {
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
