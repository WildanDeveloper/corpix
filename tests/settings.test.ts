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
  AppSettingsSchema,
  CancelledError,
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

  it("merges team names per role without dropping siblings", () => {
    const base = mergeSettings(defaultSettings(), {
      team: { company: "Acme", names: { qa: "Sinta" } },
    });
    const next = mergeSettings(base, { team: { names: { backend: "Rizky" } } });
    expect(next.team.company).toBe("Acme");
    expect(next.team.names).toEqual({ qa: "Sinta", backend: "Rizky" });
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

describe("environment override", () => {
  it("does NOT pin values unless listed in CORPIX_PIN", () => {
    const stored = mergeSettings(settingsFromEnv(envDefaults), {
      models: { boss: "stored-boss" },
    });
    const runtime = resolveSettings(stored, "stored-key", {
      LLM_PROVIDER: "mock",
      BOSS_MODEL: "env-boss",
      APPROVAL_MODE: "auto",
      MAX_CONCURRENT_AGENTS: "7",
      LLM_API_KEY: "env-key",
    });
    expect(runtime.settings.models.boss).toBe("stored-boss");
    expect(runtime.settings.safety.approvalMode).toBe("ask");
    expect(runtime.settings.limits.maxConcurrentAgents).toBe(3);
    expect(runtime.apiKey).toBe("stored-key");
    expect(runtime.locked).toEqual([]);
  });

  it("uses the environment key as a fallback when none is stored", () => {
    const stored = settingsFromEnv(envDefaults);
    const runtime = resolveSettings(stored, "", { LLM_API_KEY: "env-key" });
    expect(runtime.apiKey).toBe("env-key");
    expect(runtime.locked).toEqual([]);
  });

  it("lets CORPIX_PIN force values and reports them as locked", () => {
    const stored = settingsFromEnv(envDefaults);
    const runtime = resolveSettings(stored, "stored-key", {
      CORPIX_PIN: "WORKER_MODEL,LLM_API_KEY,safety.approvalMode,MAX_CONCURRENT_AGENTS",
      WORKER_MODEL: "env-worker",
      LLM_API_KEY: "env-key",
      APPROVAL_MODE: "auto",
      MAX_CONCURRENT_AGENTS: "7",
    });
    expect(runtime.settings.models.worker).toBe("env-worker");
    expect(runtime.apiKey).toBe("env-key");
    expect(runtime.settings.safety.approvalMode).toBe("auto");
    expect(runtime.settings.limits.maxConcurrentAgents).toBe(7);
    expect(runtime.locked.sort()).toEqual(
      [
        "models.worker",
        "provider.apiKey",
        "limits.maxConcurrentAgents",
        "safety.approvalMode",
      ].sort(),
    );
  });

  it("treats CORPIX_PIN=* as pinning everything that is set", () => {
    const runtime = resolveSettings(settingsFromEnv(envDefaults), "", {
      CORPIX_PIN: "*",
      BOSS_MODEL: "env-boss",
      MAX_STEPS_PER_TASK: "9",
    });
    expect(runtime.settings.models.boss).toBe("env-boss");
    expect(runtime.settings.limits.maxStepsPerTask).toBe(9);
    expect(runtime.locked).toContain("models.boss");
  });

  it("ignores out-of-range and invalid pinned numbers instead of crashing", () => {
    const stored = settingsFromEnv(envDefaults);
    for (const value of ["many", "9999", "-3"]) {
      const runtime = resolveSettings(stored, "", {
        CORPIX_PIN: "MAX_CONCURRENT_AGENTS",
        MAX_CONCURRENT_AGENTS: value,
      });
      expect(runtime.settings.limits.maxConcurrentAgents).toBe(3);
      expect(runtime.locked).toEqual([]);
    }
  });

  it("ignores an invalid pinned base URL", () => {
    const stored = settingsFromEnv(envDefaults);
    const runtime = resolveSettings(stored, "", {
      CORPIX_PIN: "LLM_BASE_URL",
      LLM_BASE_URL: "file:///etc/passwd",
    });
    expect(runtime.settings.provider.baseUrl).toBe(stored.provider.baseUrl);
    expect(runtime.locked).toEqual([]);
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
      roles: {
        backend: { model: "backend-x", maxSteps: 7, contextTokens: 1_000_000, temperature: 0.4 },
      },
    });
    const backend = applied.workers.find((w) => w.role.id === "backend")?.role;
    expect(backend?.model).toBe("backend-x");
    expect(backend?.maxSteps).toBe(7);
    expect(backend?.contextTokens).toBe(1_000_000);
    expect(backend?.temperature).toBe(0.4);
    expect(applied.roles.get("backend")?.model).toBe("backend-x");
  });

  it("renames agents from team settings", () => {
    const applied = applyRoleOverrides(
      team,
      { boss: "b", worker: "w", cheap: "c", roles: {} },
      { boss: "Rina", backend: "Rizky", qa: "Sinta" },
    );
    expect(applied.boss.name).toBe("Rina");
    expect(applied.workers.find((worker) => worker.role.id === "backend")?.name).toBe("Rizky");
    expect(applied.workers.find((worker) => worker.role.id === "qa")?.name).toBe("Sinta");
    // Unnamed roles keep the YAML name.
    expect(applied.workers.find((worker) => worker.role.id === "frontend")?.name).toBe("Fiona");
  });

  it("ignores blank names and falls back to the YAML team file", () => {
    const applied = applyRoleOverrides(
      team,
      { boss: "b", worker: "w", cheap: "c", roles: {} },
      { backend: "   " },
    );
    expect(applied.workers.find((worker) => worker.role.id === "backend")?.name).toBe("Bruno");
  });

  it("keeps each role's context budget independent", () => {
    const applied = applyRoleOverrides(team, {
      boss: "b",
      worker: "w",
      cheap: "c",
      roles: {
        backend: { contextTokens: 1_000_000 },
        qa: { contextTokens: 200_000 },
      },
    });
    const byId = new Map(applied.workers.map((w) => [w.role.id, w.role]));
    expect(byId.get("backend")?.contextTokens).toBe(1_000_000);
    expect(byId.get("qa")?.contextTokens).toBe(200_000);
    expect(byId.get("frontend")?.contextTokens).toBeUndefined();
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

  it("never persists pinned environment values or lets a patch overwrite them", () => {
    const store = new MemoryStore();
    const service = new SettingsService(
      store,
      { CORPIX_PIN: "WORKER_MODEL", WORKER_MODEL: "pinned-worker" },
      envDefaults,
    );
    service.load();
    const saved = service.save({ models: { worker: "hacked", boss: "boss-ui" } });
    expect(saved.settings.models.worker).toBe("pinned-worker");
    expect(saved.settings.models.boss).toBe("boss-ui");

    const stored = store.readSettings() as AppSettings;
    expect(stored.models.worker).toBe("worker-default");
    expect(stored.models.boss).toBe("boss-ui");
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

  it("returns a cancelled outcome when the run is aborted", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    const provider = {
      name: "slow",
      complete: (request: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new CancelledError()), {
            once: true,
          });
        }),
    };

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_cancel",
      approvalMode: "auto",
      signal: controller.signal,
    });

    const promise = orchestrator.run("Cancel me");
    setTimeout(() => controller.abort(), 20);
    const outcome = await promise;

    expect(outcome.status).toBe("cancelled");
    expect(store.getRun("run_cancel")?.status).toBe("cancelled");
    const types = store.listEvents("run_cancel").map((event) => event.type);
    expect(types).toContain("run.cancelled");
    expect(types).not.toContain("run.failed");
  });
});
