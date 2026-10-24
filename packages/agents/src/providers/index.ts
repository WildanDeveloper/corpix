import type { Env } from "@corpix/shared";
import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProvider } from "./types";

/** Build the provider named by `LLM_PROVIDER`. */
export function createProvider(env: Env): LLMProvider {
  if (env.LLM_PROVIDER === "mock") return new MockProvider();
  return new OpenAICompatibleProvider({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    maxTokensParam: env.LLM_MAX_TOKENS_PARAM,
  });
}
