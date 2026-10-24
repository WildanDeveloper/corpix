/** Agent lifecycle, mirrors the state machine in the README. */
export const AGENT_STATES = [
  "idle",
  "walking",
  "thinking",
  "working",
  "blocked",
  "done",
  "error",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "review",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = [
  "planning",
  "running",
  "reviewing",
  "merging",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const APPROVAL_MODES = ["ask", "auto-safe", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const BUDGET_ACTIONS = ["pause", "stop"] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

/** Tool risk levels, see "Approval modes" in the README. */
export const RISK_LEVELS = ["safe", "write", "exec", "network"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const DEFAULT_LIMITS = {
  maxConcurrentAgents: 3,
  maxStepsPerTask: 40,
  contextTokens: 120_000,
  taskTimeoutMinutes: 20,
  toolOutputMaxChars: 8000,
  budgetUsdPerGoal: 5,
  reviewRounds: 2,
  planAttempts: 2,
  maxOutputTokens: 4096,
} as const;
