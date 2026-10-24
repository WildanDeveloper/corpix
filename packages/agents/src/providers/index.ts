import type { Env, RuntimeSettings } from "@corpix/shared";
import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProvider } from "./types";

/** Build the provider named by the resolved settings. */
export function createProvider(env: Env): LLMProvider {
  if (env.LLM_PROVIDER === "mock") return new MockProvider();
  return new OpenAICompatibleProvider({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    maxTokensParam: env.LLM_MAX_TOKENS_PARAM,
  });
}

/**
 * Provider built from runtime settings, so the web UI can switch providers
 * without a restart. Never log the key.
 */
export function createProviderFromSettings(runtime: RuntimeSettings): LLMProvider {
  const { provider } = runtime.settings;
  if (provider.name === "mock") return new MockProvider();
  return new OpenAICompatibleProvider({
    baseUrl: provider.baseUrl,
    apiKey: runtime.apiKey,
    maxTokensParam: provider.maxTokensParam,
    toolChoiceStyle: provider.toolChoiceStyle,
    promptCaching: provider.promptCaching,
    timeoutMs: provider.requestTimeoutMs,
  });
}
