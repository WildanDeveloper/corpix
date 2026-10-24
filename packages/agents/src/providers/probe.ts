import type { RuntimeSettings } from "@corpix/shared";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { createProviderFromSettings } from "./index";

export interface ProviderProbe {
  ok: boolean;
  detail: string;
  models: string[];
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
