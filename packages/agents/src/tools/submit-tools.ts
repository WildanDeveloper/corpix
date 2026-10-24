import { PlanSchema, ReportSchema } from "@corpix/shared";
import { z } from "zod";
import type { ToolDefinition } from "./types";

export const submitPlanTool: ToolDefinition = {
  name: "submit_plan",
  description:
    "Submit the final structured plan. Call this once, after writing SPEC.md. Every dependency must exist.",
  risk: "safe",
  roles: ["boss"],
  inputSchema: PlanSchema,
  run() {
    return "Plan received.";
  },
};

export const SubmitReportSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string().min(1),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z
    .array(z.object({ command: z.string(), exitCode: z.number().int() }))
    .default([]),
  openIssues: z.array(z.string()).default([]),
});

export const submitReportTool: ToolDefinition = {
  name: "submit_report",
  description:
    "Finish the task with a structured report. Always call this, even when blocked or failed.",
  risk: "safe",
  inputSchema: SubmitReportSchema,
  run() {
    return "Report received.";
  },
};

export const CreateTaskSchema = z.object({
  role: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const createTaskTool: ToolDefinition = {
  name: "create_task",
  description: "Add a follow-up task after reviewing a report.",
  risk: "safe",
  roles: ["boss"],
  inputSchema: CreateTaskSchema,
  run() {
    return "Follow-up task queued.";
  },
};

export { ReportSchema };
