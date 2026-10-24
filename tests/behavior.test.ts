import { describe, expect, it } from "vitest";
import {
  INITIAL_NEEDS,
  applyActivity,
  chooseActivity,
  destinationFor,
  driftNeeds,
  hashString,
  moodWord,
  mulberry32,
  planIdle,
  type IdleActivity,
  type NeedState,
} from "../apps/web/src/office/behavior";

const needs = (patch: Partial<NeedState> = {}): NeedState => ({ ...INITIAL_NEEDS, ...patch });

const anchors = {
  coffee: { x: 23, y: 16 },
  water: { x: 22, y: 14 },
  smoke: { x: 28, y: 17 },
  whiteboard: { x: 10, y: 2 },
  window: { x: 27, y: 4 },
  meeting: [
    { x: 3, y: 14 },
    { x: 4, y: 14 },
  ],
};

describe("needs", () => {
  it("builds up caffeine, social pressure and restlessness while idle", () => {
    const next = driftNeeds(needs({ caffeine: 10, social: 10, restlessness: 10 }), 30, false);
    expect(next.caffeine).toBeGreaterThan(10);
    expect(next.social).toBeGreaterThan(10);
    expect(next.restlessness).toBeGreaterThan(10);
  });

  it("drains focus and raises stress while working", () => {
    const next = driftNeeds(needs({ focus: 80, stress: 10 }), 30, true);
    expect(next.focus).toBeLessThan(80);
    expect(next.stress).toBeGreaterThan(10);
  });

  it("clamps everything to 0..100", () => {
    const next = driftNeeds(needs({ focus: 100, social: 100, caffeine: 100, restlessness: 100, stress: 100 }), 9999, true);
    for (const value of Object.values(next)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("relieves the need each activity is meant for", () => {
    expect(applyActivity(needs({ caffeine: 80 }), "coffee").caffeine).toBeLessThan(80);
    expect(applyActivity(needs({ stress: 80 }), "smoke").stress).toBeLessThan(80);
    expect(applyActivity(needs({ social: 80 }), "pair-chat").social).toBeLessThan(80);
    expect(applyActivity(needs({ restlessness: 80 }), "wander").restlessness).toBeLessThan(80);
    expect(applyActivity(needs({ focus: 20 }), "rest").focus).toBeGreaterThan(20);
  });
});

describe("activity choice", () => {
  it("services the strongest need", () => {
    const random = mulberry32(1);
    expect(chooseActivity(needs({ caffeine: 100, restlessness: 0, social: 0, stress: 0, focus: 0 }), random, [])).toMatch(
      /coffee|water/,
    );
    expect(chooseActivity(needs({ social: 100, caffeine: 0, restlessness: 0, stress: 0, focus: 0 }), random, [])).toMatch(
      /chat|pair-chat|meeting/,
    );
    expect(chooseActivity(needs({ stress: 100, caffeine: 0, restlessness: 0, social: 0, focus: 0 }), random, [])).toMatch(
      /smoke|window/,
    );
  });

  it("avoids repeating recent activities", () => {
    const random = mulberry32(5);
    const recent: IdleActivity[] = ["coffee", "water", "chat", "pair-chat", "smoke", "window"];
    const choice = chooseActivity(needs({ caffeine: 40 }), random, ["coffee"]);
    // A recent coffee is enough to push a normal caffeine level elsewhere.
    expect(choice).not.toBe("coffee");
  });

  it("honours the smoke and social switches", () => {
    for (let seed = 0; seed < 40; seed++) {
      const random = mulberry32(seed);
      const noSmoke = chooseActivity(needs({ stress: 100 }), random, [], { allowSmoke: false });
      expect(noSmoke).not.toBe("smoke");
      const noSocial = chooseActivity(needs({ social: 100 }), random, [], { allowSocial: false });
      expect(["chat", "pair-chat", "meeting"]).not.toContain(noSocial);
    }
  });
});

describe("idle plans", () => {
  it("is deterministic for the same agent, round and needs", () => {
    const a = planIdle("backend_1", needs(), 4);
    const b = planIdle("backend_1", needs(), 4);
    expect(a).toEqual(b);
  });

  it("produces variety across agents and rounds", () => {
    const activities = new Set<string>();
    const recent = new Map<string, IdleActivity[]>();
    for (let round = 1; round <= 12; round++) {
      for (const agent of ["boss_1", "qa_1", "docs_1", "backend_1"]) {
        const history = recent.get(agent) ?? [];
        const plan = planIdle(agent, needs(), round, history);
        history.unshift(plan.activity);
        history.length = Math.min(history.length, 3);
        recent.set(agent, history);
        activities.add(plan.activity);
      }
    }
    expect(activities.size).toBeGreaterThanOrEqual(6);
  });

  it("marks social activities", () => {
    for (let round = 1; round <= 30; round++) {
      const plan = planIdle("backend_1", needs({ social: 100 }), round);
      if (plan.activity === "pair-chat" || plan.activity === "chat" || plan.activity === "meeting") {
        expect(plan.social).toBe(true);
      }
    }
  });

  it("keeps durations in a readable range", () => {
    for (let round = 1; round <= 20; round++) {
      const plan = planIdle("qa_2", needs(), round);
      expect(plan.duration).toBeGreaterThanOrEqual(4);
      expect(plan.duration).toBeLessThanOrEqual(10);
    }
  });

  it("sometimes stays silent", () => {
    const lines = Array.from({ length: 50 }, (_, round) => planIdle("docs_3", needs(), round + 1).line);
    expect(lines.some((line) => line === null)).toBe(true);
    expect(lines.some((line) => line !== null)).toBe(true);
  });
});

describe("destinations", () => {
  it("maps places to anchors", () => {
    const random = mulberry32(1);
    expect(destinationFor("coffee", { x: 16, y: 4 }, anchors, random)).toEqual(anchors.coffee);
    expect(destinationFor("water", { x: 16, y: 4 }, anchors, random)).toEqual(anchors.water);
    expect(destinationFor("smoke", { x: 16, y: 4 }, anchors, random)).toEqual(anchors.smoke);
    expect(destinationFor("whiteboard", { x: 16, y: 4 }, anchors, random)).toEqual(anchors.whiteboard);
    expect(destinationFor("window", { x: 16, y: 4 }, anchors, random)).toEqual(anchors.window);
  });

  it("sends meetings to a meeting spot", () => {
    const spot = destinationFor("meeting", { x: 16, y: 4 }, anchors, mulberry32(1));
    expect(anchors.meeting).toContainEqual(spot);
  });

  it("wanders near the desk", () => {
    for (let seed = 0; seed < 20; seed++) {
      const spot = destinationFor("wander", { x: 16, y: 4 }, anchors, mulberry32(seed));
      expect(spot).not.toBeNull();
      if (!spot) continue;
      const distance = Math.abs(spot.x - 16) + Math.abs(spot.y - 4);
      expect(distance).toBeLessThanOrEqual(6);
    }
  });

  it("keeps in-place activities in place", () => {
    expect(destinationFor("self", { x: 16, y: 4 }, anchors, mulberry32(1))).toBeNull();
  });
});

describe("moods", () => {
  it("names the dominant need", () => {
    expect(moodWord(needs({ stress: 90 }))).toBe("stressed");
    expect(moodWord(needs({ caffeine: 90, stress: 0 }))).toBe("caffeinated");
    expect(moodWord(needs({ social: 90, stress: 0, caffeine: 0 }))).toBe("chatty");
    expect(moodWord(needs({ focus: 90, social: 0, stress: 0, caffeine: 0 }))).toBe("focused");
    expect(moodWord(needs({ restlessness: 90, focus: 0, social: 0, stress: 0, caffeine: 0 }))).toBe("restless");
  });

  it("hashes ids stably", () => {
    expect(hashString("backend_abc")).toBe(hashString("backend_abc"));
    expect(hashString("backend_abc")).not.toBe(hashString("backend_xyz"));
  });
});
