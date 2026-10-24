/**
 * Small, honest helpers for the office renderer.
 *
 * There is deliberately no "activity planner" here any more. What an agent does
 * comes from its model; this file only hashes ids, draws mood colours, and
 * estimates how long a sentence takes to read.
 */

/** Deterministic 32-bit hash, used for stable per-agent variation. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** Seeded PRNG so screenshots and tests do not depend on wall clock. */
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

const EMOTION_COLORS: Record<string, number> = {
  happy: 0x6fd7a0,
  delighted: 0x6fd7a0,
  amused: 0x6fd7a0,
  proud: 0xffd75e,
  content: 0x9fd7a0,
  calm: 0x9fb3c8,
  focused: 0x7fb2ff,
  curious: 0x7fdcdc,
  interested: 0x7fb2ff,
  restless: 0xffab6b,
  bored: 0x8f9aa6,
  tired: 0x8f9aa6,
  "wiped out": 0x8f9aa6,
  anxious: 0xffab6b,
  annoyed: 0xff8f6b,
  grumpy: 0xff8f6b,
  frustrated: 0xff6b6b,
  angry: 0xff5b5b,
  hostile: 0xff5b5b,
};

/** Mood colour: the model's own word wins, valence is the fallback. */
export function moodTint(mood: { valence: number; label: string }): number {
  const named = EMOTION_COLORS[mood.label.toLowerCase()];
  if (named !== undefined) return named;
  if (mood.valence > 0.35) return 0x6fd7a0;
  if (mood.valence < -0.35) return 0xff6b6b;
  return 0x9fb3c8;
}

/** Colour for a real work state, used before the mind has an opinion. */
export function moodColor(state: string): number {
  switch (state) {
    case "working":
      return 0x6fd7a0;
    case "thinking":
      return 0x7fb2ff;
    case "blocked":
      return 0xffab6b;
    case "done":
      return 0x6fd7a0;
    case "error":
      return 0xff6b6b;
    default:
      return 0x9fb3c8;
  }
}
