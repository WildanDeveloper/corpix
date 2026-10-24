import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceJail, assertWritable, matchesGlob } from "@corpix/agents";

const created: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-jail-"));
  created.push(dir);
  await fs.mkdir(path.join(dir, "apps/web/src"), { recursive: true });
  await fs.writeFile(path.join(dir, "apps/web/src/app.ts"), "export {};\n");
  await fs.writeFile(path.join(dir, ".env"), "SECRET=1\n");
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("WorkspaceJail", () => {
  it("resolves paths inside the workspace", async () => {
    const dir = await tempWorkspace();
    const jail = await WorkspaceJail.open(dir);
    const abs = await jail.resolveReal("apps/web/src/app.ts");
    expect(abs.startsWith(dir)).toBe(true);
    expect(jail.relative(abs)).toBe("apps/web/src/app.ts");
  });

  it("blocks ../ traversal", async () => {
    const dir = await tempWorkspace();
    const jail = await WorkspaceJail.open(dir);
    expect(() => jail.resolve("../../etc/passwd")).toThrow(/escapes the workspace/);
  });

  it("blocks a symlink that points outside the root", async () => {
    const dir = await tempWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-outside-"));
    created.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "nope");
    await fs.symlink(outside, path.join(dir, "escape"));
    const jail = await WorkspaceJail.open(dir);
    await expect(jail.resolveReal("escape/secret.txt")).rejects.toThrow(/symlink/);
  });

  it("denies secret files even inside the root", async () => {
    const dir = await tempWorkspace();
    const jail = await WorkspaceJail.open(dir);
    expect(() => jail.resolve(".env")).toThrow(/protected file/);
    expect(() => jail.resolve("deploy/id_rsa")).toThrow(/protected file/);
  });

  it("rejects null bytes", async () => {
    const dir = await tempWorkspace();
    const jail = await WorkspaceJail.open(dir);
    expect(() => jail.resolve("a\0b")).toThrow(/null byte/);
  });
});

describe("glob matching", () => {
  it("matches ** at any depth", () => {
    expect(matchesGlob("apps/web/**", "apps/web/src/app.ts")).toBe(true);
    expect(matchesGlob("apps/web/**", "apps/server/src/app.ts")).toBe(false);
  });

  it("matches * within one segment only", () => {
    expect(matchesGlob("apps/*/src/app.ts", "apps/web/src/app.ts")).toBe(true);
    expect(matchesGlob("apps/*/app.ts", "apps/web/src/app.ts")).toBe(false);
  });

  it("matches **/ prefix at the root and nested", () => {
    expect(matchesGlob("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(matchesGlob("**/*.test.ts", "src/deep/a.test.ts")).toBe(true);
    expect(matchesGlob("**", "anything/at/all.ts")).toBe(true);
  });

  it("matches exact file names", () => {
    expect(matchesGlob("package.json", "package.json")).toBe(true);
    expect(matchesGlob("package.json", "apps/web/package.json")).toBe(false);
  });
});

describe("assertWritable", () => {
  it("allows in-scope writes", () => {
    expect(() => assertWritable("apps/web/src/app.ts", ["apps/web/**"])).not.toThrow();
  });

  it("rejects out-of-scope writes with a helpful message", () => {
    expect(() => assertWritable("apps/server/src/index.ts", ["apps/web/**"])).toThrow(
      /outside this role's write scope/,
    );
  });

  it("always rejects .git writes", () => {
    expect(() => assertWritable(".git/config", ["**"])).toThrow(/\.git/);
  });

  it("always rejects secret files", () => {
    expect(() => assertWritable(".env", ["**"])).toThrow(/protected file/);
  });

  it("lets the Boss write shared context outside its globs", () => {
    expect(() =>
      assertWritable("NOTES.md", [], { sharedContext: ["SPEC.md", "NOTES.md"] }),
    ).not.toThrow();
  });
});
