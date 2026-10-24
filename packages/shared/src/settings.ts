import { z } from "zod";
import { APPROVAL_MODES, BUDGET_ACTIONS, DEFAULT_LIMITS } from "./constants";
import { PricingSchema, type Pricing } from "./config";

export const ProviderSettingsSchema = z.object({
  name: z.enum(["openai-compatible", "mock"]).default("mock"),
  baseUrl: z.string().url().default("http://127.0.0.1:11434/v1"),
  maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  requestTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const RoleOverrideSchema = z.object({
  model: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().max(500).optional(),
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
  taskTimeoutMinutes: z.number().positive().max(1440).default(DEFAULT_LIMITS.taskTimeoutMinutes),
  toolOutputMaxChars: z.number().int().positive().max(200_000).default(DEFAULT_LIMITS.toolOutputMaxChars),
  maxOutputTokens: z.number().int().positive().max(200_000).default(DEFAULT_LIMITS.maxOutputTokens),
  budgetUsdPerGoal: z.number().nonnegative().default(DEFAULT_LIMITS.budgetUsdPerGoal),
  budgetAction: z.enum(BUDGET_ACTIONS).default("pause"),
});
export type LimitSettings = z.infer<typeof LimitSettingsSchema>;

export const SafetySettingsSchema = z.object({
  approvalMode: z.enum(APPROVAL_MODES).default("ask"),
  sandbox: z.enum(["none", "docker"]).default("none"),
});
export type SafetySettings = z.infer<typeof SafetySettingsSchema>;

export const AppSettingsSchema = z.object({
  provider: ProviderSettingsSchema,
  models: ModelSettingsSchema,
  limits: LimitSettingsSchema,
  safety: SafetySettingsSchema,
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
  TASK_TIMEOUT_MINUTES: number;
  TOOL_OUTPUT_MAX_CHARS: number;
  BUDGET_USD_PER_GOAL: number;
  BUDGET_ACTION: "pause" | "stop";
  APPROVAL_MODE: "ask" | "auto-safe" | "auto";
  SANDBOX: "none" | "docker";
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
      taskTimeoutMinutes: env.TASK_TIMEOUT_MINUTES,
      toolOutputMaxChars: env.TOOL_OUTPUT_MAX_CHARS,
      budgetUsdPerGoal: env.BUDGET_USD_PER_GOAL,
      budgetAction: env.BUDGET_ACTION,
    },
    safety: {
      approvalMode: env.APPROVAL_MODE,
      sandbox: env.SANDBOX,
    },
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
    pricing: patch.pricing ?? current.pricing,
    updatedAt: new Date().toISOString(),
  };
  return AppSettingsSchema.parse(merged);
}

/**
 * Environment variables win when set, so a deployment can pin a provider
 * without the UI silently overriding it. `locked` tells the UI which controls
 * to disable.
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
    pricing: { ...stored.pricing },
  };
  const locked: string[] = [];
  let apiKey = storedApiKey;

  const setString = (name: string, path: string[], apply: (value: string) => void): void => {
    const value = env[name];
    if (value === undefined || value.trim() === "") return;
    apply(value.trim());
    locked.push(path.join("."));
  };
  const setNumber = (name: string, path: string[], apply: (value: number) => void): void => {
    const value = env[name];
    if (value === undefined || value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    apply(parsed);
    locked.push(path.join("."));
  };

  const providerName = env.LLM_PROVIDER;
  if (providerName === "mock" || providerName === "openai-compatible") {
    settings.provider.name = providerName;
    locked.push("provider.name");
  }
  setString("LLM_BASE_URL", ["provider", "baseUrl"], (v) => {
    settings.provider.baseUrl = v;
  });
  const maxTokensParam = env.LLM_MAX_TOKENS_PARAM;
  if (maxTokensParam === "max_tokens" || maxTokensParam === "max_completion_tokens") {
    settings.provider.maxTokensParam = maxTokensParam;
    locked.push("provider.maxTokensParam");
  }
  setString("LLM_API_KEY", ["provider", "apiKey"], (v) => {
    apiKey = v;
  });

  setString("BOSS_MODEL", ["models", "boss"], (v) => {
    settings.models.boss = v;
  });
  setString("WORKER_MODEL", ["models", "worker"], (v) => {
    settings.models.worker = v;
  });
  setString("CHEAP_MODEL", ["models", "cheap"], (v) => {
    settings.models.cheap = v;
  });

  setNumber("MAX_CONCURRENT_AGENTS", ["limits", "maxConcurrentAgents"], (v) => {
    settings.limits.maxConcurrentAgents = v;
  });
  setNumber("MAX_STEPS_PER_TASK", ["limits", "maxStepsPerTask"], (v) => {
    settings.limits.maxStepsPerTask = v;
  });
  setNumber("TASK_TIMEOUT_MINUTES", ["limits", "taskTimeoutMinutes"], (v) => {
    settings.limits.taskTimeoutMinutes = v;
  });
  setNumber("TOOL_OUTPUT_MAX_CHARS", ["limits", "toolOutputMaxChars"], (v) => {
    settings.limits.toolOutputMaxChars = v;
  });
  setNumber("BUDGET_USD_PER_GOAL", ["limits", "budgetUsdPerGoal"], (v) => {
    settings.limits.budgetUsdPerGoal = v;
  });
  const budgetAction = env.BUDGET_ACTION;
  if (budgetAction === "pause" || budgetAction === "stop") {
    settings.limits.budgetAction = budgetAction;
    locked.push("limits.budgetAction");
  }
  const approval = env.APPROVAL_MODE;
  if (approval === "ask" || approval === "auto-safe" || approval === "auto") {
    settings.safety.approvalMode = approval;
    locked.push("safety.approvalMode");
  }
  const sandbox = env.SANDBOX;
  if (sandbox === "none" || sandbox === "docker") {
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
export function modelForRole(
  roleId: string,
  models: ModelSettings,
): string {
  const override = models.roles[roleId]?.model;
  if (override) return override;
  if (roleId === "boss") return models.boss;
  if (roleId === "docs") return models.cheap;
  return models.worker;
}

export function pricingForModel(pricing: Pricing, model: string): Pricing[string] | undefined {
  return pricing[model];
}
