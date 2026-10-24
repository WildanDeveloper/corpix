import { describe, expect, it } from "vitest";
import { ContextManager, LoopDetector } from "@corpix/agents";
import type { Message } from "@corpix/shared";

describe("LoopDetector", () => {
  it("nudges at the third identical call and fails at the fifth", () => {
    const detector = new LoopDetector();
    const call = [{ name: "run_command", input: { command: "node", args: ["x"] } }];
    expect(detector.observe(call)).toBe("ok");
    expect(detector.observe(call)).toBe("ok");
    expect(detector.observe(call)).toBe("nudge");
    expect(detector.observe(call)).toBe("nudge");
    expect(detector.observe(call)).toBe("fail");
  });

  it("nudges on a streak of different failing commands", () => {
    const detector = new LoopDetector();
    expect(detector.observeResults([{ isError: true }])).toBe("ok");
    expect(detector.observeResults([{ isError: true }])).toBe("ok");
    expect(detector.observeResults([{ isError: true }])).toBe("nudge");
    // A success resets the streak.
    expect(detector.observeResults([{ isError: false }])).toBe("ok");
    expect(detector.observeResults([{ isError: true }])).toBe("ok");
  });

  it("gives up after a long failure streak", () => {
    const detector = new LoopDetector();
    let last = "ok";
    for (let i = 0; i < 8; i++) last = detector.observeResults([{ isError: true }]);
    expect(last).toBe("fail");
  });
});

describe("ContextManager", () => {
  it("returns the full conversation when it fits", async () => {
    const manager = new ContextManager({ maxTokens: 10_000 });
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    expect(await manager.compact(messages)).toEqual(messages);
  });

  it("keeps the first turn and recent turns when compacting", async () => {
    const manager = new ContextManager({ maxTokens: 50, keepRecent: 2 });
    const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: [{ type: "text" as const, text: "x".repeat(120) }],
    }));
    const compacted = await manager.compact(messages);
    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[0]).toBe(messages[0]);
    expect(compacted.at(-1)).toBe(messages.at(-1));
    expect(
      compacted.some(
        (message) =>
          message.content[0]?.type === "text" && message.content[0].text.includes("older turns"),
      ),
    ).toBe(true);
  });
});
