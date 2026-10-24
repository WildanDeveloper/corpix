import { z } from "zod";
import { APPROVAL_MODES, BUDGET_ACTIONS, DEFAULT_LIMITS } from "./constants";
import { PricingSchema } from "./config";

export const ProviderSettingsSchema = z.object({
  name: z.enum(["openai-compatible", "mock"]).default("mock"),
  baseUrl: z.string().url().default("http://127.0.0.1:11434/v1"),
  maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  requestTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
  /**
   * Forced-tool wire format. `auto` learns from 400 responses, which matters
   * because some OpenAI-compatible servers only accept the function-name string.
   */
  toolChoiceStyle: z.enum(["auto", "object", "name", "required", "none"]).default("auto"),
  /**
   * Prompt caching. `auto` relies on the provider caching repeated prefixes
   * implicitly; `anthropic` adds explicit cache_control hints; `off` sends none.
   */
  promptCaching: z.enum(["off", "auto", "anthropic"]).default("auto"),
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const RoleOverrideSchema = z.object({
  model: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().max(500).optional(),
  contextTokens: z.number().int().positive().max(2_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type RoleOverride = z.infer<typeof RoleOverrideSchema>;

export const ModelSettingsSchema = z.object({
  boss: z.string().min(1).default("boss-model"),
  worker: z.string().min(1).default("worker-model"),
  cheap: z.string().min(1).default("cheap-model"),
  /** Per-role overrides, keyed by role id. */
  roles: z.record(z.string(), RoleOverrideSchema).default({}),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const LimitSettingsSchema = z.object({
  maxConcurrentAgents: z.number().int().positive().max(32).default(DEFAULT_LIMITS.maxConcurrentAgents),
  maxStepsPerTask: z.number().int().positive().max(500).default(DEFAULT_LIMITS.maxStepsPerTask),
  /** Default context budget per agent; each agent has its own, never shared. */
  contextTokens: z.number().int().positive().max(2_000_000).default(DEFAULT_LIMITS.contextTokens),
  taskTimeoutMinutes: z.number().positive().max(1440).default(DEFAULT_LIMITS.taskTimeoutMinutes),
  toolOutputMaxChars: z.number().int().positive().max(200_000).default(DEFAULT_LIMITS.toolOutputMaxChars),
  maxOutputTokens: z.number().int().positive().max(200_000).default(DEFAULT_LIMITS.maxOutputTokens),
  /** QA review + fix rounds after the first pass, 0 disables review. */
  reviewRounds: z.number().int().nonnegative().max(10).default(DEFAULT_LIMITS.reviewRounds),
  budgetUsdPerGoal: z.number().nonnegative().default(DEFAULT_LIMITS.budgetUsdPerGoal),
  budgetAction: z.enum(BUDGET_ACTIONS).default("pause"),
});
export type LimitSettings = z.infer<typeof LimitSettingsSchema>;

export const SafetySettingsSchema = z.object({
  approvalMode: z.enum(APPROVAL_MODES).default("ask"),
  sandbox: z.enum(["none", "bwrap", "docker"]).default("none"),
});
export type SafetySettings = z.infer<typeof SafetySettingsSchema>;

export const TeamSettingsSchema = z.object({
  company: z.string().min(1).default("Corpix"),
  /** Display names per role id; empty falls back to the YAML team file. */
  names: z.record(z.string(), z.string().min(1).max(40)).default({}),
});
export type TeamSettings = z.infer<typeof TeamSettingsSchema>;

export const GitSettingsSchema = z.object({
  /** One worktree and branch per task; merge into the integration branch. */
  enabled: z.boolean().default(true),
  integrationBranch: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._/-]+$/, "use a valid branch name")
    .default("integration"),
  /** Optional absolute path for worktrees; defaults to a sibling directory. */
  worktreesDir: z.string().optional(),
});
export type GitSettings = z.infer<typeof GitSettingsSchema>;

export const AppSettingsSchema = z.object({
  provider: ProviderSettingsSchema,
  models: ModelSettingsSchema,
  limits: LimitSettingsSchema,
  safety: SafetySettingsSchema,
  team: TeamSettingsSchema.default({ company: "Corpix", names: {} }),
  git: GitSettingsSchema.default({ enabled: true, integrationBranch: "integration" }),
  pricing: PricingSchema.default({}),
  updatedAt: z.string().optional(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const SettingsPatchSchema = z.object({
  provider: ProviderSettingsSchema.partial().optional(),
  models: z
    .object({
      boss: z.string().min(1).optional(),
      worker: z.string().min(1).optional(),
      cheap: z.string().min(1).optional(),
      roles: z.record(z.string(), RoleOverrideSchema).optional(),
    })
    .optional(),
  limits: LimitSettingsSchema.partial().optional(),
  safety: SafetySettingsSchema.partial().optional(),
  team: z
    .object({
      company: z.string().min(1).optional(),
      names: z.record(z.string(), z.string().min(1).max(40)).optional(),
    })
    .optional(),
  git: GitSettingsSchema.partial().optional(),
  pricing: PricingSchema.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/**
 * `apiKey` lives outside the database (the target design forbids keys in
 * SQLite). The runtime needs it, so it travels beside the settings object.
 */
export interface RuntimeSettings {
  settings: AppSettings;
  apiKey: string;
  /** Dotted paths pinned by environment variables; the UI should disable them. */
  locked: string[];
}

export interface SettingsView {
  settings: AppSettings;
  apiKeySet: boolean;
  apiKeyPreview: string;
  locked: string[];
}

export function defaultSettings(): AppSettings {
  return AppSettingsSchema.parse({
    provider: {},
    models: {},
    limits: {},
    safety: {},
    team: { company: "Corpix", names: {} },
    git: {},
    pricing: {},
  });
}

/** First boot: seed the persisted settings from the environment. */
export function settingsFromEnv(env: {
  LLM_PROVIDER: "openai-compatible" | "mock";
  LLM_BASE_URL: string;
  LLM_MAX_TOKENS_PARAM: "max_tokens" | "max_completion_tokens";
  BOSS_MODEL: string;
  WORKER_MODEL: string;
  CHEAP_MODEL: string;
  MAX_CONCURRENT_AGENTS: number;
  MAX_STEPS_PER_TASK: number;
  CONTEXT_TOKENS_PER_AGENT?: number;
  TASK_TIMEOUT_MINUTES: number;
  TOOL_OUTPUT_MAX_CHARS: number;
  BUDGET_USD_PER_GOAL: number;
  BUDGET_ACTION: "pause" | "stop";
  APPROVAL_MODE: "ask" | "auto-safe" | "auto";
  SANDBOX: "none" | "bwrap" | "docker";
}): AppSettings {
  return AppSettingsSchema.parse({
    provider: {
      name: env.LLM_PROVIDER,
      baseUrl: env.LLM_BASE_URL,
      maxTokensParam: env.LLM_MAX_TOKENS_PARAM,
    },
    models: {
      boss: env.BOSS_MODEL,
      worker: env.WORKER_MODEL,
      cheap: env.CHEAP_MODEL,
    },
    limits: {
      maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      maxStepsPerTask: env.MAX_STEPS_PER_TASK,
      contextTokens: env.CONTEXT_TOKENS_PER_AGENT ?? DEFAULT_LIMITS.contextTokens,
      taskTimeoutMinutes: env.TASK_TIMEOUT_MINUTES,
      toolOutputMaxChars: env.TOOL_OUTPUT_MAX_CHARS,
      budgetUsdPerGoal: env.BUDGET_USD_PER_GOAL,
      budgetAction: env.BUDGET_ACTION,
    },
    safety: {
      approvalMode: env.APPROVAL_MODE,
      sandbox: env.SANDBOX,
    },
    team: { company: "Corpix", names: {} },
    git: {},
  });
}

/**
 * Apply a patch without ever letting unknown keys through. Role overrides merge
 * per role, so the UI can change one agent without sending the whole map.
 */
export function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  const roleIds = new Set([
    ...Object.keys(current.models.roles),
    ...Object.keys(patch.models?.roles ?? {}),
  ]);
  const roles: AppSettings["models"]["roles"] = {};
  for (const id of roleIds) {
    roles[id] = { ...current.models.roles[id], ...(patch.models?.roles?.[id] ?? {}) };
  }
  const merged = {
    ...current,
    provider: { ...current.provider, ...(patch.provider ?? {}) },
    models: {
      ...current.models,
      ...(patch.models?.boss !== undefined ? { boss: patch.models.boss } : {}),
      ...(patch.models?.worker !== undefined ? { worker: patch.models.worker } : {}),
      ...(patch.models?.cheap !== undefined ? { cheap: patch.models.cheap } : {}),
      roles,
    },
    limits: { ...current.limits, ...(patch.limits ?? {}) },
    safety: { ...current.safety, ...(patch.safety ?? {}) },
    team: {
      ...current.team,
      ...(patch.team ?? {}),
      names: { ...current.team.names, ...(patch.team?.names ?? {}) },
    },
    git: { ...current.git, ...(patch.git ?? {}) },
    pricing: patch.pricing ?? current.pricing,
    updatedAt: new Date().toISOString(),
  };
  return AppSettingsSchema.parse(merged);
}

/**
 * Environment variables seed the database on first boot, but they do NOT pin
 * values by default. A deployment that wants to force a value lists it in
 * `CORPIX_PIN` (comma separated env names or dotted paths, or `*`).
 *
 * This matters because `.env.example` sets every variable: without an explicit
 * pin list, copying it would lock the entire settings UI.
 */
export const PIN_ENV = "CORPIX_PIN";

export function parsePins(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env[PIN_ENV]?.trim();
  if (!raw) return new Set();
  if (raw === "*" || raw.toLowerCase() === "all") return new Set(["*"]);
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function isPinned(pins: Set<string>, envName: string, path: string): boolean {
  return pins.has("*") || pins.has(envName) || pins.has(path);
}

/**
 * Apply environment pins. Values that fail validation are ignored instead of
 * crashing the server, so a typo in `.env` cannot take the whole app down.
 */
export function resolveSettings(
  stored: AppSettings,
  storedApiKey: string,
  env: NodeJS.ProcessEnv,
): RuntimeSettings {
  const settings: AppSettings = {
    ...stored,
    provider: { ...stored.provider },
    models: { ...stored.models, roles: { ...stored.models.roles } },
    limits: { ...stored.limits },
    safety: { ...stored.safety },
    team: { ...stored.team, names: { ...stored.team.names } },
    git: { ...stored.git },
    pricing: { ...stored.pricing },
  };
  const locked: string[] = [];
  const pins = parsePins(env);
  let apiKey = storedApiKey;

  const setString = (
    name: string,
    path: string[],
    apply: (value: string) => boolean,
  ): void => {
    const value = env[name];
    if (value === undefined || value.trim() === "") return;
    if (!isPinned(pins, name, path.join("."))) return;
    if (apply(value.trim())) locked.push(path.join("."));
  };

  const setNumber = (
    name: string,
    path: string[],
    min: number,
    max: number,
    apply: (value: number) => void,
  ): void => {
    const value = env[name];
    if (value === undefined || value.trim() === "") return;
    if (!isPinned(pins, name, path.join("."))) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return;
    apply(parsed);
    locked.push(path.join("."));
  };

  const providerName = env.LLM_PROVIDER;
  if (
    (providerName === "mock" || providerName === "openai-compatible") &&
    isPinned(pins, "LLM_PROVIDER", "provider.name")
  ) {
    settings.provider.name = providerName;
    locked.push("provider.name");
  }
  setString("LLM_BASE_URL", ["provider", "baseUrl"], (value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      settings.provider.baseUrl = value;
      return true;
    } catch {
      return false;
    }
  });
  const maxTokensParam = env.LLM_MAX_TOKENS_PARAM;
  if (
    (maxTokensParam === "max_tokens" || maxTokensParam === "max_completion_tokens") &&
    isPinned(pins, "LLM_MAX_TOKENS_PARAM", "provider.maxTokensParam")
  ) {
    settings.provider.maxTokensParam = maxTokensParam;
    locked.push("provider.maxTokensParam");
  }

  // The key in the environment is a fallback when no key has been stored yet,
  // and an override only when explicitly pinned.
  const envKey = env.LLM_API_KEY?.trim();
  if (envKey) {
    if (isPinned(pins, "LLM_API_KEY", "provider.apiKey")) {
      apiKey = envKey;
      locked.push("provider.apiKey");
    } else if (apiKey.length === 0) {
      apiKey = envKey;
    }
  }

  setString("BOSS_MODEL", ["models", "boss"], (value) => {
    settings.models.boss = value;
    return true;
  });
  setString("WORKER_MODEL", ["models", "worker"], (value) => {
    settings.models.worker = value;
    return true;
  });
  setString("CHEAP_MODEL", ["models", "cheap"], (value) => {
    settings.models.cheap = value;
    return true;
  });

  setNumber("MAX_CONCURRENT_AGENTS", ["limits", "maxConcurrentAgents"], 1, 32, (value) => {
    settings.limits.maxConcurrentAgents = value;
  });
  setNumber("MAX_STEPS_PER_TASK", ["limits", "maxStepsPerTask"], 1, 500, (value) => {
    settings.limits.maxStepsPerTask = value;
  });
  setNumber("CONTEXT_TOKENS_PER_AGENT", ["limits", "contextTokens"], 1_000, 2_000_000, (value) => {
    settings.limits.contextTokens = value;
  });
  setNumber("REVIEW_ROUNDS", ["limits", "reviewRounds"], 0, 10, (value) => {
    settings.limits.reviewRounds = value;
  });
  const promptCaching = env.PROMPT_CACHING;
  if (
    (promptCaching === "off" || promptCaching === "auto" || promptCaching === "anthropic") &&
    isPinned(pins, "PROMPT_CACHING", "provider.promptCaching")
  ) {
    settings.provider.promptCaching = promptCaching;
    locked.push("provider.promptCaching");
  }
  setNumber("TASK_TIMEOUT_MINUTES", ["limits", "taskTimeoutMinutes"], 0.1, 1440, (value) => {
    settings.limits.taskTimeoutMinutes = value;
  });
  setNumber("TOOL_OUTPUT_MAX_CHARS", ["limits", "toolOutputMaxChars"], 100, 200_000, (value) => {
    settings.limits.toolOutputMaxChars = value;
  });
  setNumber("BUDGET_USD_PER_GOAL", ["limits", "budgetUsdPerGoal"], 0, 1_000_000, (value) => {
    settings.limits.budgetUsdPerGoal = value;
  });
  const budgetAction = env.BUDGET_ACTION;
  if (
    (budgetAction === "pause" || budgetAction === "stop") &&
    isPinned(pins, "BUDGET_ACTION", "limits.budgetAction")
  ) {
    settings.limits.budgetAction = budgetAction;
    locked.push("limits.budgetAction");
  }
  const approval = env.APPROVAL_MODE;
  if (
    (approval === "ask" || approval === "auto-safe" || approval === "auto") &&
    isPinned(pins, "APPROVAL_MODE", "safety.approvalMode")
  ) {
    settings.safety.approvalMode = approval;
    locked.push("safety.approvalMode");
  }
  const sandbox = env.SANDBOX;
  if (
    (sandbox === "none" || sandbox === "bwrap" || sandbox === "docker") &&
    isPinned(pins, "SANDBOX", "safety.sandbox")
  ) {
    settings.safety.sandbox = sandbox;
    locked.push("safety.sandbox");
  }

  return { settings: AppSettingsSchema.parse(settings), apiKey, locked };
}

/** Never send the key back to the browser. */
export function maskSettings(runtime: RuntimeSettings): SettingsView {
  return {
    settings: runtime.settings,
    apiKeySet: runtime.apiKey.length > 0,
    apiKeyPreview: previewKey(runtime.apiKey),
    locked: runtime.locked,
  };
}

export function previewKey(apiKey: string): string {
  if (apiKey.length === 0) return "";
  if (apiKey.length <= 8) return "••••";
  return `${"•".repeat(6)}${apiKey.slice(-4)}`;
}

/** Model id for a role: per-role override wins over the tier default. */
export function modelForRole(roleId: string, models: ModelSettings): string {
  const override = models.roles[roleId]?.model;
  if (override) return override;
  if (roleId === "boss") return models.boss;
  if (roleId === "docs") return models.cheap;
  return models.worker;
}