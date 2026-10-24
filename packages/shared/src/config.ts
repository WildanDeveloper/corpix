import { z } from "zod";
import { APPROVAL_MODES, BUDGET_ACTIONS } from "./constants.js";

export const RoleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sprite: z.string().default("palette-blue"),
  model: z.string().min(1),
  maxSteps: z.number().int().positive().default(40),
  /**
   * Context budget for THIS agent's own conversation. Every agent gets its own
   * budget; they are never pooled. Falls back to the global limit when unset.
   */
  contextTokens: z.number().int().positive().max(2_000_000).optional(),
  /** Sampling temperature; provider default when omitted. */
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.string()).min(1),
  scope: z.object({
    write: z.array(z.string()).default([]),
    read: z.array(z.string()).default(["**"]),
  }),
  commands: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [] }),
  systemPrompt: z.string().min(1),
  /** Roles allowed to write SPEC.md / NOTES.md even with an empty scope. */
  canWriteSharedContext: z.boolean().default(false),
});
export type Role = z.infer<typeof RoleSchema>;

export const TeamMemberSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1),
});

export const TeamSchema = z.object({
  name: z.string().min(1),
  boss: TeamMemberSchema,
  workers: z.array(TeamMemberSchema).min(1),
  limits: z
    .object({
      maxConcurrentAgents: z.number().int().positive().default(3),
      reviewRounds: z.number().int().nonnegative().default(2),
    })
    .default({ maxConcurrentAgents: 3, reviewRounds: 2 }),
});
export type Team = z.infer<typeof TeamSchema>;

export const EnvSchema = z.object({
  LLM_PROVIDER: z.enum(["openai-compatible", "mock"]).default("openai-compatible"),
  LLM_BASE_URL: z.string().default("http://127.0.0.1:11434/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MAX_TOKENS_PARAM: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  BOSS_MODEL: z.string().default("boss-model"),
  WORKER_MODEL: z.string().default("worker-model"),
  CHEAP_MODEL: z.string().default("cheap-model"),
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().positive().default(3),
  MAX_STEPS_PER_TASK: z.coerce.number().int().positive().default(40),
  TASK_TIMEOUT_MINUTES: z.coerce.number().positive().default(20),
  TOOL_OUTPUT_MAX_CHARS: z.coerce.number().int().positive().default(8000),
  BUDGET_USD_PER_GOAL: z.coerce.number().nonnegative().default(5),
  BUDGET_ACTION: z.enum(BUDGET_ACTIONS).default("pause"),
  APPROVAL_MODE: z.enum(APPROVAL_MODES).default("ask"),
  SANDBOX: z.enum(["none", "bwrap", "docker"]).default("bwrap"),
  SANDBOX_IMAGE: z.string().default("node:22-bookworm-slim"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3001),
  ADMIN_TOKEN: z.string().default(""),
  DATA_DIR: z.string().default("./data"),
  WORKSPACES_DIR: z.string().default("./workspaces"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type Env = z.infer<typeof EnvSchema>;

export const PricingSchema = z.record(
  z.string(),
  z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cached_input: z.number().nonnegative().optional(),
  }),
);
export type Pricing = z.infer<typeof PricingSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return EnvSchema.parse(source);
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** The server refuses to bind a public address without an admin token. */
export function assertSafeBinding(env: Pick<Env, "HOST" | "ADMIN_TOKEN">): void {
  if (!isLoopback(env.HOST) && env.ADMIN_TOKEN.trim() === "") {
    throw new Error(
      `Refusing to bind ${env.HOST} without ADMIN_TOKEN. Set HOST=127.0.0.1 or provide ADMIN_TOKEN.`,
    );
  }
}

export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => env[key] ?? "");
}
