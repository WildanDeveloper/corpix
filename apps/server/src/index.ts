import { existsSync } from "node:fs";
import path from "node:path";
import {
  Orchestrator,
  createProvider,
  envForRoles,
  loadTeam,
  type ApprovalRequest,
} from "@corpix/agents";
import {
  assertSafeBinding,
  newProjectId,
  parseEnv,
  type Env,
} from "@corpix/shared";
import { openMigrated, SqliteStore } from "@corpix/server/db";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import "dotenv/config";
import { readFile } from "node:fs/promises";
import YAML from "yaml";

interface ActiveRun {
  runId: string;
  controller: AbortController;
  events: Array<{ seq: number; ts: string; runId: string; type: string; payload: unknown }>;
  clients: Set<WebSocket>;
  status: "running" | "paused" | "finished";
}

const env = parseEnv(process.env);
assertSafeBinding(env);

const configDir = path.join(process.cwd(), "config");
const store = new SqliteStore(openMigrated(path.join(env.DATA_DIR, "corpix.sqlite")));
const active = new Map<string, ActiveRun>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();

async function loadPricing(): Promise<Record<string, { input: number; output: number; cached_input?: number }>> {
  const file = path.join(configDir, "pricing.yaml");
  if (!existsSync(file)) return {};
  return (YAML.parse(await readFile(file, "utf8")) as Record<string, { input: number; output: number }>) ?? {};
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
  res.json({
    ok: true,
    provider: env.LLM_PROVIDER,
    providerConfigured: env.LLM_PROVIDER === "mock" ? true : env.LLM_BASE_URL.length > 0,
    model: env.BOSS_MODEL,
    activeRuns: active.size,
  });
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

  const team = await loadTeam(configDir, "team.default.yaml", envForRoles(env));
  const pricing = await loadPricing();
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

  const orchestrator = new Orchestrator({
    store,
    provider: createProvider(env),
    team,
    workspacePath,
    projectId: body.projectId ?? path.basename(workspacePath),
    runId,
    approvalMode: env.APPROVAL_MODE,
    budgetUsd: body.budgetUsd ?? env.BUDGET_USD_PER_GOAL,
    pricing,
    signal: controller.signal,
    limits: {
      maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      maxStepsPerTask: env.MAX_STEPS_PER_TASK,
      toolOutputMaxChars: env.TOOL_OUTPUT_MAX_CHARS,
      taskTimeoutMinutes: env.TASK_TIMEOUT_MINUTES,
      reviewRounds: team.team.limits.reviewRounds,
    },
    approve: async (request: ApprovalRequest) => {
      if (env.APPROVAL_MODE === "auto") return true;
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
