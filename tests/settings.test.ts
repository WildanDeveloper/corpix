import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  MockProvider,
  Orchestrator,
  SettingsService,
  applyRoleOverrides,
  loadTeam,
  type LoadedTeam,
} from "@corpix/agents";
import {
  defaultSettings,
  maskSettings,
  mergeSettings,
  previewKey,
  resolveSettings,
  settingsFromEnv,
  type AppSettings,
  type Env,
  type RuntimeSettings,
} from "@corpix/shared";

const envDefaults: Env = {
  LLM_PROVIDER: "mock",
  LLM_BASE_URL: "http://localhost:11434/v1",
  LLM_API_KEY: "",
  LLM_MAX_TOKENS_PARAM: "max_tokens",
  BOSS_MODEL: "boss-default",
  WORKER_MODEL: "worker-default",
  CHEAP_MODEL: "cheap-default",
  MAX_CONCURRENT_AGENTS: 3,
  MAX_STEPS_PER_TASK: 40,
  TASK_TIMEOUT_MINUTES: 20,
  TOOL_OUTPUT_MAX_CHARS: 8000,
  BUDGET_USD_PER_GOAL: 5,
  BUDGET_ACTION: "pause",
  APPROVAL_MODE: "ask",
  SANDBOX: "none",
  SANDBOX_IMAGE: "node:22-bookworm-slim",
  HOST: "127.0.0.1",
  PORT: 3001,
  ADMIN_TOKEN: "",
  DATA_DIR: "./data",
  WORKSPACES_DIR: "./workspaces",
  LOG_LEVEL: "info",
};

function runtimeWith(patch: Parameters<typeof mergeSettings>[1], apiKey = ""): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey, locked: [] };
}

describe("settings defaults and merging", () => {
  it("produces a complete object from empty input", () => {
    const settings = defaultSettings();
    expect(settings.provider.name).toBe("mock");
    expect(settings.limits.maxConcurrentAgents).toBe(3);
    expect(settings.models.roles).toEqual({});
  });

  it("merges nested patches without dropping siblings", () => {
    const base = settingsFromEnv(envDefaults);
    const next = mergeSettings(base, {
      models: { boss: "strong", roles: { qa: { model: "qa-model" } } },
      limits: { maxStepsPerTask: 12 },
    });
    expect(next.models.boss).toBe("strong");
    expect(next.models.worker).toBe("worker-default");
    expect(next.models.roles.qa?.model).toBe("qa-model");
    expect(next.limits.maxStepsPerTask).toBe(12);
    expect(next.limits.maxConcurrentAgents).toBe(3);
    expect(next.updatedAt).toBeTruthy();
  });

  it("merges role overrides per field", () => {
    const base = mergeSettings(defaultSettings(), {
      models: { roles: { backend: { temperature: 0.2 } } },
    });
    const next = mergeSettings(base, { models: { roles: { backend: { model: "x" } } } });
    expect(next.models.roles.backend).toEqual({ temperature: 0.2, model: "x" });
  });

  it("rejects out-of-range values", () => {
    expect(() =>
      mergeSettings(defaultSettings(), { limits: { maxConcurrentAgents: 999 } }),
    ).toThrow();
    expect(() =>
      mergeSettings(defaultSettings(), { models: { roles: { qa: { temperature: 9 } } } }),
    ).toThrow();
  });
});

describe("environment overrides", () => {
  it("lets the environment pin values and reports them as locked", () => {
    const stored = settingsFromEnv(envDefaults);
    const runtime = resolveSettings(stored, "stored-key", {
      WORKER_MODEL: "env-worker",
      LLM_API_KEY: "env-key",
      APPROVAL_MODE: "auto",
      MAX_CONCURRENT_AGENTS: "7",
    });
    expect(runtime.settings.models.worker).toBe("env-worker");
    expect(runtime.apiKey).toBe("env-key");
    expect(runtime.settings.safety.approvalMode).toBe("auto");
    expect(runtime.settings.limits.maxConcurrentAgents).toBe(7);
    expect(runtime.locked).toContain("models.worker");
    expect(runtime.locked).toContain("provider.apiKey");
  });

  it("uses stored values when the environment is empty", () => {
    const stored = mergeSettings(settingsFromEnv(envDefaults), {
      models: { boss: "stored-boss" },
      provider: { baseUrl: "https://stored.example/v1" },
    });
    const runtime = resolveSettings(stored, "stored-key", {
      LLM_API_KEY: "",
      BOSS_MODEL: "   ",
    });
    expect(runtime.settings.models.boss).toBe("stored-boss");
    expect(runtime.settings.provider.baseUrl).toBe("https://stored.example/v1");
    expect(runtime.apiKey).toBe("stored-key");
    expect(runtime.locked).toEqual([]);
  });

  it("ignores invalid numeric overrides", () => {
    const stored = settingsFromEnv(envDefaults);
    const runtime = resolveSettings(stored, "", { MAX_CONCURRENT_AGENTS: "many" });
    expect(runtime.settings.limits.maxConcurrentAgents).toBe(3);
  });
});

describe("secret masking", () => {
  it("never returns the full key", () => {
    const runtime = runtimeWith({}, "sk-super-secret-1234");
    const view = maskSettings(runtime);
    const json = JSON.stringify(view);
    expect(json).not.toContain("sk-super-secret-1234");
    expect(view.apiKeySet).toBe(true);
    expect(view.apiKeyPreview.endsWith("1234")).toBe(true);
  });

  it("previews short keys without revealing them", () => {
    expect(previewKey("short")).toBe("••••");
    expect(previewKey("")).toBe("");
  });
});

describe("per-role model overrides", () => {
  let team: LoadedTeam;
  beforeEach(async () => {
    team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
      BOSS_MODEL: "b",
      WORKER_MODEL: "w",
      CHEAP_MODEL: "c",
    } as NodeJS.ProcessEnv);
  });

  it("uses the tier default when no override exists", () => {
    const applied = applyRoleOverrides(team, {
      boss: "boss-x",
      worker: "worker-x",
      cheap: "cheap-x",
      roles: {},
    });
    expect(applied.boss.role.model).toBe("boss-x");
    expect(applied.workers.find((w) => w.role.id === "backend")?.role.model).toBe("worker-x");
  });

  it("applies a per-role model, step cap and temperature", () => {
    const applied = applyRoleOverrides(team, {
      boss: "boss-x",
      worker: "worker-x",
      cheap: "cheap-x",
      roles: { backend: { model: "backend-x", maxSteps: 7, temperature: 0.4 } },
    });
    const backend = applied.workers.find((w) => w.role.id === "backend")?.role;
    expect(backend?.model).toBe("backend-x");
    expect(backend?.maxSteps).toBe(7);
    expect(backend?.temperature).toBe(0.4);
    expect(applied.roles.get("backend")?.model).toBe("backend-x");
  });
});

describe("SettingsService", () => {
  it("seeds from the environment on first load and persists patches", () => {
    const store = new MemoryStore();
    const service = new SettingsService(store, {}, envDefaults);
    const first = service.load();
    expect(first.settings.models.boss).toBe("boss-default");

    const saved = service.save({ models: { boss: "from-ui" }, limits: { maxOutputTokens: 2048 } });
    expect(saved.settings.models.boss).toBe("from-ui");
    expect(saved.settings.limits.maxOutputTokens).toBe(2048);

    const again = service.load();
    expect(again.settings.models.boss).toBe("from-ui");
  });

  it("stores the API key separately and reports it without leaking", () => {
    const store = new MemoryStore();
    const service = new SettingsService(store, {}, envDefaults);
    service.setApiKey("sk-file-key-9999");
    const runtime = service.load();
    expect(store.readApiKey()).toBe("sk-file-key-9999");
    expect(JSON.stringify(store.readSettings())).not.toContain("sk-file-key-9999");
    expect(maskSettings(runtime).apiKeyPreview.endsWith("9999")).toBe(true);
  });
});

describe("orchestrator uses settings", () => {
  let workspace: string;
  let team: LoadedTeam;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-settings-"));
    team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
      BOSS_MODEL: "b",
      WORKER_MODEL: "w",
      CHEAP_MODEL: "c",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("runs with the model configured for each role", async () => {
    const store = new MemoryStore();
    const runtime = runtimeWith({
      models: {
        boss: "boss-model",
        worker: "worker-model",
        cheap: "cheap-model",
        roles: { backend: { model: "backend-special" } },
      },
      limits: { maxConcurrentAgents: 2, maxStepsPerTask: 25 },
    });

    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_settings",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("Do it");
    expect(outcome.status).toBe("completed");
    const models = store.listUsage("run_settings").map((row) => row.model);
    expect(models).toContain("boss-model");
    expect(models).toContain("backend-special");
    expect(store.listAgents("run_settings").find((a) => a.role === "backend")?.model).toBe(
      "backend-special",
    );
  });

  it("uses the configured budget when none is passed", async () => {
    const store = new MemoryStore();
    const runtime = runtimeWith({
      limits: { budgetUsdPerGoal: 0.0000001 },
      pricing: { "boss-model": { input: 1_000_000, output: 1_000_000 } },
    });
    const orchestrator = new Orchestrator({
      store,
      provider: new MockProvider(),
      team,
      runtime,
      workspacePath: workspace,
      projectId: "test",
      runId: "run_budget_settings",
      approvalMode: "auto",
    });
    const outcome = await orchestrator.run("Spend");
    expect(outcome.status).toBe("paused");
  });
});
