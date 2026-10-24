import { z } from "zod";
import { AGENT_STATES, RISK_LEVELS } from "./constants.js";

export const EventTypeSchema = z.enum([
  "run.started",
  "run.finished",
  "run.failed",
  "run.cancelled",
  "run.paused",
  "plan.created",
  "task.created",
  "task.assigned",
  "task.started",
  "task.completed",
  "task.failed",
  "agent.state_changed",
  "tool.called",
  "tool.result",
  "message.sent",
  "meeting.started",
  "meeting.ended",
  "approval.requested",
  "approval.resolved",
  "usage.updated",
  "error",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/** Every event shares this envelope; `seq` is strictly increasing per run. */
export const EventEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  runId: z.string(),
  type: EventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Typed payloads for the events the core emits. */
export const RunStartedPayload = z.object({
  goal: z.string(),
  projectId: z.string(),
  budgetUsd: z.number(),
  approvalMode: z.string(),
});
export const PlanCreatedPayload = z.object({
  plan: z.unknown(),
  taskCount: z.number().int(),
});
export const TaskPayload = z.object({
  taskId: z.string(),
  role: z.string(),
  title: z.string(),
  agentId: z.string().optional(),
});
export const TaskCompletedPayload = TaskPayload.extend({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string(),
});
export const AgentStatePayload = z.object({
  agentId: z.string(),
  from: z.enum(AGENT_STATES),
  to: z.enum(AGENT_STATES),
  tool: z.string().optional(),
});
export const ToolCalledPayload = z.object({
  agentId: z.string(),
  tool: z.string(),
  callId: z.string(),
  input: z.unknown(),
  risk: z.enum(RISK_LEVELS),
});
export const ToolResultPayload = z.object({
  agentId: z.string(),
  tool: z.string(),
  callId: z.string(),
  isError: z.boolean(),
  durationMs: z.number(),
  preview: z.string(),
});
export const UsagePayload = z.object({
  agentId: z.string(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  spentUsd: z.number(),
  budgetUsd: z.number(),
});
export const ApprovalPayload = z.object({
  approvalId: z.string(),
  agentId: z.string(),
  tool: z.string(),
  risk: z.enum(RISK_LEVELS),
  summary: z.string(),
});
export const ErrorPayload = z.object({
  message: z.string(),
  code: z.string(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
});
export const RunFinishedPayload = z.object({
  status: z.string(),
  summary: z.string(),
  spentUsd: z.number(),
  tasks: z.object({
    total: z.number().int(),
    done: z.number().int(),
    failed: z.number().int(),
  }),
});

export type EventInput = {
  type: EventType;
  payload: Record<string, unknown>;
};

/** Minimal interface the runtime needs; the server and CLI both implement it. */
export interface EventSink {
  emit(event: EventInput): void;
}

/** Fan-out helper that keeps a bounded in-memory log for tests and replay. */
export class MemoryEventSink implements EventSink {
  readonly events: EventEnvelope[] = [];
  constructor(private readonly runId = "run_test") {}

  emit(event: EventInput): void {
    this.events.push({
      seq: this.events.length + 1,
      ts: new Date().toISOString(),
      runId: this.runId,
      type: event.type,
      payload: event.payload,
    });
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  find(type: EventType): EventEnvelope[] {
    return this.events.filter((e) => e.type === type);
  }
}
