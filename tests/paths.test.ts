import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, repoPath, resolveDataDir } from "@corpix/shared";

describe("repo paths", () => {
  it("finds the repo root from a nested package directory", () => {
    const fromServer = path.resolve(__dirname, "..", "apps", "server");
    expect(findRepoRoot(fromServer)).toBe(path.resolve(__dirname, ".."));
  });

  it("resolves relative data dirs against the repo root, not cwd", () => {
    const root = findRepoRoot();
    expect(resolveDataDir("./data", root)).toBe(path.join(root, "data"));
  });

  it("keeps absolute data dirs untouched", () => {
    expect(resolveDataDir("/tmp/corpix-data", "/repo")).toBe("/tmp/corpix-data");
  });

  it("builds repo paths", () => {
    expect(repoPath("config", "team.default.yaml")).toBe(
      path.join(findRepoRoot(), "config", "team.default.yaml"),
    );
  });
});
