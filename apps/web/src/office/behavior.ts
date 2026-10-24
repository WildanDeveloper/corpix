/**
 * Idle "life" for the office.
 *
 * Every agent keeps a small set of needs that drift over time (focus, social,
 * caffeine, restlessness, stress). The highest-pressure need decides what the
 * agent does next, which is why two agents with the same role behave differently
 * and why the same agent does not loop on one activity.
 *
 * Everything is seeded from the agent id, so a run is reproducible: screenshots
 * and tests do not depend on wall-clock randomness.
 */

export type Need = "focus" | "social" | "caffeine" | "restlessness" | "stress";

export type IdleActivity =
  | "rest"
  | "fidget"
  | "coffee"
  | "water"
  | "smoke"
  | "wander"
  | "stretch"
  | "chat"
  | "pair-chat"
  | "whiteboard"
  | "window"
  | "meeting"
  | "desk-tidy";

/** Where an activity happens. `self` means stay put. */
export type ActivityPlace = "self" | "coffee" | "water" | "smoke" | "wander" | "meeting" | "whiteboard" | "window";

export interface NeedState {
  focus: number;
  social: number;
  caffeine: number;
  restlessness: number;
  stress: number;
}

export interface IdlePlan {
  activity: IdleActivity;
  place: ActivityPlace;
  /** Seconds the activity lasts. */
  duration: number;
  /** Line shown above the head. */
  label: string;
  /** Optional speech bubble. */
  line: string | null;
  /** True when this activity wants a partner. */
  social: boolean;
}

export const INITIAL_NEEDS: NeedState = {
  focus: 45,
  social: 35,
  caffeine: 35,
  restlessness: 30,
  stress: 30,
};

/**
 * Each agent starts with slightly different pressure, so the office does not
 * synchronise into "everyone gets coffee at once". Deterministic per id.
 */
export function seededNeeds(agentId: string): NeedState {
  const random = mulberry32(hashString(`${agentId}:needs`));
  const jitter = (): number => Math.round((random() - 0.5) * 26);
  return {
    focus: clamp(INITIAL_NEEDS.focus + jitter()),
    social: clamp(INITIAL_NEEDS.social + jitter()),
    caffeine: clamp(INITIAL_NEEDS.caffeine + jitter()),
    restlessness: clamp(INITIAL_NEEDS.restlessness + jitter()),
    stress: clamp(INITIAL_NEEDS.stress + jitter()),
  };
}

const LABELS: Record<IdleActivity, string> = {
  rest: "at the desk",
  fidget: "fidgeting",
  coffee: "getting coffee",
  water: "at the water cooler",
  smoke: "on a smoke break",
  wander: "taking a lap",
  stretch: "stretching",
  chat: "looking for someone",
  "pair-chat": "chatting",
  whiteboard: "at the whiteboard",
  window: "staring out the window",
  meeting: "in the meeting room",
  "desk-tidy": "tidying the desk",
};

const LINES: Record<IdleActivity, readonly string[]> = {
  rest: ["…", "ok, what next", "reading the spec again"],
  fidget: ["where is my pen", "one sec", "hm"],
  coffee: ["refilling ☕", "needs caffeine", "third cup today"],
  water: ["hydration check", "brb", "water break"],
  smoke: ["back in five", "needs air", "thinking outside"],
  wander: ["walking it off", "taking a lap", "stretching legs"],
  stretch: ["back in a moment", "aaaa", "ok, focus"],
  chat: ["got a sec?", "quick question…", "can you look at this?"],
  "pair-chat": ["did you see the diff?", "how do you mock that?", "nice, that works"],
  whiteboard: ["sketching the flow", "wait, what if…", "drawing the schema"],
  window: ["nice weather", "long day", "watching the rain"],
  meeting: ["syncing", "quick sync", "aligning on scope"],
  "desk-tidy": ["cleaning up", "where does this go", "tidy desk, tidy mind"],
};

const PLACES: Record<IdleActivity, ActivityPlace> = {
  rest: "self",
  fidget: "self",
  coffee: "coffee",
  water: "water",
  smoke: "smoke",
  wander: "wander",
  stretch: "self",
  chat: "meeting",
  "pair-chat": "self",
  whiteboard: "whiteboard",
  window: "window",
  meeting: "meeting",
  "desk-tidy": "self",
};

/** Which need drives which activity, and how much it relieves it. */
const ACTIVITY_EFFECTS: Record<IdleActivity, Partial<Record<Need, number>>> = {
  rest: { focus: 18, restlessness: 6 },
  fidget: { restlessness: -14, stress: 4 },
  coffee: { caffeine: -40, social: 6 },
  water: { caffeine: -12, stress: -8 },
  smoke: { stress: -26, restlessness: -8 },
  wander: { restlessness: -26, focus: 5 },
  stretch: { restlessness: -14, stress: -4 },
  chat: { social: -34, stress: -6 },
  "pair-chat": { social: -40, stress: -10, focus: 4 },
  whiteboard: { focus: 14, social: 8 },
  window: { stress: -18, restlessness: 6 },
  meeting: { social: -26, focus: 8 },
  "desk-tidy": { focus: 10, restlessness: -10 },
};

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

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

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

/**
 * Needs drift every second: caffeine and social pressure build up, focus and
 * restlessness decay towards a baseline. Working hard raises stress.
 */
export function driftNeeds(needs: NeedState, seconds: number, working: boolean): NeedState {
  const rate = seconds / 10;
  return {
    focus: clamp(needs.focus + (working ? -1.4 : 0.35) * rate),
    social: clamp(needs.social + (working ? 0.6 : 1.1) * rate),
    caffeine: clamp(needs.caffeine + 0.9 * rate),
    restlessness: clamp(needs.restlessness + (working ? 0.4 : 0.8) * rate),
    stress: clamp(needs.stress + (working ? 1.2 : 0.45) * rate),
  };
}

export function applyActivity(needs: NeedState, activity: IdleActivity): NeedState {
  const effects = ACTIVITY_EFFECTS[activity];
  const next = { ...needs };
  for (const [need, delta] of Object.entries(effects) as Array<[Need, number]>) {
    next[need] = clamp(next[need] + delta);
  }
  return next;
}

/**
 * Pick the activity that relieves the strongest need, with a little noise so the
 * office does not look choreographed. Activities that were just used are pushed
 * down the list, which is what stops the "always coffee" loop.
 */
export function chooseActivity(
  needs: NeedState,
  random: () => number,
  recent: readonly IdleActivity[],
  options: { allowSmoke?: boolean; allowSocial?: boolean } = {},
): IdleActivity {
  const { allowSmoke = true, allowSocial = true } = options;
  const pressure: Array<{ activity: IdleActivity; score: number }> = [];

  const push = (activity: IdleActivity, need: Need, weight = 1): void => {
    if (activity === "smoke" && !allowSmoke) return;
    if ((activity === "chat" || activity === "pair-chat" || activity === "meeting") && !allowSocial) return;
    const recentPenalty = recent.includes(activity) ? 55 : 0;
    const jitter = random() * 18;
    pressure.push({ activity, score: needs[need] * weight + jitter - recentPenalty });
  };

  push("coffee", "caffeine", 1.05);
  push("water", "caffeine", 0.5);
  push("smoke", "stress", 1.2);
  push("window", "stress", 0.55);
  push("stretch", "restlessness", 0.75);
  push("wander", "restlessness", 1.0);
  push("fidget", "restlessness", 0.55);
  push("chat", "social", 1.15);
  push("pair-chat", "social", 1.4);
  push("meeting", "social", 0.6);
  // The whiteboard is a treat, not a habit: focus also drives resting and
  // tidying, so a low weight here keeps the room from clustering at the board.
  push("whiteboard", "focus", 0.18);
  push("desk-tidy", "focus", 0.22);
  push("rest", "focus", 0.8);

  pressure.sort((a, b) => b.score - a.score);
  return pressure[0]?.activity ?? "rest";
}

export function planIdle(
  agentId: string,
  needs: NeedState,
  round: number,
  recent: readonly IdleActivity[] = [],
  options: { allowSmoke?: boolean; allowSocial?: boolean } = {},
): IdlePlan {
  const random = mulberry32(hashString(`${agentId}:${round}:idle`));
  const activity = chooseActivity(needs, random, recent, options);
  const place = PLACES[activity];
  const base =
    place === "self" ? 4 : place === "wander" ? 5 : place === "meeting" ? 7 : 6;
  const line = random() < 0.42 ? null : (LINES[activity][Math.floor(random() * LINES[activity].length)] ?? null);

  return {
    activity,
    place,
    duration: base + random() * 3,
    label: LABELS[activity],
    line,
    social: activity === "pair-chat" || activity === "chat" || activity === "meeting",
  };
}

/** Where a place is, resolved against the office layout by the caller. */
export function destinationFor(
  place: ActivityPlace,
  deskStand: { x: number; y: number },
  anchors: {
    coffee: { x: number; y: number };
    water: { x: number; y: number };
    smoke: { x: number; y: number };
    whiteboard: { x: number; y: number };
    window: { x: number; y: number };
    meeting: ReadonlyArray<{ x: number; y: number }>;
  },
  random: () => number,
): { x: number; y: number } | null {
  switch (place) {
    case "coffee":
      return anchors.coffee;
    case "water":
      return anchors.water;
    case "smoke":
      return anchors.smoke;
    case "whiteboard":
      return anchors.whiteboard;
    case "window":
      return anchors.window;
    case "meeting": {
      const spot = anchors.meeting[Math.floor(random() * anchors.meeting.length)];
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

/** Short mood word shown in the debug overlay and used for label tint. */
export function moodWord(needs: NeedState): string {
  if (needs.stress > 65) return "stressed";
  if (needs.caffeine > 70) return "caffeinated";
  if (needs.social > 70) return "chatty";
  if (needs.focus > 70) return "focused";
  if (needs.restlessness > 70) return "restless";
  return "calm";
}
