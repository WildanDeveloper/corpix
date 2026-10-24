import type { MindDecision, MindSettings, MindTurn, Mood } from "@corpix/shared";
import type { MindAgent, MindContext, MindEngine, MindState } from "./engine";

/** Events the office renders. Payloads are intentionally plain JSON. */
export type MindEvent = (type: string, payload: Record<string, unknown>) => void;

export interface MindRunContext {
  goal: string;
  tasks: string[];
  files: string[];
}

export interface MindRunnerOptions {
  agents: () => MindAgent[];
  engine: MindEngine;
  settings: () => MindSettings;
  context: () => MindRunContext;
  company: () => string;
  emit: MindEvent;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Pause the loop while an actual task is running. */
  busy?: () => boolean;
}

interface Conversation {
  id: string;
  a: MindAgent;
  b: MindAgent;
  turns: number;
}

const DEFAULT_MOOD: Mood = { valence: 0.05, arousal: 0, label: "neutral" };

/**
 * Drives every agent's inner life.
 *
 * There is no rule table here: each tick asks a model, in character, what this
 * person wants to do next. The runner only keeps the consequences — mood,
 * memory, opinions, what they are doing — and asks the other side for a real
 * reply when two of them talk.
 */
export class MindRunner {
  private readonly states = new Map<string, MindState>();
  private readonly body = new Map<string, { energy: number; caffeine: number; social: number; stress: number }>();
  private readonly nextAt = new Map<string, number>();
  private conversation: Conversation | null = null;
  private running = false;
  private lastTick = 0;
  private counter = 0;

  constructor(private readonly options: MindRunnerOptions) {}

  /** Restore persisted inner lives so a restart is not a personality wipe. */
  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== "object") return;
    const data = snapshot as {
      states?: Record<string, MindState>;
      body?: Record<string, { energy: number; caffeine: number; social: number; stress: number }>;
    };
    for (const [role, state] of Object.entries(data.states ?? {})) {
      this.states.set(role, {
        mood: state.mood ?? { ...DEFAULT_MOOD },
        thought: state.thought ?? "",
        doing: state.doing ?? "",
        memories: Array.isArray(state.memories) ? state.memories : [],
        relationships: state.relationships ?? {},
        lastAt: state.lastAt,
      });
    }
    for (const [role, body] of Object.entries(data.body ?? {})) this.body.set(role, body);
  }

  snapshot(): unknown {
    return {
      states: Object.fromEntries(this.states),
      body: Object.fromEntries(this.body),
    };
  }

  /** Everything the UI needs to show the inner life of the office. */
  minds(): Array<{
    agentId: string;
    role: string;
    name: string;
    mood: Mood;
    thought: string;
    doing: string;
    memories: MindState["memories"];
    relationships: MindState["relationships"];
  }> {
    return this.options.agents().map((agent) => {
      const state = this.stateOf(agent);
      return {
        agentId: agent.id,
        role: agent.role,
        name: agent.name,
        mood: state.mood,
        thought: state.thought,
        doing: state.doing,
        memories: state.memories,
        relationships: state.relationships,
      };
    });
  }

  stateOf(agent: MindAgent): MindState {
    let state = this.states.get(agent.id);
    if (!state) {
      state = { mood: { ...DEFAULT_MOOD }, thought: "", doing: "", memories: [], relationships: {} };
      this.states.set(agent.id, state);
    }
    return state;
  }

  bodyOf(agent: MindAgent): { energy: number; caffeine: number; social: number; stress: number } {
    let body = this.body.get(agent.id);
    if (!body) {
      // Deterministic start: not every agent is tired at the same time.
      const seed = [...agent.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      body = {
        energy: 62 + (seed % 20),
        caffeine: 30 + (seed % 35),
        social: 35 + (seed % 30),
        stress: 20 + (seed % 25),
      };
      this.body.set(agent.id, body);
    }
    return body;
  }

  /**
   * One heartbeat. Cheap: it only starts decisions whose cooldown expired, and
   * never runs during a real task or an ongoing conversation.
   */
  tick(): void {
    const settings = this.options.settings();
    if (!settings.enabled) return;
    if (this.running) return;
    if (this.conversation) return;
    if (this.options.busy?.()) return;

    const now = this.now();
    if (now - this.lastTick < 1000) return;
    this.lastTick = now;

    const candidates = this.options
      .agents()
      .filter((agent) => (this.nextAt.get(agent.id) ?? 0) <= now)
      .slice(0, settings.maxConcurrent);
    if (candidates.length === 0) return;

    this.running = true;
    void this.decideAll(candidates, settings).finally(() => {
      this.running = false;
    });
  }

  /** An operator typed something to this agent. The agent answers in character. */
  async speakTo(agentId: string, text: string): Promise<{ name: string; say: string } | null> {
    const agent = this.options.agents().find((entry) => entry.id === agentId);
    if (!agent) return null;
    const operator: MindAgent = { id: "operator", role: "operator", name: "Operator", title: "the person watching the office" };
    const settings = this.options.settings();
    const state = this.stateOf(agent);
    const transcript = [{ speaker: "operator", text }];
    const turn = await this.options.engine.turn(
      agent,
      state,
      this.contextFor(agent),
      operator,
      transcript,
      false,
    );
    this.applyTurn(agent, turn, operator, settings);
    this.options.emit("mind.said", {
      agentId: agent.id,
      role: agent.role,
      name: agent.name,
      text: turn.say,
      to: "operator",
    });
    return { name: agent.name, say: turn.say };
  }

  private async decideAll(agents: MindAgent[], settings: MindSettings): Promise<void> {
    for (const agent of agents) {
      if (this.conversation) return;
      try {
        const state = this.stateOf(agent);
        const decision = await this.options.engine.decide(agent, state, this.contextFor(agent));
        this.applyDecision(agent, decision, settings);
        this.options.emit("mind.decided", {
          agentId: agent.id,
          role: agent.role,
          name: agent.name,
          thought: decision.thought,
          action: decision.action,
          place: decision.place,
          target: decision.target,
          label: decision.label,
          say: decision.say,
          seconds: decision.seconds,
          mood: this.stateOf(agent).mood,
        });
        // A line that opens a conversation is spoken inside it, not twice.
        const isTalk =
          (decision.action === "talk" || decision.action === "chat") && Boolean(decision.target);
        if (!isTalk && decision.say && decision.say.trim().length > 0) {
          this.options.emit("mind.said", {
            agentId: agent.id,
            role: agent.role,
            name: agent.name,
            text: decision.say,
          });
        }
        if (isTalk) {
          const target = this.options.agents().find((entry) => entry.id === decision.target);
          if (target && target.id !== agent.id) {
            await this.converse(agent, target, decision, settings);
            return;
          }
        }
      } catch (error) {
        this.options.log?.(`mind: ${agent.name}: ${(error as Error).message}`);
        // A failed thought is not a crashed person: try again next interval.
        this.nextAt.set(agent.id, this.now() + settings.intervalSeconds * 1000);
      }
    }
  }

  /**
   * Two people, two models, real turns. Each line is generated with the actual
   * transcript in the prompt, so the reply answers what was just said instead of
   * following a script.
   */
  private async converse(
    initiator: MindAgent,
    partner: MindAgent,
    decision: MindDecision,
    settings: MindSettings,
  ): Promise<void> {
    const id = `chat-${++this.counter}`;
    this.conversation = { id, a: initiator, b: partner, turns: 0 };
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    const transcript: Array<{ speaker: string; text: string }> = [];
    this.options.emit("mind.conversation.started", {
      conversationId: id,
      participants: [
        { agentId: initiator.id, role: initiator.role, name: initiator.name },
        { agentId: partner.id, role: partner.role, name: partner.name },
      ],
      mood: this.stateOf(initiator).mood,
    });

    try {
      for (let turn = 0; turn < settings.maxTurns; turn++) {
        const speaker = turn % 2 === 0 ? initiator : partner;
        const other = turn % 2 === 0 ? partner : initiator;
        let line: MindTurn | null = null;

        if (turn === 0 && decision.say && decision.say.trim().length > 0) {
          // The opener was already produced with the decision; do not pay twice.
          line = { thought: decision.thought, say: decision.say };
        } else {
          line = await this.options.engine.turn(
            speaker,
            this.stateOf(speaker),
            this.contextFor(speaker),
            other,
            transcript,
            turn === 0,
          );
        }

        this.applyTurn(speaker, line, other, settings);
        transcript.push({ speaker: speaker.id, text: line.say });
        this.conversation.turns = turn + 1;
        this.options.emit("mind.conversation.line", {
          conversationId: id,
          agentId: speaker.id,
          role: speaker.role,
          name: speaker.name,
          text: line.say,
          index: turn,
          mood: this.stateOf(speaker).mood,
        });
        // Pace generation to the reading speed so the UI queue never piles up.
        await sleep(Math.min(4200, 1400 + line.say.length * 38));
      }
    } catch (error) {
      this.options.log?.(`mind conversation: ${(error as Error).message}`);
    } finally {
      this.options.emit("mind.conversation.ended", {
        conversationId: id,
        participants: [initiator.id, partner.id],
        turns: this.conversation?.turns ?? 0,
      });
      this.conversation = null;
      const next = this.now() + settings.intervalSeconds * 1000;
      this.nextAt.set(initiator.id, next);
      this.nextAt.set(partner.id, next + 2000);
    }
  }

  private applyDecision(agent: MindAgent, decision: MindDecision, settings: MindSettings): void {
    const state = this.stateOf(agent);
    state.thought = decision.thought || state.thought;
    state.doing = decision.label || decision.action;
    state.lastAt = new Date(this.now()).toISOString();
    this.mergeMood(state, decision.mood);
    this.pushMemory(state, decision.remember, settings);
    if (decision.target && decision.opinion) this.mergeOpinion(state, decision.target, decision.opinion);
    this.updateBody(agent, decision.action);
    const jitter = 0.85 + Math.random() * 0.4;
    this.nextAt.set(agent.id, this.now() + settings.intervalSeconds * 1000 * jitter);
  }

  private applyTurn(agent: MindAgent, turn: MindTurn, other: MindAgent, settings: MindSettings): void {
    const state = this.stateOf(agent);
    state.thought = turn.thought || state.thought;
    state.lastAt = new Date(this.now()).toISOString();
    this.mergeMood(state, turn.mood);
    this.pushMemory(state, turn.remember, settings);
    if (turn.opinion) this.mergeOpinion(state, other.id, turn.opinion);
    const relation = state.relationships[other.id] ?? { sentiment: 0, note: "", talks: 0 };
    state.relationships[other.id] = { ...relation, talks: relation.talks + 1 };
    const body = this.bodyOf(agent);
    body.social = clamp(body.social - 18);
    body.stress = clamp(body.stress - 6);
    this.body.set(agent.id, body);
  }

  private mergeMood(state: MindState, mood: MindDecision["mood"]): void {
    if (!mood) return;
    const next = state.mood;
    if (typeof mood.valence === "number") next.valence = clampSigned(next.valence * 0.55 + mood.valence * 0.45);
    if (typeof mood.arousal === "number") next.arousal = clampSigned(next.arousal * 0.55 + mood.arousal * 0.45);
    if (mood.label) next.label = mood.label.slice(0, 32);
    state.mood = { ...next };
  }

  private mergeOpinion(
    state: MindState,
    id: string,
    opinion: { sentiment?: number; note?: string },
  ): void {
    const current = state.relationships[id] ?? { sentiment: 0, note: "", talks: 0 };
    state.relationships[id] = {
      sentiment:
        typeof opinion.sentiment === "number"
          ? clampSigned(current.sentiment * 0.6 + opinion.sentiment * 0.4)
          : current.sentiment,
      note: opinion.note?.slice(0, 160) ?? current.note,
      talks: current.talks,
    };
  }

  private pushMemory(state: MindState, memory: string | undefined, settings: MindSettings): void {
    if (!memory || memory.trim().length === 0 || settings.memorySize === 0) return;
    state.memories = [
      { at: new Date(this.now()).toISOString(), text: memory.trim().slice(0, 200) },
      ...state.memories,
    ].slice(0, settings.memorySize);
  }

  private updateBody(agent: MindAgent, action: string): void {
    const body = this.bodyOf(agent);
    body.energy = clamp(body.energy - 2);
    body.caffeine = clamp(body.caffeine + 2);
    body.social = clamp(body.social + 1);
    body.stress = clamp(body.stress + 1);
    switch (action) {
      case "coffee":
        body.caffeine = clamp(body.caffeine - 55);
        body.energy = clamp(body.energy + 8);
        break;
      case "water":
        body.energy = clamp(body.energy + 4);
        break;
      case "smoke":
        body.stress = clamp(body.stress - 25);
        body.caffeine = clamp(body.caffeine - 10);
        break;
      case "stretch":
      case "pace":
      case "wander":
        body.energy = clamp(body.energy + 3);
        body.stress = clamp(body.stress - 6);
        break;
      case "meeting":
      case "talk":
        body.social = clamp(body.social - 22);
        break;
      case "work":
        body.energy = clamp(body.energy - 4);
        body.stress = clamp(body.stress + 4);
        break;
      default:
        break;
    }
    this.body.set(agent.id, body);
  }

  private contextFor(agent: MindAgent): MindContext {
    const run = this.options.context();
    const colleagues = this.options
      .agents()
      .map((entry) => ({
        agent: entry,
        doing: this.stateOf(entry).doing || "at their desk",
        mood: this.stateOf(entry).mood,
      }));
    return {
      company: this.options.company(),
      goal: run.goal,
      tasks: run.tasks,
      files: run.files,
      clock: new Date(this.now()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      colleagues,
      body: this.bodyOf(agent),
    };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
