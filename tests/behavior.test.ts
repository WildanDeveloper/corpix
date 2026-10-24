import { describe, expect, it } from "vitest";
import {
  hashString,
  idleDestination,
  moodColor,
  mulberry32,
  pickActivity,
  pickLine,
  planIdle,
} from "../apps/web/src/office/behavior";

describe("deterministic agent personality", () => {
  it("hashes ids stably", () => {
    expect(hashString("backend_abc")).toBe(hashString("backend_abc"));
    expect(hashString("backend_abc")).not.toBe(hashString("backend_xyz"));
  });

  it("produces the same plan for the same agent and round", () => {
    const first = planIdle("backend_abc", null, 3);
    const second = planIdle("backend_abc", null, 3);
    expect(second).toEqual(first);
  });

  it("produces different plans across rounds", () => {
    const plans = new Set(
      Array.from({ length: 8 }, (_, round) => JSON.stringify(planIdle("qa_1", null, round))),
    );
    expect(plans.size).toBeGreaterThan(4);
  });

  it("never repeats the previous activity", () => {
    for (let round = 1; round <= 30; round++) {
      const previous = planIdle("devops_9", null, round - 1).activity;
      const next = planIdle("devops_9", previous, round).activity;
      expect(next).not.toBe(previous);
    }
  });

  it("keeps durations in a readable range", () => {
    for (let round = 1; round <= 20; round++) {
      const plan = planIdle("boss", null, round);
      expect(plan.duration).toBeGreaterThanOrEqual(3);
      expect(plan.duration).toBeLessThanOrEqual(8);
    }
  });

  it("covers every activity across agents", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 60; index++) {
      seen.add(planIdle(`agent_${index}`, null, index).activity);
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it("stays silent sometimes, so the office is not constant chatter", () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      planIdle(`agent_${index}`, null, index).line,
    );
    expect(lines.some((line) => line === null)).toBe(true);
    expect(lines.some((line) => line !== null)).toBe(true);
  });

  it("is a pure function of the seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(pickActivity(mulberry32(7))).toBe(pickActivity(mulberry32(7)));
    expect(pickLine("coffee", mulberry32(3))).toBe(pickLine("coffee", mulberry32(3)));
  });
});

describe("idle destinations", () => {
  const coffee = { x: 23, y: 16 };
  const spots = [
    { x: 3, y: 14 },
    { x: 4, y: 14 },
  ];

  it("sends coffee drinkers to the coffee machine", () => {
    expect(idleDestination("coffee", { x: 16, y: 4 }, coffee, spots, mulberry32(1))).toEqual(coffee);
  });

  it("sends chats to a meeting spot", () => {
    const spot = idleDestination("chat", { x: 16, y: 4 }, coffee, spots, mulberry32(1));
    expect(spots).toContainEqual(spot);
  });

  it("wanders near the desk, not across the office", () => {
    const desk = { x: 16, y: 4 };
    for (let seed = 0; seed < 20; seed++) {
      const spot = idleDestination("wander", desk, coffee, spots, mulberry32(seed));
      expect(spot).not.toBeNull();
      if (!spot) continue;
      const distance = Math.abs(spot.x - desk.x) + Math.abs(spot.y - desk.y);
      expect(distance).toBeLessThanOrEqual(6);
    }
  });

  it("keeps resting agents where they are", () => {
    expect(idleDestination("rest", { x: 16, y: 4 }, coffee, spots, mulberry32(1))).toBeNull();
    expect(idleDestination("fidget", { x: 16, y: 4 }, coffee, spots, mulberry32(1))).toBeNull();
  });
});

describe("mood colours", () => {
  it("gives each state a distinct colour", () => {
    const colours = ["idle", "working", "thinking", "blocked", "error", "done"].map(moodColor);
    expect(new Set(colours).size).toBe(6);
  });
});
