import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  Orchestrator,
  SettingsService,
  applyRoleOverrides,
  approvalDecider,
  capTeamSteps,
  createProviderFromSettings,
  detectSandboxes,
  envForRoles,
  loadTeam,
  listModels,
  probeProvider,
  type ApprovalRequest,
} from "@corpix/agents";
import {
  assertSafeBinding,
  findRepoRoot,
  maskSettings,
  mergeSettings,
  newProjectId,
  newRunId,
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

// Anything left "running" belongs to a previous process. Mark it paused so the
// UI can offer Resume instead of showing a run that will never move.
const INTERRUPTED = new Set(["planning", "running", "reviewing", "merging"]);
for (const run of store.listRuns()) {
  if (!INTERRUPTED.has(run.status)) continue;
  store.updateRun(run.id, {
    status: "paused",
    summary: [run.summary, "[interrupted by a restart; resume to continue]"]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  });
  for (const agent of store.listAgents(run.id)) {
    if (["thinking", "working", "blocked", "walking"].includes(agent.state)) {
      store.updateAgent(agent.id, { state: "idle" });
    }
  }
}
const active = new Map<string, ActiveRun>();
const pendingApprovals = new Map<string, { runId: string; resolve: (approved: boolean) => void }>();

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

/** Constant-time-ish comparison so a token cannot be guessed byte by byte. */
function tokenMatches(candidate: string): boolean {
  if (adminToken.length === 0) return true;
  if (candidate.length !== adminToken.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ adminToken.charCodeAt(i);
  }
  return diff === 0;
}

function bearerOf(header: string | undefined): string {
  if (!header) return "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

app.use((req, res, next) => {
  // The static UI must load before the user can paste the token, and the
  // container healthcheck cannot send one. Everything under /api needs auth.
  if (!req.path.startsWith("/api") || req.path === "/api/health") return next();
  if (tokenMatches(bearerOf(req.headers.authorization))) return next();
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
    // The UI uses this to explain the 401 instead of showing an empty panel.
    authRequired: adminToken.length > 0,
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
  const body = req.body as { model?: unknown; patch?: unknown };
  const current = settingsService.load();
  const parsed = SettingsPatchSchema.safeParse(body.patch ?? {});
  const settings = parsed.success
    ? mergeSettings(current.settings, parsed.data)
    : current.settings;
  const model =
    typeof body.model === "string" && body.model.length > 0
      ? body.model
      : settings.models.boss;
  void probeProvider({ ...current, settings }, model).then((result) => res.json(result));
});

app.delete("/api/settings/api-key", (_req, res) => {
  const runtime = settingsService.setApiKey("");
  res.json(maskSettings(runtime));
});

app.get("/api/sandbox", (_req, res) => {
  void detectSandboxes().then((available) => res.json({ available }));
});

/** Model list for the settings dropdown. Never spends tokens. */
app.get("/api/models", (_req, res) => {
  void (async () => {
    const runtime = settingsService.load();
    const result = await listModels(runtime);
    const fallback = [
      runtime.settings.models.boss,
      runtime.settings.models.worker,
      runtime.settings.models.cheap,
    ].filter((model) => model.length > 0);
    res.json({
      models: result.models.length > 0 ? result.models : fallback,
      ok: result.ok,
      detail: result.detail,
    });
  })();
});

/** Roles plus their effective model, so the UI can show "who uses what". */
app.get("/api/roles", (_req, res) => {
  void (async () => {
    const runtime = settingsService.load();
    const team = capTeamSteps(
      applyRoleOverrides(
        await loadTeam(configDir, "team.default.yaml", envForRoles(env)),
        runtime.settings.models,
        runtime.settings.team.names,
      ),
      runtime.settings.limits.maxStepsPerTask,
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
  const absolute = path.resolve(repoPath);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    res.status(400).json({ error: `repoPath does not exist: ${absolute}` });
    return;
  }
  if (!stat.isDirectory()) {
    res.status(400).json({ error: `repoPath is not a directory: ${absolute}` });
    return;
  }
  const project = {
    id: newProjectId(),
    name,
    repoPath: absolute,
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
  if (!body.projectId) throw new Error("projectId is required");
  const project = store.getProject(body.projectId);
  if (!project) throw new Error(`Unknown project: ${body.projectId}`);
  const workspacePath = project.repoPath;
  if (!existsSync(workspacePath)) throw new Error(`Workspace not found: ${workspacePath}`);

  const runtime = settingsService.load();
  const team = await loadTeam(configDir, "team.default.yaml", envForRoles(env));
  const pricing = await effectivePricing(runtime);
  const controller = new AbortController();

  // Reserve the id up front so the client can subscribe immediately.
  const runId = newRunId();
  if (store.getRun(runId)) throw new Error(`Run id collision: ${runId}`);
  const record: ActiveRun = {
    runId,
    controller,
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
        approve: approvalDecider(approvalMode, async (request) => {
      return await new Promise<boolean>((resolve) => {
        const approvalId = `ap_${Math.random().toString(36).slice(2, 10)}`;
        pendingApprovals.set(approvalId, { runId, resolve });
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
    }),
    onEvent: (envelope) => {
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
      const code = (error as { code?: string }).code;
      // Cancellation is a normal outcome, already recorded by the orchestrator.
      if (code !== "cancelled") {
        const envelope = store.appendEvent(runId, "error", {
          message: (error as Error).message,
          code: "run_error",
        });
        broadcastEnvelope(runId, envelope);
      }
    })
    .finally(() => {
      denyPendingApprovals(runId, "run ended");
      // Late subscribers still get the full history from SQLite.
      active.delete(runId);
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

app.post("/api/runs/:id/resume", (req, res) => {
  const body = req.body as { budgetUsd?: number; approvalMode?: "ask" | "auto-safe" | "auto" };
  void resumeRun(req.params.id, body).then(
    (runId) => res.status(202).json({ runId, resumed: true }),
    (error: unknown) => res.status(400).json({ error: (error as Error).message }),
  );
});

async function resumeRun(
  runId: string,
  body: { budgetUsd?: number; approvalMode?: "ask" | "auto-safe" | "auto" },
): Promise<string> {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (active.has(runId)) throw new Error(`Run ${runId} is already active`);
  if (run.status === "completed") throw new Error(`Run ${runId} is already completed`);
  if (!run.plan) throw new Error(`Run ${runId} has no plan; dispatch a new run instead`);

  const project = store.getProject(run.projectId);
  if (!project) {
    throw new Error(
      `Project ${run.projectId} is not registered, so the workspace cannot be found. ` +
        `Register it with POST /api/projects first.`,
    );
  }

  if (body.budgetUsd !== undefined) {
    store.updateRun(runId, { budgetUsd: body.budgetUsd });
  }
  if (body.approvalMode) {
    const runtime = settingsService.load();
    settingsService.save({ safety: { ...runtime.settings.safety, approvalMode: body.approvalMode } });
  }

  const runtime = settingsService.load();
  const team = await loadTeam(configDir, "team.default.yaml", envForRoles(env));
  const pricing = await effectivePricing(runtime);
  const controller = new AbortController();
  const record: ActiveRun = {
    runId,
    controller,
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
    workspacePath: project.repoPath,
    projectId: run.projectId,
    runId,
    approvalMode,
    budgetUsd: body.budgetUsd ?? run.budgetUsd,
    pricing,
    signal: controller.signal,
    approve: approvalDecider(approvalMode, async (request) => {
      return await new Promise<boolean>((resolve) => {
        const approvalId = `ap_${Math.random().toString(36).slice(2, 10)}`;
        pendingApprovals.set(approvalId, { runId, resolve });
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
    }),
    onEvent: (envelope) => broadcastEnvelope(runId, envelope),
  });

  void orchestrator
    .resume(run.goal)
    .then(() => {
      record.status = "finished";
    })
    .catch((error: unknown) => {
      const code = (error as { code?: string }).code;
      if (code !== "cancelled") {
        const envelope = store.appendEvent(runId, "error", {
          message: (error as Error).message,
          code: "resume_error",
        });
        broadcastEnvelope(runId, envelope);
      }
    })
    .finally(() => {
      denyPendingApprovals(runId, "run ended");
      active.delete(runId);
    });

  return runId;
}

app.post("/api/runs/:id/cancel", (req, res) => {
  const record = active.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: "run is not active" });
    return;
  }
  record.controller.abort();
  denyPendingApprovals(req.params.id, "run cancelled");
  res.json({ ok: true });
});

/** Resolve waiting approval promises so a cancelled run never hangs. */
function denyPendingApprovals(runId: string, reason: string): void {
  for (const [approvalId, entry] of pendingApprovals) {
    if (entry.runId !== runId) continue;
    pendingApprovals.delete(approvalId);
    store.resolveApproval(approvalId, "denied");
    const envelope = store.appendEvent(runId, "approval.resolved", {
      approvalId,
      decision: "denied",
      reason,
    });
    broadcastEnvelope(runId, envelope);
    entry.resolve(false);
  }
}

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
  const entry = pendingApprovals.get(approval);
  if (!entry) {
    res.status(404).json({ error: "approval not found or already resolved" });
    return;
  }
  const approved = decision === "approve";
  pendingApprovals.delete(approval);
  store.resolveApproval(approval, approved ? "approved" : "denied");
  const envelope = store.appendEvent(entry.runId, "approval.resolved", {
    approvalId: approval,
    decision: approved ? "approved" : "denied",
  });
  broadcastEnvelope(entry.runId, envelope);
  entry.resolve(approved);
  res.json({ ok: true, remembered: Boolean(remember) });
});

app.get("/api/usage", (req, res) => {
  const runId = String(req.query.runId ?? "");
  if (!runId) {
    res.status(400).json({ error: "runId is required" });
    return;
  }
  const rows = store.listUsage(runId);
  const inputTokens = rows.reduce((sum, row) => sum + row.usage.inputTokens, 0);
  const cachedInputTokens = rows.reduce(
    (sum, row) => sum + (row.usage.cachedInputTokens ?? 0),
    0,
  );
  res.json({
    rows,
    totalUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    inputTokens,
    outputTokens: rows.reduce((sum, row) => sum + row.usage.outputTokens, 0),
    cachedInputTokens,
    cacheHitRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
  });
});

const server = app.listen(env.PORT, env.HOST, () => {
  process.stdout.write(`Corpix server on http://${env.HOST}:${env.PORT} (provider: ${env.LLM_PROVIDER})\n`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(
      `Port ${env.PORT} is already in use. Stop the other process or set PORT to something else.\n`,
    );
  } else {
    process.stderr.write(`Server error: ${error.message}\n`);
  }
  process.exit(1);
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

const wss = new WebSocketServer({ noServer: true });

wss.on("error", (error: Error) => {
  process.stderr.write(`WebSocket server error: ${error.message}\n`);
});

// Reject unauthorised upgrades during the handshake, before any WS frame is
// exchanged. Browsers cannot set an Authorization header here, so the token may
// also arrive as a query parameter.
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/ws", `http://${env.HOST}:${env.PORT}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const token =
    bearerOf(request.headers.authorization) || url.searchParams.get("token") || "";
  if (!tokenMatches(token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

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
      const entry = pendingApprovals.get(message.approvalId);
      if (entry) {
        pendingApprovals.delete(message.approvalId);
        const approved = message.decision === "approve";
        store.resolveApproval(message.approvalId, approved ? "approved" : "denied");
        const envelope = store.appendEvent(entry.runId, "approval.resolved", {
          approvalId: message.approvalId,
          decision: approved ? "approved" : "denied",
        });
        broadcastEnvelope(entry.runId, envelope);
        entry.resolve(approved);
      }
    }
    if (message.type === "run.cancel") {
      active.get(runId)?.controller.abort();
      denyPendingApprovals(runId, "run cancelled");
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
