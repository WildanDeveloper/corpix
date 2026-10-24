export type ProviderName = "mock" | "openai-compatible";
export type MaxTokensParam = "max_tokens" | "max_completion_tokens";
export type ApprovalMode = "ask" | "auto-safe" | "auto";

export interface ProviderSettings {
  name: ProviderName;
  baseUrl: string;
  maxTokensParam: MaxTokensParam;
  requestTimeoutMs: number;
  toolChoiceStyle: "auto" | "object" | "name" | "required" | "none";
  promptCaching: "off" | "auto" | "anthropic";
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
  reviewRounds: number;
  budgetUsdPerGoal: number;
  budgetAction: "pause" | "stop";
}

export interface SafetySettings {
  approvalMode: ApprovalMode;
  sandbox: "none" | "bwrap" | "docker";
}

export interface SandboxInfo {
  kind: "none" | "bwrap" | "docker";
  available: boolean;
  detail: string;
}

export interface MindSettings {
  enabled: boolean;
  intervalSeconds: number;
  model: string;
  maxTokens: number;
  temperature: number;
  maxTurns: number;
  maxConcurrent: number;
  memorySize: number;
  allowOperatorChat: boolean;
  language: "auto" | "id" | "en";
}

export interface MindSnapshot {
  agentId: string;
  role: string;
  name: string;
  mood: { valence: number; arousal: number; label: string };
  thought: string;
  doing: string;
  memories: Array<{ at: string; text: string }>;
  relationships: Record<string, { sentiment: number; note: string; talks: number }>;
}

export interface AgentSessionView {
  role: string;
  tasks: number;
  memory: string;
  inputTokens: number;
  outputTokens: number;
  updatedAt: string;
}

export interface TeamSettings {
  company: string;
  names: Record<string, string>;
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
  mind: MindSettings;
  team: TeamSettings;
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
  cachedInputTokens: number;
  cacheHitRate: number;
  rows: Array<{ model: string; costUsd: number; usage: { inputTokens: number; outputTokens: number } }>;
}
