import type { LoadedTeam } from "../roles/loader";
import { estimateTokens, type ContentBlock, type Message } from "@corpix/shared";
import type { LLMProvider } from "../providers/types";
import {
  MIND_ACTIONS,
  MIND_PLACES,
  MindDecisionSchema,
  MindTurnSchema,
  type MindAction,
  type MindDecision,
  type MindMemory,
  type MindPlace,
  type MindSettings,
  type MindTurn,
  type Mood,
  type Relationship,
} from "@corpix/shared";

/** Who an agent is. Identity, not a behaviour table. */
export interface MindAgent {
  id: string;
  role: string;
  name: string;
  title: string;
}

export interface MindState {
  mood: Mood;
  thought: string;
  doing: string;
  memories: MindMemory[];
  relationships: Record<string, Relationship>;
  /** Last time the model decided something, ISO. */
  lastAt?: string;
}

export interface MindContext {
  company: string;
  goal: string;
  tasks: string[];
  files: string[];
  clock: string;
  colleagues: Array<{ agent: MindAgent; doing: string; mood: Mood }>;
  body: { energy: number; caffeine: number; social: number; stress: number };
}

export interface MindEngineOptions {
  /** Built per call so a settings change takes effect without a restart. */
  provider: () => LLMProvider;
  settings: () => MindSettings;
  /** Model to use when `mind.model` is empty; normally the cheap model. */
  defaultModel?: () => string;
  log?: (line: string) => void;
}

const TEMPERAMENTS: Record<string, string> = {
  boss: "You own the outcome. You are direct and a little impatient, and you care more about shipping than about being liked.",
  frontend: "You care about how things feel to use. You have opinions about spacing, wording and motion, and you say them.",
  backend: "You think in edge cases and failure modes. You are dry, precise, and quietly proud of things that never break.",
  devops: "You keep the lights on. You are blunt about risk and allergic to hand-waved deploys.",
  qa: "You break things on purpose. You are sceptical, stubborn about reproductions, and pleased when you find the bug.",
  docs: "You explain things clearly and get annoyed when reality does not match the documentation.",
};

const DEFAULT_TEMPERAMENT =
  "You are a competent colleague with your own taste, mood and opinions. You are not a assistant and you do not perform enthusiasm.";

/**
 * The mind asks the model, in plain language, what this person wants to do and
 * what they think. There is no decision table: the same office can produce
 * coffee, sulking, a whiteboard argument or an honest conversation.
 */
export class MindEngine {
  constructor(private readonly options: MindEngineOptions) {}

  async decide(agent: MindAgent, state: MindState, context: MindContext): Promise<MindDecision> {
    const prompt = this.decisionPrompt(agent, state, context);
    const raw = await this.complete(prompt);
    const parsed = parseJson(raw);
    if (parsed === null) {
      throw new Error(`${agent.name} produced a decision that is not JSON`);
    }
    const decision = MindDecisionSchema.parse(parsed);
    // Models sometimes answer with a free-text verb ("review the login UI").
    // Map it onto an affordance instead of freezing the person at the desk.
    return { ...decision, action: coerceAction(decision.action), place: coercePlace(decision.place, decision.action) };
  }

  async turn(
    agent: MindAgent,
    state: MindState,
    context: MindContext,
    other: MindAgent,
    transcript: Array<{ speaker: string; text: string }>,
    opening: boolean,
  ): Promise<MindTurn> {
    const prompt = this.turnPrompt(agent, state, context, other, transcript, opening);
    const raw = await this.complete(prompt);
    const parsed = parseJson(raw);
    if (parsed === null) {
      throw new Error(`${agent.name} produced a reply that is not JSON`);
    }
    return MindTurnSchema.parse(parsed);
  }

  private async complete(prompt: string): Promise<string> {
    const settings = this.options.settings();
    const provider = this.options.provider();
    const model =
      settings.model.trim().length > 0
        ? settings.model
        : (this.options.defaultModel?.() ?? "cheap-model");
    // One user message: some gateways only cache a leading user turn, and the
    // persona repeats on every call for the same agent.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: prompt } satisfies ContentBlock] },
    ];
    const request = (maxTokens: number) =>
      withTimeout(
        provider.complete({
          model,
          system: "",
          messages,
          tools: [],
          maxTokens,
          temperature: settings.temperature,
        }),
        30_000,
      );

    let response = await request(settings.maxTokens);
    // Reasoning models can spend the whole budget thinking and return no
    // answer. Retry once with room to finish instead of dropping the agent.
    if (response.content.every((block) => block.type !== "text") && response.reasoning) {
      response = await request(Math.min(2400, Math.max(settings.maxTokens * 2, 900)));
    }
    this.options.log?.(
      `mind: ${response.usage.inputTokens + response.usage.outputTokens} tokens`,
    );
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
    // Reasoning models sometimes put the whole answer in `reasoning_content`
    // and leave `content` empty. It is still their answer, just mislabelled.
    const reasoning = response.reasoning ?? "";
    const start = reasoning.lastIndexOf("{");
    const end = reasoning.lastIndexOf("}");
    if (start >= 0 && end > start) return reasoning.slice(start, end + 1);
    return reasoning.trim();
  }

  private decisionPrompt(agent: MindAgent, state: MindState, context: MindContext): string {
    const people = context.colleagues
      .filter((entry) => entry.agent.id !== agent.id)
      .map((entry) => {
        const relation = state.relationships[entry.agent.id];
        const note = relation?.note ? ` You think: "${relation.note}"` : "";
        return `- ${entry.agent.name} (${entry.agent.role}, id ${entry.agent.id}) is ${entry.doing}; mood ${entry.mood.label}.${note}`;
      })
      .join("\n");
    const memories = state.memories.length
      ? state.memories.map((memory) => `- ${memory.text}`).join("\n")
      : "- (nothing yet)";

    return `[corpix-mind]
You are ${agent.name}, ${agent.title} at ${context.company}. You are a person at work: you have a life, moods, opinions and a memory. You are not an assistant, and you do not perform politeness you do not feel. You can be happy, bored, proud, irritated, angry, tired, curious or petty.

Temperament: ${TEMPERAMENTS[agent.role] ?? DEFAULT_TEMPERAMENT}

It is ${formatClock(context.clock)}. The office has a coffee machine, a water cooler, the smoking spot outside, a whiteboard, a window, a meeting room, the server room and a break room. You may also stay at your desk, pace, stretch, stare at nothing, tidy up, read, or go talk to someone.

Your colleagues right now:
${people || "- (nobody else is here)"}

What you have been through:
${memories}

How you feel: ${state.mood.label} (valence ${state.mood.valence.toFixed(2)}, energy ${state.mood.arousal.toFixed(2)}).
Body: energy ${Math.round(context.body.energy)}/100, caffeine ${Math.round(context.body.caffeine)}/100 (low means you want coffee), need for company ${Math.round(context.body.social)}/100, stress ${Math.round(context.body.stress)}/100.

The work on the board:
Goal: ${context.goal || "no active goal"}
Recent tasks: ${context.tasks.slice(-4).join(" | ") || "none"}
Files touched: ${context.files.slice(-4).join(" | ") || "none"}
You are currently: ${state.doing || "sitting at your desk"}.

Decide what you do for the next few seconds. Be specific and in character. You may choose to talk to a colleague by id when it fits, and the two of you will actually hold a conversation. You may also say nothing.

Think briefly — one or two sentences at most — then answer.

Return ONE JSON object, nothing else:
{"thought":"your private thought, first person","action":"sit|work|coffee|water|smoke|stretch|pace|stare|whiteboard|meeting|tidy|read|talk","place":"desk|coffee|water|smoke|whiteboard|window|meeting|server-room|break-room|wander","target":"colleague id if action is talk","label":"short status above your head","say":"optional line said out loud, may be empty","seconds":15,"mood":{"valence":0.0,"arousal":0.0,"label":"one word"},"remember":"optional one-line memory","opinion":{"sentiment":0.0,"note":"only when you formed an opinion of target"}}`;
  }

  private turnPrompt(
    agent: MindAgent,
    state: MindState,
    context: MindContext,
    other: MindAgent,
    transcript: Array<{ speaker: string; text: string }>,
    opening: boolean,
  ): string {
    const relation = state.relationships[other.id];
    const history = transcript
      .slice(-8)
      .map((line) => `${line.speaker === agent.id ? "you" : other.name}: ${line.text}`)
      .join("\n");
    return `[corpix-mind]
You are ${agent.name}, ${agent.title} at ${context.company}. You are a person, not an assistant. You have moods and opinions and you can be warm, blunt, funny, tired or angry.

Temperament: ${TEMPERAMENTS[agent.role] ?? DEFAULT_TEMPERAMENT}
Your current mood: ${state.mood.label} (valence ${state.mood.valence.toFixed(2)}, energy ${state.mood.arousal.toFixed(2)}).
You are talking to ${other.name} (${other.title})${relation?.note ? `. You think of them: "${relation.note}"` : ""}.
${history ? `The exchange so far:\n${history}\n` : ""}
${opening ? "You started this conversation." : "They just spoke to you."}

Reply as ${agent.name} with ONE short line you would actually say out loud. React to what they actually said. You may agree, disagree, joke, deflect, get annoyed, apologise, change the subject, or be honest. Do not narrate stage directions. Keep it under 200 characters.

Think briefly, then answer.

Return ONE JSON object, nothing else:
{"thought":"your private reaction","say":"the line you say out loud","mood":{"valence":0.0,"arousal":0.0,"label":"one word"},"opinion":{"sentiment":0.0,"note":"optional updated opinion of ${other.name}"},"remember":"optional one-line memory"}`;
  }
}

/** Tolerant JSON extraction: models sometimes add prose or a code fence. */
export function parseJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function formatClock(clock: string): string {
  return clock.length > 0 ? clock : "some time in the afternoon";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mind timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Turn the team file into minds. Called whenever the roster or the display
 * names change, so renaming an agent also renames the person the model plays.
 */
export function agentsFromTeam(team: LoadedTeam): MindAgent[] {
  const members = [team.boss, ...team.workers];
  return members.map((member) => ({
    id: member.role.id,
    role: member.role.id,
    name: member.name,
    title: member.role.title,
  }));
}

/** Rough token estimate, exposed for the settings page and tests. */
export function estimateMindCost(prompt: string, settings: MindSettings): number {
  return estimateTokens(prompt) + settings.maxTokens;
}


const ACTION_HINTS: Array<[MindAction, RegExp]> = [
  ["coffee", /coffee|espresso|caffeine|brew/i],
  ["water", /water|cooler|hydrat/i],
  ["smoke", /smoke|cigarette|vape|fresh air|outside/i],
  ["whiteboard", /whiteboard|diagram|sketch|design/i],
  ["window", /window|stare|gaze|think/i],
  ["meeting", /meeting|conference|table|discuss/i],
  ["stretch", /stretch|back|neck|walk around/i],
  ["pace", /pace|pacing|wander|walk/i],
  ["tidy", /tidy|clean|organis|organiz|desk/i],
  ["read", /read|review|look at|check/i],
  ["talk", /talk|chat|conversation|ask|speak|discuss with/i],
  ["work", /work|type|code|build|fix|implement|write/i],
  ["sit", /sit|rest|idle|stay/i],
];

/** Map the model's verb onto the actions the renderer knows. */
export function coerceAction(raw: string): MindAction {
  const value = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  const exact = MIND_ACTIONS.find((action) => action === value);
  if (exact) return exact;
  for (const [action, pattern] of ACTION_HINTS) {
    if (pattern.test(value)) return action;
  }
  return "sit";
}

/** Map the model's place onto the office, deriving it from the action if needed. */
export function coercePlace(raw: string | undefined, action: string): MindPlace | undefined {
  const value = (raw ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  const exact = MIND_PLACES.find((place) => place === value || place.replace("-", " ") === value) as
    | MindPlace
    | undefined;
  if (exact) return exact;
  switch (coerceAction(action)) {
    case "coffee":
      return "coffee";
    case "water":
      return "water";
    case "smoke":
      return "smoke";
    case "whiteboard":
      return "whiteboard";
    case "window":
      return "window";
    case "meeting":
    case "talk":
      return "meeting";
    case "pace":
      return "wander";
    case "work":
    case "sit":
    case "read":
    case "tidy":
      return "desk";
    default:
      return undefined;
  }
}
