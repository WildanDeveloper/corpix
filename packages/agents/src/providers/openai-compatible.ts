import {
  ProviderError,
  type ContentBlock,
  type Message,
  type StopReason,
  type ToolCallBlock,
} from "@corpix/shared";
import type { CompletionRequest, CompletionResponse, LLMProvider } from "./types";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
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

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey && options.apiKey.length > 0 ? options.apiKey : "local";
    this.maxTokensParam = options.maxTokensParam ?? "max_tokens";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {    const body: Record<string, unknown> = {
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
    if (request.toolChoice) {
      body.tool_choice = {
        type: "function",
        function: { name: request.toolChoice.name },
      };
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;

    let response: Response;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const aborted = (error as Error).name === "TimeoutError" || (error as Error).name === "AbortError";
      throw new ProviderError(
        aborted
          ? `Provider request timed out after ${this.timeoutMs}ms`
          : `Network error calling provider: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `Provider returned ${response.status}: ${text.slice(0, 500)}`,
        response.status,
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
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
