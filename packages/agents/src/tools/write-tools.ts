import { promises as fs } from "node:fs";
import path from "node:path";
import { ScopeError } from "@corpix/shared";
import { z } from "zod";
import { assertWritable } from "./workspace";
import type { ToolDefinition } from "./types";

async function guardTarget(ctx: Parameters<ToolDefinition["run"]>[1], rel: string): Promise<string> {
  const abs = await ctx.jail.resolveReal(rel);
  const relative = ctx.jail.relative(abs);
  assertWritable(relative, ctx.role.scope.write, {
    sharedContext: ctx.role.canWriteSharedContext ? ctx.sharedContext : [],
  });
  return abs;
}

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Create or overwrite a text file inside the role's write scope. Prefer edit_file for small changes.",
  risk: "write",
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  async run(input, ctx) {
    const { path: rel, content } = input as { path: string; content: string };
    const abs = await guardTarget(ctx, rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (stat?.isDirectory()) throw new ScopeError(`${rel} is a directory`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    ctx.recordChange(ctx.jail.relative(abs));
    return `Wrote ${ctx.jail.relative(abs)} (${content.length} bytes)`;
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace an exact string once. Fails when the string is missing or not unique. Cheaper than write_file.",
  risk: "write",
  inputSchema: z.object({
    path: z.string().min(1),
    oldString: z.string().min(1),
    newString: z.string(),
  }),
  async run(input, ctx) {
    const { path: rel, oldString, newString } = input as {
      path: string;
      oldString: string;
      newString: string;
    };
    const abs = await guardTarget(ctx, rel);
    const text = await fs.readFile(abs, "utf8").catch(() => null);
    if (text === null) return `ERROR: file not found: ${rel}`;
    const first = text.indexOf(oldString);
    if (first === -1) return `ERROR: oldString was not found in ${rel}`;
    if (text.indexOf(oldString, first + 1) !== -1) {
      return `ERROR: oldString is not unique in ${rel}; include more context`;
    }
    await fs.writeFile(abs, text.slice(0, first) + newString + text.slice(first + oldString.length), "utf8");
    ctx.recordChange(ctx.jail.relative(abs));
    return `Edited ${rel} (1 replacement)`;
  },
};
