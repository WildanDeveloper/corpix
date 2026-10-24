import { z } from "zod";

/** Normalised content blocks, independent of any provider wire format. */
export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string(),
  name: z.string(),
  content: z.string(),
  isError: z.boolean().default(false),
});

export const ContentBlockSchema = z.union([
  TextBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
]);

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(ContentBlockSchema),
});
export type Message = z.infer<typeof MessageSchema>;

export function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

export function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function toolCallsOf(content: readonly ContentBlock[]): ToolCallBlock[] {
  return content.filter((b): b is ToolCallBlock => b.type === "tool_call");
}

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ToolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  jsonSchema: z.record(z.string(), z.unknown()),
});
export type ToolSchema = z.infer<typeof ToolSchemaSchema>;

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";
