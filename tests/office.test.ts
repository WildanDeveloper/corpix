import { describe, expect, it } from "vitest";
import {
  COLS,
  DESKS,
  ENTRANCE,
  ROWS,
  deskFor,
  isWalkable,
  nearestWalkable,
  zoneAt,
} from "../apps/web/src/office/layout";
import { findPath, simplifyPath } from "../apps/web/src/office/pathfinding";

describe("office layout", () => {
  it("has a solid wall border", () => {
    for (let x = 0; x < COLS; x++) {
      expect(isWalkable(x, 0)).toBe(false);
      expect(isWalkable(x, ROWS - 1)).toBe(false);
    }
    for (let y = 0; y < ROWS; y++) {
      expect(isWalkable(0, y)).toBe(false);
      expect(isWalkable(COLS - 1, y)).toBe(false);
    }
  });

  it("keeps desks and props solid", () => {
    for (const desk of DESKS) {
      expect(isWalkable(desk.tile.x, desk.tile.y)).toBe(false);
      expect(isWalkable(desk.stand.x, desk.stand.y)).toBe(true);
    }
  });

  it("assigns a desk to every team role", () => {
    for (const role of ["boss", "frontend", "backend", "devops", "qa", "docs"]) {
      expect(deskFor(role).role).toBe(role);
    }
    // Unknown roles fall back to a real desk rather than crashing.
    expect(deskFor("designer").role).toBeTruthy();
  });

  it("maps tiles to zones and leaves the gaps out", () => {
    expect(zoneAt(3, 3)?.id).toBe("boss");
    expect(zoneAt(15, 5)?.id).toBe("dev");
    expect(zoneAt(5, 15)?.id).toBe("meeting");
    expect(zoneAt(15, 15)?.id).toBe("server");
    expect(zoneAt(25, 15)?.id).toBe("break");
    expect(zoneAt(8, 1)).toBeUndefined();
  });

  it("finds a walkable tile near the entrance", () => {
    const spot = nearestWalkable(ENTRANCE);
    expect(isWalkable(spot.x, spot.y)).toBe(true);
  });
});

describe("desk occupancy", () => {
  it("gives each role a distinct stand tile", () => {
    const stands = DESKS.map((desk) => `${desk.stand.x},${desk.stand.y}`);
    expect(new Set(stands).size).toBe(DESKS.length);
  });

  it("keeps every stand reachable from the entrance", () => {
    const start = nearestWalkable(ENTRANCE);
    for (const desk of DESKS) {
      expect(findPath(start, desk.stand).length).toBeGreaterThan(0);
    }
  });
});

describe("pathfinding", () => {
  it("routes from the entrance to every desk", () => {
    const start = nearestWalkable(ENTRANCE);
    for (const desk of DESKS) {
      const path = findPath(start, desk.stand);
      expect(path.length).toBeGreaterThan(0);
      // Every step is walkable and adjacent to the previous one.
      let previous = start;
      for (const step of path) {
        expect(isWalkable(step.x, step.y)).toBe(true);
        expect(Math.abs(step.x - previous.x) + Math.abs(step.y - previous.y)).toBe(1);
        previous = step;
      }
      expect(previous).toEqual(desk.stand);
    }
  });

  it("returns an empty path when already there", () => {
    expect(findPath({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([]);
  });

  it("refuses to path onto a desk", () => {
    const desk = deskFor("backend");
    expect(findPath({ x: 5, y: 5 }, desk.tile)).toEqual([]);
  });

  it("refuses a goal outside the grid", () => {
    expect(findPath({ x: 5, y: 5 }, { x: -1, y: 5 })).toEqual([]);
    expect(findPath({ x: 5, y: 5 }, { x: COLS + 2, y: 5 })).toEqual([]);
  });

  it("simplifies straight runs without dropping corners", () => {
    const path = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(simplifyPath(path)).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
    ]);
  });
});
