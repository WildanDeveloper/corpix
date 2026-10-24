import { describe, expect, it } from "vitest";
import {
  buildConversation,
  conversationCooldown,
  lineDuration,
  pickTopic,
} from "../apps/web/src/office/conversation";
import { SpeechQueue } from "../apps/web/src/office/speech";

const backend = { id: "backend_1", role: "backend", name: "Bruno" };
const frontend = { id: "frontend_1", role: "frontend", name: "Fiona" };
const qa = { id: "qa_1", role: "qa", name: "Quinn" };
const docs = { id: "docs_1", role: "docs", name: "Dana" };
const devops = { id: "devops_1", role: "devops", name: "Dev" };
const boss = { id: "boss_1", role: "boss", name: "Ada" };

describe("topic selection", () => {
  it("picks a topic that fits the roles present", () => {
    expect(pickTopic(["qa", "backend"])).toBe("tests");
    expect(pickTopic(["devops", "backend"])).toBe("deploy");
    expect(pickTopic(["docs", "backend"])).toBe("docs");
    expect(pickTopic(["boss", "frontend"])).toBe("planning");
    expect(pickTopic(["frontend", "backend"])).toBe("api");
    expect(pickTopic(["frontend", "docs"])).toBe("docs");
    expect(pickTopic(["frontend"])).toBe("design");
    expect(pickTopic(["backend"])).toBe("debug");
    expect(pickTopic(["qa"])).toBe("review");
  });
});

describe("conversation scripts", () => {
  it("never has the same speaker twice in a row", () => {
    for (let seed = 0; seed < 40; seed++) {
      const script = buildConversation([backend, frontend, qa], {}, seed);
      let previous: string | null = null;
      for (const line of script.lines) {
        expect(line.speakerId).not.toBe(previous);
        previous = line.speakerId;
      }
    }
  });

  it("only uses participants as speakers", () => {
    const script = buildConversation([backend, qa], {}, 3);
    const ids = new Set([backend.id, qa.id]);
    for (const line of script.lines) expect(ids.has(line.speakerId)).toBe(true);
  });

  it("references the real goal, task and file", () => {
    const script = buildConversation([frontend, backend], {
      goal: "Build a todo app with login",
      tasks: ["Create the API entry point"],
      files: ["apps/server/src/todo.ts"],
    }, 1);
    const text = script.lines.map((line) => line.text).join(" ");
    expect(text).toMatch(/todo\.ts|Create the API entry point|todo app/);
  });

  it("returns nothing for a single participant", () => {
    expect(buildConversation([backend], {}, 0).lines).toEqual([]);
    expect(buildConversation([], {}, 0).lines).toEqual([]);
  });

  it("gives each line a speaker name for the bubble", () => {
    const script = buildConversation([backend, qa], {}, 2);
    for (const line of script.lines) {
      expect([backend.name, qa.name]).toContain(line.speakerName);
    }
  });

  it("produces multi-line exchanges, not one-liners", () => {
    for (const pair of [
      [backend, qa],
      [frontend, backend],
      [devops, backend],
      [docs, backend],
      [boss, backend],
    ] as const) {
      expect(buildConversation([...pair], {}, 0).lines.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("scales the reading time with the text length", () => {
    expect(lineDuration("hi")).toBeLessThan(lineDuration("a much longer sentence that needs time"));
    expect(lineDuration("x".repeat(400))).toBeLessThanOrEqual(6.5);
    expect(lineDuration("")).toBeGreaterThanOrEqual(2.6);
  });

  it("keeps the cooldown short enough to feel alive", () => {
    for (let seed = 0; seed < 20; seed++) {
      const cooldown = conversationCooldown(seed);
      expect(cooldown).toBeGreaterThanOrEqual(9);
      expect(cooldown).toBeLessThanOrEqual(15);
    }
  });
});

describe("speech queue", () => {
  it("lets exactly one agent speak at a time", () => {
    const queue = new SpeechQueue(0.5);
    queue.enqueue({ agentId: "a", text: "one", priority: 10, duration: 2 });
    queue.enqueue({ agentId: "b", text: "two", priority: 10, duration: 2 });
    queue.enqueue({ agentId: "c", text: "three", priority: 10, duration: 2 });

    const first = queue.tick(0.1);
    expect(first?.agentId).toBe("a");
    // Nothing else may appear until the first bubble is done.
    expect(queue.tick(0.5)).toBeNull();
    expect(queue.tick(1.0)).toBeNull();
    const second = queue.tick(1.0);
    expect(second?.agentId).toBe("b");
    expect(queue.pending).toBe(1);
  });

  it("serves higher priority first", () => {
    const queue = new SpeechQueue(0);
    queue.enqueue({ agentId: "low", text: "x", priority: 1, duration: 1 });
    queue.enqueue({ agentId: "high", text: "y", priority: 99, duration: 1 });
    expect(queue.tick(0.1)?.agentId).toBe("high");
  });

  it("replaces a queued line from the same agent", () => {
    const queue = new SpeechQueue(0);
    queue.enqueue({ agentId: "a", text: "first", priority: 5, duration: 1 });
    queue.enqueue({ agentId: "a", text: "second", priority: 5, duration: 1 });
    expect(queue.pending).toBe(1);
    expect(queue.tick(0.1)?.text).toBe("second");
  });

  it("drops stale lines", () => {
    const queue = new SpeechQueue(0);
    queue.enqueue({ agentId: "a", text: "gone", priority: 5, duration: 1, tag: "conversation" });
    queue.dropStale(() => false);
    expect(queue.pending).toBe(0);
    expect(queue.tick(0.1)).toBeNull();
  });

  it("ignores empty text", () => {
    const queue = new SpeechQueue(0);
    queue.enqueue({ agentId: "a", text: "   ", priority: 1, duration: 1 });
    expect(queue.pending).toBe(0);
  });

  it("clears everything on reset", () => {
    const queue = new SpeechQueue(0);
    queue.enqueue({ agentId: "a", text: "x", priority: 1, duration: 1 });
    queue.clear();
    expect(queue.pending).toBe(0);
    expect(queue.current).toBeNull();
  });
});
