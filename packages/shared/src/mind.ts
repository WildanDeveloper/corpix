import { z } from "zod";

/**
 * Mind: the part of an agent that is not scripted.
 *
 * Nothing here decides what an agent does. These are the *shapes* the model
 * fills in when it is asked "what do you want to do now?" and "what do you think
 * of the person talking to you?". The office only renders the result.
 */

/** Mood is a point in a two-axis space plus the words the agent chose for it. */
export const MoodSchema = z.object({
  /** -1 miserable … +1 delighted */
  valence: z.number().min(-1).max(1).default(0),
  /** -1 flat … +1 wired */
  arousal: z.number().min(-1).max(1).default(0),
  /** The agent's own word: "restless", "smug", "wiped out", … */
  label: z.string().min(1).max(32).default("neutral"),
});
export type Mood = z.infer<typeof MoodSchema>;

/** What an agent privately thinks of a colleague, and why. */
export const RelationshipSchema = z.object({
  /** -1 hostile … +1 fond */
  sentiment: z.number().min(-1).max(1).default(0),
  /** A sentence in the agent's own voice, e.g. "reviews everything twice". */
  note: z.string().max(160).default(""),
  /** How many conversations they have had. */
  talks: z.number().int().nonnegative().default(0),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const MindMemorySchema = z.object({
  at: z.string(),
  /** First person, one line. */
  text: z.string().max(200),
});
export type MindMemory = z.infer<typeof MindMemorySchema>;

/**
 * One decision. The model must return this as JSON; every field is optional so a
 * partial answer still moves the agent instead of throwing the turn away.
 */
export const MindDecisionSchema = z.object({
  /** Inner monologue, first person, never spoken aloud. */
  thought: z.string().max(400).default(""),
  /** One of the ACTION ids the prompt offers. */
  action: z.string().min(1).default("sit"),
  /** Optional place id from the prompt (coffee, smoke, whiteboard, …). */
  place: z.string().max(32).optional(),
  /** Optional colleague id this action involves. */
  target: z.string().max(64).optional(),
  /** Short status line above the head, e.g. "staring at the diff". */
  label: z.string().max(48).optional(),
  /** Said out loud, if anything. Empty means silence, which is allowed. */
  say: z.string().max(280).optional(),
  /** How long the agent intends to do this, in seconds. */
  seconds: z.number().min(2).max(120).optional(),
  mood: MoodSchema.partial().optional(),
  /** Something to remember afterwards, first person. */
  remember: z.string().max(200).optional(),
  /** Update to a relationship with `target`. */
  opinion: z
    .object({
      sentiment: z.number().min(-1).max(1).optional(),
      note: z.string().max(160).optional(),
    })
    .optional(),
});
export type MindDecision = z.infer<typeof MindDecisionSchema>;

/** A single utterance inside a conversation, produced by the speaker's mind. */
export const MindTurnSchema = z.object({
  thought: z.string().max(400).default(""),
  say: z.string().min(1).max(280),
  /** Optional mood shift caused by the exchange. */
  mood: MoodSchema.partial().optional(),
  /** Optional updated opinion of the person being spoken to. */
  opinion: z
    .object({
      sentiment: z.number().min(-1).max(1).optional(),
      note: z.string().max(160).optional(),
    })
    .optional(),
  remember: z.string().max(200).optional(),
});
export type MindTurn = z.infer<typeof MindTurnSchema>;

/** What the office shows for one agent: its inner life, in one object. */
export interface MindSnapshot {
  agentId: string;
  role: string;
  name: string;
  mood: Mood;
  /** Current inner monologue. */
  thought: string;
  /** What it is doing right now, in its own words. */
  doing: string;
  memories: MindMemory[];
  relationships: Record<string, Relationship>;
  /** Idle agents the model may talk to. */
  talks: number;
}

export const MindSettingsSchema = z.object({
  /** When off, agents fall back to sitting still: no model calls, no cost. */
  enabled: z.boolean().default(true),
  /** Seconds between two decisions for the same agent. */
  intervalSeconds: z.number().min(3).max(600).default(14),
  /** Model used for minds; empty means the cheap model. */
  model: z.string().default(""),
  maxTokens: z.number().int().positive().max(4096).default(900),
  temperature: z.number().min(0).max(2).default(0.95),
  /** Exchanges before a conversation ends. */
  maxTurns: z.number().int().min(2).max(12).default(6),
  /** Only this many agents may think per interval, so cost stays bounded. */
  maxConcurrent: z.number().int().min(1).max(8).default(2),
  /** How many past experiences an agent remembers. */
  memorySize: z.number().int().min(0).max(24).default(8),
  /** Let the model speak to the operator, not only to colleagues. */
  allowOperatorChat: z.boolean().default(true),
  /**
   * Language the agents speak. `auto` follows the company language, which is
   * what most teams want; `id` and `en` force it so the office never drifts
   * back to English after an English task.
   */
  language: z.enum(["auto", "id", "en"]).default("auto"),
});
export type MindSettings = z.infer<typeof MindSettingsSchema>;

export const DEFAULT_MIND: MindSettings = {
  enabled: true,
  intervalSeconds: 14,
  model: "",
  maxTokens: 900,
  temperature: 0.95,
  maxTurns: 6,
  maxConcurrent: 2,
  memorySize: 8,
  allowOperatorChat: true,
  language: "auto",
};

/** Places the office can render. The prompt lists the ids, the scene maps them. */
export const MIND_PLACES = [
  "desk",
  "coffee",
  "water",
  "smoke",
  "whiteboard",
  "window",
  "meeting",
  "server-room",
  "break-room",
  "wander",
] as const;
export type MindPlace = (typeof MIND_PLACES)[number];

/**
 * Actions are verbs the scene understands. `talk` and `chat` start a
 * conversation; everything else is a solo activity.
 */
export const MIND_ACTIONS = [
  "work",
  "sit",
  "coffee",
  "water",
  "smoke",
  "stretch",
  "pace",
  "stare",
  "window",
  "whiteboard",
  "meeting",
  "tidy",
  "read",
  "talk",
  "leave",
] as const;
export type MindAction = (typeof MIND_ACTIONS)[number];
