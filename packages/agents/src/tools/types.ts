import type { RiskLevel, Role, ToolSchema } from "@corpix/shared";
import type { z } from "zod";
import type { WorkspaceJail } from "./workspace";

export interface CommandOutcome {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ToolContext {
  jail: WorkspaceJail;
  role: Role;
  agentId: string;
  taskId: string;
  runId: string;
  limits: {
    toolOutputMaxChars: number;
    commandTimeoutMs: number;
  };
  /** Executes an allowlisted command; policy and approval happen here. */
  runCommand(command: string, args: string[]): Promise<CommandOutcome>;
  /** Queue a note for another agent. */
  messageAgent(to: string, text: string): void;
  /** Files this task has touched, used to build the report. */
  recordChange(relativePath: string): void;
  recordCommand(outcome: CommandOutcome): void;
  /** Shared context files the role may always write. */
  sharedContext: readonly string[];
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  risk: RiskLevel;
  /** Only these roles may call the tool; `undefined` means every role. */
  roles?: readonly string[];
  run(input: Input, ctx: ToolContext): Promise<string> | string;
}

export function toToolSchema(tool: ToolDefinition<never> | ToolDefinition<unknown>): ToolSchema {
  const jsonSchema = tool.inputSchema.toJSONSchema({
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return { name: tool.name, description: tool.description, jsonSchema };
}

export function isToolAllowed(tool: ToolDefinition<unknown>, role: Role): boolean {
  if (!role.tools.includes(tool.name)) return false;
  if (tool.roles && !tool.roles.includes(role.id)) return false;
  return true;
}
