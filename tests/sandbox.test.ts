import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSandboxCommand,
  detectSandboxes,
  preferredSandbox,
  resetSandboxProbe,
  rewriteWorkspacePath,
} from "@corpix/agents";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-sandbox-"));
  await fs.writeFile(path.join(workspace, "hello.txt"), "hello\n");
  resetSandboxProbe();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("sandbox detection", () => {
  it("always offers none and probes bwrap and docker", async () => {
    const available = await detectSandboxes();
    expect(available.map((entry) => entry.kind)).toEqual(["none", "bwrap", "docker"]);
    expect(available[0]?.available).toBe(true);
  });

  it("reports an unavailable docker rather than throwing", async () => {
    const docker = (await detectSandboxes()).find((entry) => entry.kind === "docker");
    expect(docker).toBeDefined();
    if (docker && !docker.available) {
      expect(docker.detail.length).toBeGreaterThan(0);
    }
  });

  it("returns a usable default", async () => {
    const kind = await preferredSandbox();
    expect(["none", "bwrap", "docker"]).toContain(kind);
  });
});

describe("bwrap command construction", () => {
  it("binds only the workspace read-write and drops network by default", async () => {
    const built = await buildSandboxCommand("bwrap", {
      workspaceRoot: workspace,
      command: "node",
      args: ["-e", "1"],
      env: { PATH: "/usr/bin" },
      allowNetwork: false,
    });
    expect(built.command).toBe("bwrap");
    expect(built.networkIsolated).toBe(true);
    expect(built.args).toContain("--unshare-net");
    expect(built.args).toContain("--unshare-user");
    // The workspace is mounted at /work and the process starts there.
    expect(built.args.join(" ")).toContain(`--bind ${workspace} /work`);
    expect(built.args).toContain("--chdir");
  });

  it("grants network only when asked", async () => {
    const built = await buildSandboxCommand("bwrap", {
      workspaceRoot: workspace,
      command: "npm",
      args: ["install"],
      env: {},
      allowNetwork: true,
    });
    expect(built.networkIsolated).toBe(false);
    expect(built.args).not.toContain("--unshare-net");
  });

  it("rewrites workspace paths to /work", () => {
    expect(rewriteWorkspacePath(workspace, workspace)).toBe("/work");
    expect(rewriteWorkspacePath(`${workspace}/src/a.ts`, workspace)).toBe("/work/src/a.ts");
    expect(rewriteWorkspacePath(`--file=${workspace}/x`, workspace)).toBe("--file=/work/x");
    expect(rewriteWorkspacePath("/etc/passwd", workspace)).toBe("/etc/passwd");
  });
});
