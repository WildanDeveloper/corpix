/**
 * Idle behaviour for the office. This is deliberately deterministic: the office
 * is a renderer, so "personality" is a pure function of the agent id and a
 * seeded RNG, never of wall-clock randomness that would make screenshots flaky.
 */

export type IdleActivity =
  | "rest"
  | "fidget"
  | "coffee"
  | "wander"
  | "stretch"
  | "chat";

export interface IdlePlan {
  activity: IdleActivity;
  /** Seconds to stay on this activity. */
  duration: number;
  /** Short line shown in the speech bubble, or null for silence. */
  line: string | null;
}

const LINES: Record<IdleActivity, readonly string[]> = {
  rest: ["…", "thinking about the spec", "hm"],
  fidget: ["stretching", "where is my pen", "one sec"],
  coffee: ["refilling ☕", "coffee break", "needs caffeine"],
  wander: ["walking it off", "taking a lap", "stretching legs"],
  stretch: ["back in a moment", "aaaa", "ok, focus"],
  chat: ["syncing with the team", "quick question…", "got a sec?"],
};

/** Weighted table: resting is common, coffee and wandering are the flavour. */
const WEIGHTS: ReadonlyArray<readonly [IdleActivity, number]> = [
  ["rest", 30],
  ["fidget", 22],
  ["coffee", 18],
  ["wander", 16],
  ["stretch", 8],
  ["chat", 6],
];

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG so a given agent always behaves consistently. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickActivity(random: () => number): IdleActivity {
  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [activity, weight] of WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return activity;
  }
  return "rest";
}

export function pickLine(activity: IdleActivity, random: () => number): string | null {
  const options = LINES[activity];
  if (options.length === 0) return null;
  // Silence is a feature: constant chatter reads as noise, not personality.
  if (random() < 0.35) return null;
  return options[Math.floor(random() * options.length)] ?? null;
}

export function planIdle(agentId: string, previous: IdleActivity | null, round: number): IdlePlan {
  const random = mulberry32(hashString(`${agentId}:${round}`));
  let activity = pickActivity(random);
  // Never repeat the same activity twice in a row; it looks robotic.
  for (let attempt = 0; attempt < 6 && activity === previous; attempt++) {
    activity = pickActivity(random);
  }
  if (activity === previous) {
    const index = WEIGHTS.findIndex(([candidate]) => candidate === previous);
    activity = WEIGHTS[(index + 1) % WEIGHTS.length]?.[0] ?? "fidget";
  }
  const base = activity === "coffee" || activity === "wander" ? 5 : 3;
  return {
    activity,
    duration: base + random() * 3,
    line: pickLine(activity, random),
  };
}

/**
 * Where an idle activity happens, as an offset from the agent's desk. Returned in
 * tiles so the caller can resolve it against the walkable grid.
 */
export function idleDestination(
  activity: IdleActivity,
  deskStand: { x: number; y: number },
  coffeeSpot: { x: number; y: number },
  meetingSpots: ReadonlyArray<{ x: number; y: number }>,
  random: () => number,
): { x: number; y: number } | null {
  switch (activity) {
    case "coffee":
      return coffeeSpot;
    case "chat": {
      const spot = meetingSpots[Math.floor(random() * meetingSpots.length)];
      return spot ?? null;
    }
    case "wander": {
      const angle = random() * Math.PI * 2;
      const radius = 2 + Math.floor(random() * 3);
      return {
        x: deskStand.x + Math.round(Math.cos(angle) * radius),
        y: deskStand.y + Math.round(Math.sin(angle) * radius),
      };
    }
    default:
      return null;
  }
}

/** Mood tint for the name label, so a busy team is readable at a glance. */
export function moodColor(state: string): number {
  switch (state) {
    case "working":
      return 0x6fd7a0;
    case "thinking":
      return 0xffd75e;
    case "blocked":
      return 0xffab6b;
    case "error":
      return 0xff6b6b;
    case "done":
      return 0x9be89b;
    default:
      return 0x9fb3c8;
  }
}
