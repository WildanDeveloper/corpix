import { describe, expect, it } from "vitest";
import {
  mapFinishReason,
  parseArguments,
  toChatMessages,
  OpenAICompatibleProvider,
} from "@corpix/agents";
import type { Message } from "@corpix/shared";

describe("parseArguments", () => {
  it("parses valid JSON", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("treats empty arguments as an empty object", () => {
    expect(parseArguments(undefined)).toEqual({});
    expect(parseArguments("   ")).toEqual({});
  });

  it("repairs fenced JSON", () => {
    expect(parseArguments('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it("repairs JSON wrapped in prose", () => {
    expect(parseArguments('Sure! {"a":3} hope that helps')).toEqual({ a: 3 });
  });

  it("flags unrecoverable input instead of throwing", () => {
    expect(parseArguments("{not json")).toEqual({ __malformed: "{not json" });
  });
});

describe("mapFinishReason", () => {
  it("maps tool calls and length", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
    expect(mapFinishReason("length")).toBe("max_tokens");
    expect(mapFinishReason("stop")).toBe("end_turn");
    expect(mapFinishReason(undefined)).toBe("other");
  });
});

describe("toChatMessages", () => {
  it("converts tool results into role tool messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "c1",
            name: "read_file",
            content: "contents",
            isError: false,
          },
        ],
      },
    ];
    const out = toChatMessages("system", messages);
    expect(out[0]).toEqual({ role: "system", content: "system" });
    expect(out[1]?.tool_calls?.[0]?.function.name).toBe("read_file");
    expect(out[1]?.tool_calls?.[0]?.function.arguments).toBe('{"path":"a.ts"}');
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "contents" });
  });

  it("prefixes error results so the model sees them", () => {
    const out = toChatMessages("s", [
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c1", name: "x", content: "boom", isError: true },
        ],
      },
    ]);
    expect(out[1]?.content).toBe("ERROR: boom");
  });
});

describe("OpenAICompatibleProvider", () => {
  it("maps a chat completion response into content blocks", async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "hello",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      fetch: fetchMock,
    });
    const response = await provider.complete({
      model: "m",
      system: "s",
      messages: [],
      tools: [],
      maxTokens: 100,
    });

    expect(response.content).toHaveLength(2);
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 });
  });

  it("sends max_completion_tokens when configured", async () => {
    let captured: Record<string, unknown> = {};
    const fetchMock = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1/v1",
      maxTokensParam: "max_completion_tokens",
      fetch: fetchMock,
    });
    await provider.complete({ model: "m", system: "s", messages: [], tools: [], maxTokens: 42 });
    expect(captured.max_completion_tokens).toBe(42);
    expect(captured.max_tokens).toBeUndefined();
  });

  it("throws a ProviderError with the status code", async () => {
    const fetchMock = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://x/v1", fetch: fetchMock });
    await expect(
      provider.complete({ model: "m", system: "s", messages: [], tools: [], maxTokens: 1 }),
    ).rejects.toThrow(/401/);
  });
});
