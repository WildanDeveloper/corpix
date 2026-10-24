import {
  ProviderError,
  type ContentBlock,
  type Message,
  type StopReason,
  type ToolCallBlock,
} from "@corpix/shared";
import type { CompletionRequest, CompletionResponse, LLMProvider } from "./types";

export type ToolChoiceStyle = "auto" | "object" | "name" | "required" | "none";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /**
   * How to send a forced tool. `auto` tries the standard object, then the
   * function-name string, then "required", then no tool_choice at all, and
   * remembers what worked. Some OpenAI-compatible servers reject the object
   * form with a 400.
   */
  toolChoiceStyle?: ToolChoiceStyle;
  /** `auto` leaves caching to the provider; `anthropic` adds cache_control. */
  promptCaching?: "off" | "auto" | "anthropic";
  /** Per-request timeout; the caller's AbortSignal still wins. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Thin OpenAI-compatible adapter. Implemented with fetch so any endpoint that
 * speaks `/chat/completions` works, including local servers that dislike the
 * SDK's extra headers.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxTokensParam: "max_tokens" | "max_completion_tokens";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestedStyle: ToolChoiceStyle;
  private learnedStyle: Exclude<ToolChoiceStyle, "auto"> | null = null;
  private readonly promptCaching: "off" | "auto" | "anthropic";

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey && options.apiKey.length > 0 ? options.apiKey : "local";
    this.maxTokensParam = options.maxTokensParam ?? "max_tokens";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.requestedStyle = options.toolChoiceStyle ?? "auto";
    this.promptCaching = options.promptCaching ?? "auto";
  }

  /** Styles to try, in order. A learned style goes first. */
  private stylesToTry(): Exclude<ToolChoiceStyle, "auto">[] {
    if (this.requestedStyle !== "auto") return [this.requestedStyle];
    const all: Exclude<ToolChoiceStyle, "auto">[] = ["object", "name", "required", "none"];
    return this.learnedStyle
      ? [this.learnedStyle, ...all.filter((style) => style !== this.learnedStyle)]
      : all;
  }

  private toolChoiceFor(style: Exclude<ToolChoiceStyle, "auto">, name: string): unknown {
    switch (style) {
      case "object":
        return { type: "function", function: { name } };
      case "name":
        return name;
      case "required":
        return "required";
      case "none":
        return undefined;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toChatMessages(request.system, request.messages),
      tools: request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.jsonSchema,
        },
      })),
      [this.maxTokensParam]: request.maxTokens,
    };
    if (request.tools.length === 0) delete body.tools;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (this.promptCaching !== "off") {
      // Fold the system prompt into the first user turn so gateways that only
      // cache leading user messages still get a stable, cacheable prefix.
      body.messages = foldSystemIntoFirstUser(body.messages as ChatMessage[]);
    }
    if (this.promptCaching === "anthropic") {
      applyAnthropicCacheHints(body, request);
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    const styles: Array<Exclude<ToolChoiceStyle, "auto"> | null> = request.toolChoice
      ? this.stylesToTry()
      : [null];

    let lastError: ProviderError | null = null;
    for (const style of styles) {
      const attemptBody = { ...body };
      if (style !== null && request.toolChoice) {
        const choice = this.toolChoiceFor(style, request.toolChoice.name);
        if (choice === undefined) delete attemptBody.tool_choice;
        else attemptBody.tool_choice = choice;
      }

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(attemptBody),
          signal,
        });
      } catch (error) {
        const aborted =
          (error as Error).name === "TimeoutError" || (error as Error).name === "AbortError";
        throw new ProviderError(
          aborted
            ? `Provider request timed out after ${this.timeoutMs}ms`
            : `Network error calling provider: ${(error as Error).message}`,
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new ProviderError(
          `Provider returned ${response.status}: ${text.slice(0, 500)}`,
          response.status,
        );
        lastError = error;
        // Some OpenAI-compatible servers reject the object form of tool_choice.
        // Retry with the next style only when the error clearly points at it.
        const aboutToolChoice = /tool[_ ]?choice/i.test(text);
        if (style !== null && aboutToolChoice) {
          if (this.requestedStyle === "auto") this.learnedStyle = null;
          continue;
        }
        // A wrong model id is a configuration mistake, so say which model and
        // point at the settings instead of surfacing a raw provider blob.
        if (response.status === 404 || /model .*not found|unknown model|invalid model/i.test(text)) {
          throw new ProviderError(
            `The provider does not know the model "${request.model}". ` +
              `Pick one from GET /api/models (Settings → Models) and try again. ` +
              `Provider said: ${text.slice(0, 200)}`,
            response.status,
          );
        }
        throw error;
      }

      if (style !== null && this.requestedStyle === "auto") {
        this.learnedStyle = style;
      }
      return this.parseResponse((await response.json()) as ChatCompletionResponse);
    }

    throw lastError ?? new ProviderError("Provider request failed");
  }

  private parseResponse(data: ChatCompletionResponse): CompletionResponse {
    const choice = data.choices?.[0];
    if (!choice) throw new ProviderError("Provider returned no choices");

    const content: ContentBlock[] = [];
    const text = choice.message?.content;
    if (typeof text === "string" && text.length > 0) {
      content.push({ type: "text", text });
    }
    for (const call of choice.message?.tool_calls ?? []) {
      if (!call.function?.name) continue;
      content.push({
        type: "tool_call",
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      } satisfies ToolCallBlock);
    }

    return {
      content,
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens,
      },
    };
  }

  /** Fetch the model ids exposed by the server, for the settings dropdown. */
  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    }).catch((error: Error) => {
      throw new ProviderError(`Could not list models: ${error.message}`);
    });
    if (!response.ok) {
      throw new ProviderError(`Provider returned ${response.status} for /models`, response.status);
    }
    const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (data.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
}

/**
 * Anthropic-compatible endpoints cache a prefix marked with `cache_control`.
 * We mark the system prompt and the last tool, which covers the stable prefix
 * (instructions + tool schemas) that every loop turn repeats.
 *
 * Some gateways also ignore `system` messages for caching and only cache the
 * leading `user` block, so `toChatMessages` puts the system prompt there when
 * caching is enabled (see `foldSystemIntoFirstUser`).
 */
export function applyAnthropicCacheHints(
  body: Record<string, unknown>,
  request: CompletionRequest,
): void {
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  const systemIndex = messages?.findIndex((message) => message.role === "system") ?? -1;
  const systemMessage = systemIndex >= 0 ? messages?.[systemIndex] : undefined;
  if (systemMessage && typeof systemMessage.content === "string") {
    systemMessage.content = [
      {
        type: "text",
        text: systemMessage.content,
        cache_control: { type: "ephemeral" },
      },
    ];
  } else if (messages && messages.length > 0) {
    // No system message: mark the first user message, which is the stable
    // prefix when the system prompt was folded into it.
    const first = messages[0];
    if (first && typeof first.content === "string") {
      first.content = [
        { type: "text", text: first.content, cache_control: { type: "ephemeral" } },
      ];
    }
  }

  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (tools && tools.length > 0) {
    const last = tools[tools.length - 1] as Record<string, unknown>;
    last.cache_control = { type: "ephemeral" };
  }

  void request;
}

/**
 * Some OpenAI-compatible gateways only apply prefix caching to the leading
 * `user` message and ignore `system` entirely. Folding the system prompt into the
 * first user message keeps the cacheable prefix byte-identical across loop turns.
 */
export function foldSystemIntoFirstUser(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const [first, ...rest] = messages;
  if (!first || first.role !== "system") return messages;
  const systemText = typeof first.content === "string" ? first.content : "";
  const next = rest[0];
  if (!next || next.role !== "user") return messages;
  const userText = typeof next.content === "string" ? next.content : "";
  return [
    { role: "user", content: `${systemText}\n\n${userText}` },
    ...rest.slice(1),
  ];
}

export function toChatMessages(system: string, messages: readonly Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const calls = message.content.filter((block) => block.type === "tool_call");
      out.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input ?? {}),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    const results = message.content.filter((block) => block.type === "tool_result");
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text.length > 0) out.push({ role: "user", content: text });
    for (const result of results) {
      out.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.isError ? `ERROR: ${result.content}` : result.content,
      });
    }
  }
  return out;
}

export function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    case "end_turn":
      return "end_turn";
    case null:
    case undefined:
      return "other";
    default:
      return "other";
  }
}

/**
 * Tool arguments arrive as a JSON string and are often broken. Try the common
 * repairs before giving up; the runtime reports malformed input to the model.
 */
export function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === "") return {};
  const attempts: string[] = [raw];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(raw.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next repair
    }
  }
  return { __malformed: raw };
}
