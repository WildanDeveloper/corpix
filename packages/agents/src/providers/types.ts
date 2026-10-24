import type {
  ContentBlock,
  Message,
  StopReason,
  ToolSchema,
  Usage,
} from "@corpix/shared";

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  /** Force one tool; used for `submit_plan`. Not every server honours it. */
  toolChoice?: { name: string };
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

/** The one small contract every provider implements. */
export interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export type ProviderFactory = () => LLMProvider;
