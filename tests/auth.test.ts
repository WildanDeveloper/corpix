import { describe, expect, it } from "vitest";

/**
 * Mirrors the auth rule in apps/server/src/index.ts: the static UI and the
 * healthcheck stay public, everything else under /api needs the token.
 */
function isPublic(path: string): boolean {
  return !path.startsWith("/api") || path === "/api/health";
}

describe("auth surface", () => {
  it("keeps the UI public so the token field can be reached", () => {
    expect(isPublic("/")).toBe(true);
    expect(isPublic("/assets/index.js")).toBe(true);
    expect(isPublic("/index.html")).toBe(true);
  });

  it("keeps the healthcheck public for container probes", () => {
    expect(isPublic("/api/health")).toBe(true);
  });

  it("protects every other API route", () => {
    for (const path of [
      "/api/settings",
      "/api/runs",
      "/api/runs/run_1/events",
      "/api/approvals",
      "/api/usage",
      "/api/models",
      "/api/roles",
      "/api/sandbox",
    ]) {
      expect(isPublic(path)).toBe(false);
    }
  });
});
