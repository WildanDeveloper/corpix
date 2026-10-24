/** Truncate tool output, keeping a marker the model can see. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

/** Cheap token estimate, used only for compaction decisions and tests. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateContentTokens(content: readonly { type: string }[]): number {
  return content.reduce((sum, block) => {
    const text = "text" in block && typeof block.text === "string" ? block.text : "";
    const body = "content" in block && typeof block.content === "string" ? block.content : "";
    return sum + estimateTokens(text || body) + 4;
  }, 0);
}

export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split("\n");
  const start = Math.max((startLine ?? 1) - 1, 0);
  const end = Math.min(endLine ?? lines.length, lines.length);
  return lines.slice(start, end).join("\n");
}

/** Normalise a path to forward slashes for glob matching. */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
