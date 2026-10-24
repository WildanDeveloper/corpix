import {
  estimateContentTokens,
  type ContentBlock,
  type Message,
  type ToolResultBlock,
} from "@corpix/shared";

export interface ContextManagerOptions {
  /** Estimated token budget before compaction kicks in. */
  maxTokens?: number;
  /** Turns always kept verbatim, including the first user message. */
  keepRecent?: number;
  /** Cheap summariser; when absent, old turns are dropped with a marker. */
  summarise?: (text: string) => Promise<string>;
}

/**
 * Keeps the stable prefix (system prompt, tool schemas, task brief) first and
 * drops or summarises old turns. Tool output is already truncated upstream.
 */
export class ContextManager {
  private readonly maxTokens: number;
  private readonly keepRecent: number;
  private summary = "";
  private readonly summarise?: (text: string) => Promise<string>;

  constructor(options: ContextManagerOptions = {}) {
    this.maxTokens = options.maxTokens ?? 24_000;
    this.keepRecent = options.keepRecent ?? 6;
    this.summarise = options.summarise;
  }

  estimate(messages: readonly Message[]): number {
    return messages.reduce(
      (sum, message) => sum + estimateContentTokens(message.content),
      0,
    );
  }

  /** Returns a compacted view of the conversation; never mutates the input. */
  async compact(messages: readonly Message[]): Promise<Message[]> {
    const total = this.estimate(messages);
    if (total <= this.maxTokens) return [...messages];

    const first = messages[0];
    const recent = messages.slice(-this.keepRecent);
    const middle = messages.slice(1, Math.max(messages.length - this.keepRecent, 1));

    const middleText = middle
      .flatMap((message) => message.content)
      .map((block) => describeBlock(block))
      .filter((text) => text.length > 0)
      .join("\n");

    if (this.summarise && middleText.length > 0) {
      const addition = await this.summarise(middleText.slice(0, 20_000)).catch(() => "");
      if (addition.trim().length > 0) {
        this.summary = `${this.summary}\n${addition.trim()}`.trim();
      }
    }

    const progress: Message | null = this.summary
      ? {
          role: "user",
          content: [
            {
              type: "text",
              text: `Progress so far (summarised):\n${this.summary}`,
            },
          ],
        }
      : {
          role: "user",
          content: [
            {
              type: "text",
              text: `[${middle.length} older turns were dropped to save context. Continue from the most recent results.]`,
            },
          ],
        };

    return first ? [first, progress, ...recent] : [progress, ...recent];
  }
}

function describeBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text.slice(0, 600);
    case "tool_call":
      return `called ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`;
    case "tool_result":
      return `${block.name} -> ${block.content.slice(0, 400)}`;
    default:
      return "";
  }
}

/** Detect the same call repeated too often, see "Loop detection". */
export class LoopDetector {
  private readonly seen = new Map<string, number>();
  constructor(private readonly failAt = 5) {}

  /** Returns a nudge message at 3 repeats, or "fail" at the threshold. */
  observe(calls: readonly { name: string; input: unknown }[]): "ok" | "nudge" | "fail" {
    let result: "ok" | "nudge" | "fail" = "ok";
    for (const call of calls) {
      const key = `${call.name}:${JSON.stringify(call.input)}`;
      const count = (this.seen.get(key) ?? 0) + 1;
      this.seen.set(key, count);
      if (count >= this.failAt) return "fail";
      if (count >= 3) result = "nudge";
    }
    return result;
  }

  reset(): void {
    this.seen.clear();
  }
}

export function isSubmitReport(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result" && block.name === "submit_report" && !block.isError;
}
