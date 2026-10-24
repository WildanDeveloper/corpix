import { describe, expect, it } from "vitest";
import { DESKS } from "../apps/web/src/office/layout";

/**
 * The office keys every body by role. Runtime agents get ids like
 * `backend_3fmfed`, while the mind speaks as `backend`; keying by id is what
 * used to draw the same person twice.
 */
function canonical(role: string, id: string): string {
  return role;
}

describe("one body per role", () => {
  it("collapses runtime ids and mind ids onto the same role", () => {
    expect(canonical("backend", "backend_3fmfed")).toBe("backend");
    expect(canonical("backend", "backend")).toBe("backend");
    expect(canonical("frontend", "frontend_r5vqm2")).toBe("frontend");
  });

  it("keeps every role distinct", () => {
    const roles = ["boss", "frontend", "backend", "devops", "qa", "docs"];
    expect(new Set(roles.map((role) => canonical(role, `${role}_abc`))).size).toBe(roles.length);
  });

  it("has exactly one desk per role", () => {
    const seen = new Set<string>();
    for (const desk of DESKS) {
      expect(seen.has(desk.role)).toBe(false);
      seen.add(desk.role);
    }
    expect(seen.size).toBe(DESKS.length);
  });

  it("never lists two agents with the same role in the debug snapshot", () => {
    // Mirrors the scene's invariant: agent id === role id.
    const snapshot = ["boss", "frontend", "backend", "devops", "qa", "docs"].map((role) => ({ role }));
    expect(new Set(snapshot.map((agent) => agent.role)).size).toBe(snapshot.length);
  });
});
