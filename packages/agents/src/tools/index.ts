import type { RiskLevel, Role, ToolCallBlock, ToolResultBlock, ToolSchema } from "@corpix/shared";
import { makePlanSchema, truncate } from "@corpix/shared";
import { messageAgentTool, runCommandTool } from "./exec-tools";
import { listFilesTool, readFileTool, searchFilesTool } from "./read-tools";
import { createTaskTool, submitPlanTool, submitReportTool } from "./submit-tools";
import type { ToolContext, ToolDefinition } from "./types";
import { isToolAllowed, toToolSchema } from "./types";
import { editFileTool, writeFileTool } from "./write-tools";

export const ALL_TOOLS: ToolDefinition<never>[] = [
  listFilesTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  messageAgentTool,
  submitPlanTool,
  createTaskTool,
  submitReportTool,
] as unknown as ToolDefinition<never>[];

export const TOOL_REGISTRY = new Map<string, ToolDefinition<never>>(
  ALL_TOOLS.map((tool) => [tool.name, tool]),
);

export function toolsForRole(role: Role): ToolDefinition<never>[] {
  return ALL_TOOLS.filter((tool) => isToolAllowed(tool, role));
}

/**
 * Build the tool schemas for a role. For the Boss, `submit_plan` is rebuilt with
 * the loaded role ids so the model can only name roles that exist.
 */
export function schemasForRole(role: Role, roleIds?: readonly string[]): ToolSchema[] {
  return toolsForRole(role).map((tool) => {
    if (tool.name === "submit_plan" && roleIds && roleIds.length > 0) {
      const schema = makePlanSchema(roleIds);
      const jsonSchema = schema.toJSONSchema({ target: "draft-7", io: "input" }) as Record<
        string,
        unknown
      >;
      delete jsonSchema.$schema;
      return { name: tool.name, description: tool.description, jsonSchema };
    }
    return toToolSchema(tool);
  });
}

export interface ApprovalRequest {
  agentId: string;
  tool: string;
  risk: RiskLevel;
  input: unknown;
  summary: string;
}

export type ApprovalDecider = (request: ApprovalRequest) => Promise<boolean>;

export interface ExecuteOptions {
  ctx: ToolContext;
  role: Role;
  /** Role ids for the dynamic plan schema; only the Boss uses it. */
  roleIds?: readonly string[];
  /** Called for `exec`/`network` risks; resolving false denies the call. */
  approve: ApprovalDecider;
  onCall?: (call: ToolCallBlock, tool: ToolDefinition<never>) => void;
  onResult?: (result: ToolResultBlock, durationMs: number) => void;
}

/**
 * Executes one tool call. Every failure is turned into an error result for the
 * model instead of an exception, so a weak model can recover on its own.
 */
export async function executeToolCall(
  call: ToolCallBlock,
  options: ExecuteOptions,
): Promise<ToolResultBlock> {
  const started = Date.now();
  const tool = TOOL_REGISTRY.get(call.name);

  const finish = (content: string, isError: boolean): ToolResultBlock => {
    const result: ToolResultBlock = {
      type: "tool_result",
      toolCallId: call.id,
      name: call.name,
      content,
      isError,
    };
    options.onResult?.(result, Date.now() - started);
    return result;
  };

  if (!tool) {
    return finish(`ERROR: unknown tool "${call.name}". Available: ${options.role.tools.join(", ")}`, true);
  }
  if (!isToolAllowed(tool, options.role)) {
    return finish(`ERROR: the ${options.role.id} role may not call ${call.name}`, true);
  }

  const parsed = tool.inputSchema.safeParse(call.input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return finish(`ERROR: invalid tool arguments for ${call.name}: ${issues}`, true);
  }

  options.onCall?.(call, tool);

  if (tool.risk === "exec" || tool.risk === "network") {
    const approved = await options.approve({
      agentId: options.ctx.agentId,
      tool: tool.name,
      risk: tool.risk,
      input: parsed.data,
      summary: summariseCall(tool.name, parsed.data),
    });
    if (!approved) {
      return finish(`ERROR: the human denied this ${tool.name} call. Do not retry it.`, true);
    }
  }

  try {
    const output = await tool.run(parsed.data as never, options.ctx);
    return finish(
      truncate(String(output), options.ctx.limits.toolOutputMaxChars),
      false,
    );
  } catch (error) {
    return finish(`ERROR: ${(error as Error).message}`, true);
  }
}

function summariseCall(name: string, input: unknown): string {
  if (name === "run_command") {
    const { command, args } = input as { command: string; args: string[] };
    return `${command} ${args.join(" ")}`.trim();
  }
  return `${name} ${JSON.stringify(input).slice(0, 160)}`;
}
