import { existsSync } from "node:fs";
import path from "node:path";
import {
  Orchestrator,
  SettingsService,
  applyRoleOverrides,
  createProviderFromSettings,
  envForRoles,
  loadTeam,
  probeProvider,
  type ApprovalRequest,
} from "@corpix/agents";
import {
  assertSafeBinding,
  findRepoRoot,
  maskSettings,
  newProjectId,
  parseEnv,
  resolveDataDir,
  SettingsPatchSchema,
  type Env,
} from "@corpix/shared";
import { openMigrated, SqliteStore } from "@corpix/server/db";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config as loadDotenv } from "dotenv";
import { readFile } from "node:fs/promises";
import YAML from "yaml";

interface ActiveRun {
  runId: string;
  controller: AbortController;
  events: Array<{ seq: number; ts: string; runId: string; type: string; payload: unknown }>;
  clients: Set<WebSocket>;
  status: "running" | "paused" | "finished";
}

const repoRoot = findRepoRoot();
loadDotenv({ path: path.join(repoRoot, ".env") });
const env = parseEnv(process.env);
assertSafeBinding(env);

const configDir = path.join(repoRoot, "config");
const dataDir = resolveDataDir(env.DATA_DIR, repoRoot);
const store = new SqliteStore(
  openMigrated(path.join(dataDir, "corpix.sqlite")),
  path.join(dataDir, "secrets.json"),
);
const settingsService = new SettingsService(store, process.env, env);
const active = new Map<string, ActiveRun>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();

async function loadPricing(): Promise<Record<string, { input: number; output: number; cached_input?: number }>> {
  const file = path.join(configDir, "pricing.yaml");
  if (!existsSync(file)) return {};
  return (YAML.parse(await readFile(file, "utf8")) as Record<string, { input: number; output: number }>) ?? {};
}

/** Pricing comes from settings first, then config/pricing.yaml. */
async function effectivePricing(runtime: ReturnType<SettingsService["load"]>) {
  const fromYaml = await loadPricing();
  return { ...fromYaml, ...runtime.settings.pricing };
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const adminToken = env.ADMIN_TOKEN.trim();
app.use((req, res, next) => {
  if (adminToken.length === 0) return next();
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${adminToken}`) return next();
  res.status(401).json({ error: "unauthorized" });
});

app.get("/api/health", (_req, res) => {
  const runtime = settingsService.load();
  res.json({
    ok: true,
    provider: runtime.settings.provider.name,
    providerConfigured:
      runtime.settings.provider.name === "mock" || runtime.apiKey.length > 0,
    model: runtime.settings.models.boss,
    activeRuns: active.size,
    apiKeySet: runtime.apiKey.length > 0,
  });
});

// --- settings ---------------------------------------------------------------

app.get("/api/settings", (_req, res) => {
  const runtime = settingsService.load();
  res.json(maskSettings(runtime));
});

app.patch("/api/settings", (req, res) => {
  const parsed = SettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid settings",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return;
  }
  try {
    const runtime = settingsService.save(parsed.data);
    res.json(maskSettings(runtime));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.put("/api/settings/api-key", (req, res) => {
  const { apiKey } = req.body as { apiKey?: unknown };
  if (typeof apiKey !== "string" || apiKey.length > 1000) {
    res.status(400).json({ error: "apiKey must be a string of at most 1000 characters" });
    return;
  }
  const runtime = settingsService.setApiKey(apiKey);
  res.json(maskSettings(runtime));
});

app.post("/api/settings/test", (req, res) => {
  const body = req.body as { model?: unknown };
  const runtime = settingsService.load();
  const model =
    typeof body.model === "string" && body.model.length > 0 ? body.model : runtime.settings.models.boss;
  void probeProvider(runtime, model).then((result) => res.json(result));
});

/** Model list for the settings dropdown. Falls back to the configured ids. */
app.get("/api/models", (_req, res) => {
  void (async () => {
    const runtime = settingsService.load();
    const probe = await probeProvider(runtime, runtime.settings.models.boss);
    const models =
      probe.models.length > 0
        ? probe.models
        : [
            runtime.settings.models.boss,
            runtime.settings.models.worker,
            runtime.settings.models.cheap,
          ];
    res.json({ models, ok: probe.ok, detail: probe.ok ? undefined : probe.detail });
  })();
});

/** Roles plus their effective model, so the UI can show "who uses what". */
app.get("/api/roles", (_req, res) => {
  void (async () => {
    const runtime = settingsService.load();
    const team = applyRoleOverrides(
      await loadTeam(configDir, "team.default.yaml", envForRoles(env)),
      runtime.settings.models,
    );
    res.json({
      boss: { role: team.boss.role, name: team.boss.name },
      workers: team.workers,
      locked: runtime.locked,
    });
  })().catch((error: unknown) => res.status(500).json({ error: (error as Error).message }));
});

app.get("/api/projects", (_req, res) => {
  res.json(store.listProjects());
});

app.post("/api/projects", (req, res) => {
  const { name, repoPath } = req.body as { name?: string; repoPath?: string };
  if (!name || !repoPath) {
    res.status(400).json({ error: "name and repoPath are required" });
    return;
  }
  const project = {
    id: newProjectId(),
    name,
    repoPath: path.resolve(repoPath),
    createdAt: new Date().toISOString(),
  };
  store.createProject(project);
  res.status(201).json(project);
});

app.post("/api/runs", (req, res) => {
  void startRun(req.body as { projectId?: string; goal?: string; budgetUsd?: number }).then(
    (runId) => res.status(202).json({ runId }),
    (error: unknown) => res.status(400).json({ error: (error as Error).message }),
  );
});

async function startRun(body: {
  projectId?: string;
  goal?: string;
  budgetUsd?: number;
}): Promise<string> {
  if (!body.goal) throw new Error("goal is required");
  const project = body.projectId ? store.getProject(body.projectId) : null;
  if (body.projectId && !project) throw new Error(`Unknown project: ${body.projectId}`);
  const workspacePath = project?.repoPath ?? process.cwd();
  if (!existsSync(workspacePath)) throw new Error(`Workspace not found: ${workspacePath}`);

  const runtime = settingsService.load();
  const team = await loadTeam(configDir, "team.default.yaml", envForRoles(env));
  const pricing = await effectivePricing(runtime);
  const controller = new AbortController();

  // Reserve the id up front so the client can subscribe immediately.
  const runId = `run_${Date.now().toString(36)}`;
  const record: ActiveRun = {
    runId,
    controller,
    events: [],
    clients: new Set(),
    status: "running",
  };
  active.set(runId, record);

  const approvalMode = runtime.settings.safety.approvalMode;
  const orchestrator = new Orchestrator({
    store,
    provider: createProviderFromSettings(runtime),
    team,
    runtime,
    workspacePath,
    projectId: body.projectId ?? path.basename(workspacePath),
    runId,
    approvalMode,
    budgetUsd: body.budgetUsd ?? runtime.settings.limits.budgetUsdPerGoal,
    pricing,
    signal: controller.signal,
    limits: { reviewRounds: team.team.limits.reviewRounds },
    approve: async (request: ApprovalRequest) => {
      if (approvalMode === "auto") return true;
      return await new Promise<boolean>((resolve) => {
        const approvalId = `ap_${Math.random().toString(36).slice(2, 10)}`;
        pendingApprovals.set(approvalId, resolve);
        store.createApproval({
          id: approvalId,
          runId,
          agentId: request.agentId,
          tool: request.tool,
          input: request.input,
          risk: request.risk,
          status: "pending",
          summary: request.summary,
          decidedAt: null,
        });
        broadcast(runId, "approval.requested", {
          approvalId,
          agentId: request.agentId,
          tool: request.tool,
          risk: request.risk,
          summary: request.summary,
        });
      });
    },
    onEvent: (envelope) => {
      record.events.push(envelope);
      broadcastEnvelope(runId, envelope);
    },
  });

  void orchestrator
    .run(body.goal)
    .then(() => {
      record.status = "finished";
    })
    .catch((error: unknown) => {
      record.status = "finished";
      const envelope = store.appendEvent(runId, "error", {
        message: (error as Error).message,
        code: "run_error",
      });
      broadcastEnvelope(runId, envelope);
    });

  return runId;
}

app.get("/api/runs", (_req, res) => {
  res.json(store.listRuns());
});

app.get("/api/runs/:id", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({
    run,
    tasks: store.listTasks(run.id),
    agents: store.listAgents(run.id),
    usage: store.listUsage(run.id),
  });
});

app.post("/api/runs/:id/cancel", (req, res) => {
  const record = active.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: "run is not active" });
    return;
  }
  record.controller.abort();
  store.updateRun(req.params.id, { status: "cancelled" });
  broadcast(req.params.id, "run.cancelled", { status: "cancelled" });
  res.json({ ok: true });
});

app.get("/api/runs/:id/events", (req, res) => {
  const since = Number(req.query.since ?? 0);
  res.json(store.listEvents(req.params.id, Number.isFinite(since) ? since : 0));
});

app.get("/api/agents", (req, res) => {
  const runId = String(req.query.runId ?? "");
  if (!runId) {
    res.status(400).json({ error: "runId is required" });
    return;
  }
  res.json(store.listAgents(runId));
});

app.get("/api/approvals", (req, res) => {
  const runId = String(req.query.runId ?? "");
  const status = req.query.status as "pending" | "approved" | "denied" | undefined;
  if (!runId) {
    res.status(400).json({ error: "runId is required" });
    return;
  }
  res.json(store.listApprovals(runId, status));
});

app.post("/api/approvals/:id", (req, res) => {
  const { decision, remember } = req.body as { decision?: string; remember?: boolean };
  const approval = req.params.id;
  const resolve = pendingApprovals.get(approval);
  if (!resolve) {
    res.status(404).json({ error: "approval not found or already resolved" });
    return;
  }
  const approved = decision === "approve";
  pendingApprovals.delete(approval);
  store.resolveApproval(approval, approved ? "approved" : "denied");
  resolve(approved);
  res.json({ ok: true, remembered: Boolean(remember) });
});

app.get("/api/usage", (req, res) => {
  const runId = String(req.query.runId ?? "");
  if (!runId) {
    res.status(400).json({ error: "runId is required" });
    return;
  }
  const rows = store.listUsage(runId);
  res.json({
    rows,
    totalUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.usage.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.usage.outputTokens, 0),
  });
});

const server = app.listen(env.PORT, env.HOST, () => {
  process.stdout.write(`Corpix server on http://${env.HOST}:${env.PORT} (provider: ${env.LLM_PROVIDER})\n`);
});

// Serve the built web app when it exists, so one URL is enough.
const webDist = path.join(repoRoot, "apps", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
  process.stdout.write(`Serving the web UI from ${webDist}\n`);
}

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/ws", `http://${env.HOST}:${env.PORT}`);
  const runId = url.searchParams.get("runId") ?? "";
  const since = Number(url.searchParams.get("since") ?? 0);
  const record = active.get(runId);
  if (record) record.clients.add(socket);

  for (const envelope of store.listEvents(runId, Number.isFinite(since) ? since : 0)) {
    socket.send(JSON.stringify(envelope));
  }

  socket.on("message", (raw) => {
    let message: { type?: string; approvalId?: string; decision?: string };
    try {
      message = JSON.parse(raw.toString()) as typeof message;
    } catch {
      return;
    }
    if (message.type === "approval.respond" && message.approvalId) {
      const resolve = pendingApprovals.get(message.approvalId);
      if (resolve) {
        pendingApprovals.delete(message.approvalId);
        const approved = message.decision === "approve";
        store.resolveApproval(message.approvalId, approved ? "approved" : "denied");
        resolve(approved);
      }
    }
    if (message.type === "run.cancel") {
      active.get(runId)?.controller.abort();
    }
  });

  socket.on("close", () => {
    record?.clients.delete(socket);
  });
});

function broadcast(runId: string, type: string, payload: unknown): void {
  const envelope = store.appendEvent(runId, type, payload);
  broadcastEnvelope(runId, envelope);
}

function broadcastEnvelope(runId: string, envelope: unknown): void {
  const record = active.get(runId);
  if (!record) return;
  const data = JSON.stringify(envelope);
  for (const client of record.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

const shutdown = (): void => {
  for (const record of active.values()) record.controller.abort();
  wss.close();
  server.close();
  store.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
