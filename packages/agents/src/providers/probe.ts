import type { RuntimeSettings } from "@corpix/shared";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { createProviderFromSettings } from "./index";

export interface ProviderProbe {
  ok: boolean;
  detail: string;
  models: string[];
}

/** Model ids for the settings dropdown, without spending tokens. */
export async function listModels(
  runtime: RuntimeSettings,
): Promise<{ models: string[]; ok: boolean; detail?: string }> {
  if (runtime.settings.provider.name === "mock") {
    return { models: ["mock-boss", "mock-worker", "mock-cheap"], ok: true };
  }
  const provider = new OpenAICompatibleProvider({
    baseUrl: runtime.settings.provider.baseUrl,
    apiKey: runtime.apiKey,
    maxTokensParam: runtime.settings.provider.maxTokensParam,
    timeoutMs: runtime.settings.provider.requestTimeoutMs,
  });
  try {
    const models = await provider.listModels();
    return { models, ok: true };
  } catch (error) {
    return { models: [], ok: false, detail: (error as Error).message };
  }
}

/**
 * One cheap round trip used by the settings page's "Test connection" button.
 * Mock mode succeeds without touching the network.
 */
export async function probeProvider(
  runtime: RuntimeSettings,
  model: string,
): Promise<ProviderProbe> {
  const provider = createProviderFromSettings(runtime);
  const models =
    provider instanceof OpenAICompatibleProvider
      ? await provider.listModels().catch(() => [])
      : ["mock-boss", "mock-worker", "mock-cheap"];
  try {
    const response = await provider.complete({
      model,
      system: "Health check. Reply with the single word OK.",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      tools: [],
      maxTokens: 8,
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();
    return { ok: true, detail: text.slice(0, 120) || "Provider responded", models };
  } catch (error) {
    return { ok: false, detail: (error as Error).message, models };
  }
}
