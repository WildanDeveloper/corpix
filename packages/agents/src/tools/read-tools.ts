import { promises as fs } from "node:fs";
import path from "node:path";
import { truncate } from "@corpix/shared";
import { z } from "zod";
import type { ToolDefinition } from "./types";

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "List a directory inside the workspace. Returns names, with a trailing / for directories.",
  risk: "safe",
  inputSchema: z.object({
    path: z.string().default("."),
    depth: z.number().int().min(1).max(3).default(1),
  }),
  async run(input, ctx) {
    const { path: rel, depth } = input as { path: string; depth: number };
    const root = await ctx.jail.resolveReal(rel);
    const lines: string[] = [];

    const walk = async (dir: string, level: number): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const childRel = ctx.jail.relative(path.join(dir, entry.name));
        if (entry.isDirectory()) {
          lines.push(`${childRel}/`);
          if (level < depth) await walk(path.join(dir, entry.name), level + 1);
        } else {
          lines.push(childRel);
        }
      }
    };

    await walk(root, 1);
    if (lines.length === 0) return `${rel} is empty`;
    return truncate(lines.join("\n"), ctx.limits.toolOutputMaxChars);
  },
};

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the workspace. Use startLine/endLine for large files.",
  risk: "safe",
  inputSchema: z.object({
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  async run(input, ctx) {
    const { path: rel, startLine, endLine } = input as {
      path: string;
      startLine?: number;
      endLine?: number;
    };
    const abs = await ctx.jail.resolveReal(rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return `ERROR: file not found: ${rel}`;
    if (stat.isDirectory()) return `ERROR: ${rel} is a directory, use list_files`;
    if (stat.size > 2_000_000) return `ERROR: ${rel} is larger than 2MB, use startLine/endLine`;
    const text = await fs.readFile(abs, "utf8");
    const sliced = slice(text, startLine, endLine);
    return truncate(sliced, ctx.limits.toolOutputMaxChars);
  },
};

function slice(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split("\n");
  const start = Math.max((startLine ?? 1) - 1, 0);
  const end = Math.min(endLine ?? lines.length, lines.length);
  return lines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}: ${line}`)
    .join("\n");
}

export const searchFilesTool: ToolDefinition = {
  name: "search_files",
  description:
    "Search file contents with a regular expression. Skips .git, node_modules and binaries.",
  risk: "safe",
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().default("."),
    maxResults: z.number().int().min(1).max(200).default(60),
  }),
  async run(input, ctx) {
    const { pattern, path: rel, maxResults } = input as {
      pattern: string;
      path: string;
      maxResults: number;
    };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (error) {
      return `ERROR: invalid regular expression: ${(error as Error).message}`;
    }
    const root = await ctx.jail.resolveReal(rel);
    const hits: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= maxResults) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (hits.length >= maxResults) return;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || stat.size > 400_000) continue;
        const text = await fs.readFile(abs, "utf8").catch(() => "");
        if (text.includes("\0")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string;
          if (regex.test(line)) {
            hits.push(`${ctx.jail.relative(abs)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (hits.length >= maxResults) return;
          }
        }
      }
    };

    await walk(root);
    if (hits.length === 0) return `No matches for /${pattern}/`;
    return truncate(hits.join("\n"), ctx.limits.toolOutputMaxChars);
  },
};
