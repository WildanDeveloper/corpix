import { describe, expect, it } from "vitest";
import { MindEngine, languageRule, parseJson, type MindAgent, type MindEngineOptions, type MindState } from "@corpix/agents";
import { MindRunner } from "@corpix/agents";
import { MockProvider } from "@corpix/agents";
import { DEFAULT_MIND, type MindSettings } from "@corpix/shared";

const backend: MindAgent = { id: "backend", role: "backend", name: "Rizky", title: "Backend Engineer" };
const frontend: MindAgent = { id: "frontend", role: "frontend", name: "Fiona", title: "Frontend Engineer" };
const qa: MindAgent = { id: "qa", role: "qa", name: "Sinta", title: "QA Engineer" };

function freshState(): MindState {
  return {
    mood: { valence: 0, arousal: 0, label: "neutral" },
    thought: "",
    doing: "",
    memories: [],
    relationships: {},
  };
}

const context = {
  company: "Corpix",
  goal: "Ship a todo app",
  tasks: ["Add the API", "Add the form"],
  files: ["apps/server/src/todo.ts"],
  clock: "14:31",
  colleagues: [
    { agent: frontend, doing: "typing", mood: { valence: 0.2, arousal: 0.1, label: "focused" } },
    { agent: qa, doing: "reading the diff", mood: { valence: -0.1, arousal: 0, label: "sceptical" } },
  ],
  body: { energy: 62, caffeine: 18, social: 71, stress: 33 },
};

function engineWith(respond: MindEngineOptions["provider"]): MindEngine {
  return new MindEngine({
    provider: respond,
    settings: () => ({ ...DEFAULT_MIND, maxTurns: 4 }) as MindSettings,
  });
}

describe("mind JSON parsing", () => {
  it("accepts a bare object", () => {
    expect(parseJson('{"say":"hi"}')).toEqual({ say: "hi" });
  });

  it("survives a markdown fence and surrounding prose", () => {
    expect(parseJson('Sure.\n```json\n{"say":"hi"}\n```\nDone.')).toEqual({ say: "hi" });
  });

  it("returns null instead of throwing on nonsense", () => {
    expect(parseJson("I would rather not")).toBeNull();
    expect(parseJson("{broken")).toBeNull();
  });
});

describe("decisions come from the model", () => {
  it("parses a decision out of the model's text", async () => {
    const engine = engineWith(() => ({
      name: "fake",
      complete: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              thought: "I need coffee before I read that diff.",
              action: "coffee",
              place: "coffee",
              say: "Coffee first.",
              seconds: 20,
              mood: { valence: 0.1, arousal: 0.2, label: "restless" },
            }),
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    }));
    const decision = await engine.decide(backend, freshState(), context);
    expect(decision.action).toBe("coffee");
    expect(decision.place).toBe("coffee");
    expect(decision.mood).toMatchObject({ label: "restless" });
  });

  it("fills defaults for a partial answer instead of failing the tick", async () => {
    const engine = engineWith(() => ({
      name: "fake",
      complete: async () => ({
        content: [{ type: "text", text: '{"say":"hm"}' }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }));
    const decision = await engine.decide(backend, freshState(), context);
    expect(decision.action).toBe("sit");
    expect(decision.say).toBe("hm");
  });

  it("throws a clear error when the model answers with prose", async () => {
    const engine = engineWith(() => ({
      name: "fake",
      complete: async () => ({
        content: [{ type: "text", text: "I think I'll get coffee." }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }));
    await expect(engine.decide(backend, freshState(), context)).rejects.toThrow(/not JSON/);
  });

  it("puts the real goal, colleagues and feelings in the prompt", async () => {
    let prompt = "";
    const engine = engineWith(() => ({
      name: "fake",
      complete: async (request) => {
        prompt = request.messages.flatMap((message) =>
          message.content.map((block) => (block.type === "text" ? block.text : "")),
        ).join("");
        return {
          content: [{ type: "text", text: '{"action":"sit"}' }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }));
    const state = freshState();
    state.relationships.frontend = { sentiment: 0.4, note: "ships fast, breaks things", talks: 2 };
    await engine.decide(backend, state, context);
    expect(prompt).toContain("Ship a todo app");
    expect(prompt).toContain("apps/server/src/todo.ts");
    expect(prompt).toContain("Fiona");
    expect(prompt).toContain("ships fast, breaks things");
    expect(prompt).toContain("caffeine 18/100");
  });
});

describe("mock minds keep demo mode alive", () => {
  it("answers a decision prompt with a parseable action", async () => {
    const engine = engineWith(() => new MockProvider());
    const decision = await engine.decide(backend, freshState(), context);
    expect(typeof decision.action).toBe("string");
    expect(decision.action.length).toBeGreaterThan(0);
    expect(decision.mood?.label).toBeTruthy();
  });

  it("answers a conversation prompt with a real line", async () => {
    const engine = engineWith(() => new MockProvider());
    const turn = await engine.turn(
      frontend,
      freshState(),
      context,
      backend,
      [{ speaker: "backend", text: "The endpoint is live." }],
      false,
    );
    expect(turn.say.length).toBeGreaterThan(3);
  });
});

describe("the runner keeps consequences, not a script", () => {
  function runner(engine: MindEngine, settings: Partial<MindSettings> = {}) {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const instance = new MindRunner({
      agents: () => [backend, frontend, qa],
      engine,
      settings: () => ({ ...DEFAULT_MIND, ...settings }),
      context: () => ({ goal: "Ship a todo app", tasks: [], files: [] }),
      company: () => "Corpix",
      emit: (type, payload) => events.push({ type, payload }),
      sleep: async () => undefined,
      now: () => 1_000_000,
    });
    return { runner: instance, events };
  }

  function fakeEngine(options: {
    decision?: Partial<Awaited<ReturnType<MindEngine["decide"]>>>;
    turn?: (agent: MindAgent, index: number) => string;
  }): MindEngine {
    return {
      decide: async () => ({
        thought: "I want coffee.",
        action: "coffee",
        place: "coffee",
        label: "getting coffee",
        seconds: 20,
        mood: { valence: 0.3, arousal: 0.1, label: "restless" },
        ...options.decision,
      }),
      turn: async (agent: MindAgent, _state: MindState, _ctx: unknown, _other: unknown, transcript: Array<{ text: string }>) =>
        ({
          thought: "Hm.",
          say: options.turn ? options.turn(agent, transcript.length) : `${agent.name} replies ${transcript.length}`,
          mood: { valence: 0.1, arousal: 0, label: "amused" },
        }),
    } as unknown as MindEngine;
  }

  it("emits what the agent decided and remembers it", () => {
    const { runner: loop, events } = runner(fakeEngine({}));
    loop.tick();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const decided = events.find((event) => event.type === "mind.decided");
        expect(decided?.payload.action).toBe("coffee");
        expect(decided?.payload.say).toBeUndefined();
        const mind = loop.minds().find((entry) => entry.agentId === "backend");
        expect(mind?.mood.label).toBe("restless");
        expect(mind?.doing).toBe("getting coffee");
        resolve();
      }, 10);
    });
  });

  it("runs a two-sided conversation where the reply answers the previous line", async () => {
    const { runner: loop, events } = runner(
      fakeEngine({
        decision: { action: "talk", target: "backend", say: "Do you have a minute?" },
        turn: (_agent, index) => (index === 0 ? "Sure, what is it?" : `Reply number ${index}`),
      }),
      { maxTurns: 4 },
    );
    loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = events.find((event) => event.type === "mind.conversation.started");
    const lines = events.filter((event) => event.type === "mind.conversation.line");
    const ended = events.find((event) => event.type === "mind.conversation.ended");
    expect(started).toBeTruthy();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Speakers alternate, so the other side really answers.
    expect(lines[0]?.payload.agentId).not.toBe(lines[1]?.payload.agentId);
    expect(ended).toBeTruthy();
  });

  it("gives the operator a real answer and updates the opinion", async () => {
    const { runner: loop } = runner(fakeEngine({ turn: (agent) => `${agent.name} is annoyed` }));
    loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = await loop.speakTo("qa", "Why is the build red?");
    expect(reply?.say).toContain("annoyed");
    const mind = loop.minds().find((entry) => entry.agentId === "qa");
    expect(mind?.relationships.operator?.talks).toBe(1);
  });

  it("stops thinking when the mind is disabled", () => {
    const { runner: loop, events } = runner(fakeEngine({}), { enabled: false });
    loop.tick();
    expect(events).toHaveLength(0);
  });

  it("does not write the same memory twice in a row", async () => {
    const { runner: loop } = runner(
      fakeEngine({ decision: { remember: "Pressed QA again for the raw 14:07 line." } }),
      { memorySize: 8 },
    );
    loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mind = loop.minds().find((entry) => entry.agentId === "backend");
    expect(mind?.memories.length).toBe(1);
  });

  it("keeps a bounded memory per agent", async () => {
    const { runner: loop } = runner(
      fakeEngine({ decision: { remember: "I moved my chair." } }),
      { memorySize: 2 },
    );
    loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    loop.minds();
    loop.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mind = loop.minds().find((entry) => entry.agentId === "backend");
    expect((mind?.memories.length ?? 0) <= 2).toBe(true);
  });
});

describe("agent language", () => {
  it("tells an Indonesian office to speak Indonesian even with English tasks", () => {
    const rule = languageRule("id");
    expect(rule).toContain("Bahasa Indonesia");
    expect(rule).toContain("even if the task text");
    expect(rule).toContain("code, paths and identifiers");
  });

  it("can force English", () => {
    expect(languageRule("en")).toBe("Speak English.");
  });

  it("otherwise follows the room", () => {
    expect(languageRule("auto")).toMatch(/match the office/);
  });

  it("puts the rule in both decision and conversation prompts", async () => {
    const prompts: string[] = [];
    const engine = new MindEngine({
      provider: () => ({
        name: "fake",
        complete: async (request) => {
          prompts.push(
            request.messages
              .flatMap((message) => message.content)
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
          );
          return {
            content: [{ type: "text", text: '{"say":"halo","action":"sit"}' }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
      settings: () => ({ ...DEFAULT_MIND, language: "id" }) as MindSettings,
      language: () => "id",
    });
    await engine.decide(backend, freshState(), context);
    await engine.turn(frontend, freshState(), context, backend, [], true);
    expect(prompts.length).toBe(2);
    for (const prompt of prompts) expect(prompt).toContain("Bahasa Indonesia");
  });
});
