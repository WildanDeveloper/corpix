import { describe, expect, it } from "vitest";
import { checkCommand, scrubbedEnv } from "@corpix/agents";

const allow = ["node", "pnpm", "npm", "git", "rm", "npx", "yarn"];

describe("checkCommand", () => {
  it("allows allowlisted executables", () => {
    const decision = checkCommand("node", ["--version"], { allow });
    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("exec");
  });

  it("rejects anything not on the allowlist", () => {
    const decision = checkCommand("python", ["x.py"], { allow });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not on this role's allowlist/);
  });

  it("hard-denies sudo, ssh and scp even if allowlisted", () => {
    for (const executable of ["sudo", "ssh", "scp"]) {
      const decision = checkCommand(executable, ["x"], { allow: [...allow, executable] });
      expect(decision.allowed).toBe(false);
    }
  });

  it("hard-denies git push and git remote", () => {
    expect(checkCommand("git", ["push"], { allow }).allowed).toBe(false);
    expect(checkCommand("git", ["remote", "add", "origin", "x"], { allow }).allowed).toBe(false);
    expect(checkCommand("git", ["status"], { allow }).allowed).toBe(true);
  });

  it("hard-denies npm publish and npm login", () => {
    expect(checkCommand("npm", ["publish"], { allow }).allowed).toBe(false);
    expect(checkCommand("npm", ["login"], { allow }).allowed).toBe(false);
  });

  it("denies dependency installs outright", () => {
    for (const [command, args] of [
      ["pnpm", ["add", "zod"]],
      ["npm", ["install", "prettier"]],
      ["npm", ["ci"]],
      ["yarn", ["add", "left-pad"]],
      ["npx", ["prettier", "--check", "index.html"]],
    ] as const) {
      const decision = checkCommand(command, [...args], { allow });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/install|network|denied|allowlist/i);
    }
  });

  it("still allows npx when it is told not to install", () => {
    const decision = checkCommand("npx", ["--no-install", "tsc", "--noEmit"], { allow });
    expect(decision.allowed).toBe(true);
  });

  it("rejects absolute executable paths", () => {
    expect(checkCommand("/usr/bin/node", ["x"], { allow }).allowed).toBe(false);
  });

  it("rejects recursive deletes of broad paths", () => {
    expect(checkCommand("rm", ["-rf", "/"], { allow }).allowed).toBe(false);
  });

  it("rejects npx launching an interpreter or eval code", () => {
    const allow = ["npx", "node"];
    expect(checkCommand("npx", ["--no-install", "node", "-e", "x"], { allow }).allowed).toBe(false);
    expect(checkCommand("npx", ["-p", "x", "node"], { allow }).allowed).toBe(false);
    expect(checkCommand("npx", ["--no-install", "vitest"], { allow }).allowed).toBe(true);
  });

  it("rejects explicit paths outside the workspace", () => {
    const decision = checkCommand("node", ["script.js", "/etc/passwd"], {
      allow: ["node"],
      workspaceRoot: "/work/project",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/outside the workspace/);
  });

  it("allows explicit paths inside the workspace", () => {
    const decision = checkCommand("node", ["/work/project/script.js"], {
      allow: ["node"],
      workspaceRoot: "/work/project",
    });
    expect(decision.allowed).toBe(true);
  });

  it("honours a per-role deny list", () => {
    const decision = checkCommand("node", ["x"], { allow, deny: ["node"] });
    expect(decision.allowed).toBe(false);
  });
});

describe("scrubbedEnv", () => {
  it("never forwards API keys", () => {
    process.env.LLM_API_KEY = "sk-secret";
    process.env.OPENAI_API_KEY = "sk-secret-2";
    const env = scrubbedEnv();
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("sk-secret");
    delete process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
});
