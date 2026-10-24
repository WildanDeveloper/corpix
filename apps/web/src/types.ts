export type ProviderName = "mock" | "openai-compatible";
export type MaxTokensParam = "max_tokens" | "max_completion_tokens";
export type ApprovalMode = "ask" | "auto-safe" | "auto";

export interface ProviderSettings {
  name: ProviderName;
  baseUrl: string;
  maxTokensParam: MaxTokensParam;
  requestTimeoutMs: number;
  toolChoiceStyle: "auto" | "object" | "name" | "required" | "none";
}

export interface RoleOverride {
  model?: string;
  maxSteps?: number;
  contextTokens?: number;
  temperature?: number;
}

export interface ModelSettings {
  boss: string;
  worker: string;
  cheap: string;
  roles: Record<string, RoleOverride>;
}

export interface LimitSettings {
  maxConcurrentAgents: number;
  maxStepsPerTask: number;
  contextTokens: number;
  taskTimeoutMinutes: number;
  toolOutputMaxChars: number;
  maxOutputTokens: number;
  budgetUsdPerGoal: number;
  budgetAction: "pause" | "stop";
}

export interface SafetySettings {
  approvalMode: ApprovalMode;
  sandbox: "none" | "docker";
}

export interface GitSettings {
  enabled: boolean;
  integrationBranch: string;
  worktreesDir?: string;
}

export interface PricingEntry {
  input: number;
  output: number;
  cached_input?: number;
}

export interface AppSettings {
  provider: ProviderSettings;
  models: ModelSettings;
  limits: LimitSettings;
  safety: SafetySettings;
  git: GitSettings;
  pricing: Record<string, PricingEntry>;
  updatedAt?: string;
}

export interface SettingsView {
  settings: AppSettings;
  apiKeySet: boolean;
  apiKeyPreview: string;
  locked: string[];
}

export interface RoleSummary {
  id: string;
  title: string;
  model: string;
  maxSteps: number;
  contextTokens?: number;
  temperature?: number;
  scope: { write: string[]; read: string[] };
}

export interface RolesView {
  boss: { role: RoleSummary; name: string };
  workers: Array<{ role: RoleSummary; name: string }>;
  locked: string[];
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  goal: string;
  status: string;
  budgetUsd: number;
  spentUsd: number;
  startedAt: string;
  summary: string | null;
}

export interface RunEvent {
  seq: number;
  ts: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ApprovalRow {
  id: string;
  agentId: string;
  tool: string;
  risk: string;
  summary: string;
  status: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  models: string[];
}

export interface UsageResponse {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  rows: Array<{ model: string; costUsd: number; usage: { inputTokens: number; outputTokens: number } }>;
}
