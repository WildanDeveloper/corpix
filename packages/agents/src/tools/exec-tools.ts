import { z } from "zod";
import { truncate } from "@corpix/shared";
import type { ToolDefinition } from "./types";

export const runCommandTool: ToolDefinition = {
  name: "run_command",
  description:
    "Run an allowlisted executable inside the task's worktree. No shell is used. Installs need approval.",
  risk: "exec",
  inputSchema: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
  async run(input, ctx) {
    const { command, args } = input as { command: string; args: string[] };
    const outcome = await ctx.runCommand(command, args);
    ctx.recordCommand(outcome);
    const parts = [
      `$ ${[command, ...args].join(" ")}`,
      `exit code: ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}`,
    ];
    if (outcome.stdout.trim()) parts.push(`stdout:\n${outcome.stdout.trim()}`);
    if (outcome.stderr.trim()) parts.push(`stderr:\n${outcome.stderr.trim()}`);
    return truncate(parts.join("\n"), ctx.limits.toolOutputMaxChars);
  },
};

export const messageAgentTool: ToolDefinition = {
  name: "message_agent",
  description:
    "Send a short note to another agent. It is delivered at the start of that agent's next turn.",
  risk: "safe",
  inputSchema: z.object({
    to: z.string().min(1),
    message: z.string().min(1).max(4000),
  }),
  async run(input, ctx) {
    const { to, message } = input as { to: string; message: string };
    ctx.messageAgent(to, message);
    return `Message queued for ${to}`;
  },
};
