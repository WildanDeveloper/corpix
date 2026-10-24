import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  EventEnvelopeSchema,
  type EventEnvelope,
  type Plan,
  type Report,
  type RunStatus,
  type TaskStatus,
} from "@corpix/shared";
import type {
  AgentRecord,
  ApprovalRecord,
  MessageRow,
  ProjectRecord,
  RunRecord,
  Store,
  TaskRecord,
  UsageRecordRow,
} from "@corpix/agents";
import type { Db } from "./schema";

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class SqliteStore implements Store {
  constructor(
    private readonly db: Db,
    private readonly secretsFile?: string,
  ) {}

  // --- projects -------------------------------------------------------------
  createProject(project: ProjectRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.repoPath, project.createdAt);
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProject(row) : null;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToProject);
  }

  // --- runs -----------------------------------------------------------------
  createRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, goal, status, plan_json, budget_usd, spent_usd, summary, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.projectId,
        run.goal,
        run.status,
        run.plan ? JSON.stringify(run.plan) : null,
        run.budgetUsd,
        run.spentUsd,
        run.summary,
        run.startedAt,
        run.finishedAt,
      );
  }

  updateRun(id: string, patch: Partial<RunRecord>): void {
    const current = this.getRun(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE runs SET project_id = ?, goal = ?, status = ?, plan_json = ?, budget_usd = ?,
         spent_usd = ?, summary = ?, started_at = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        next.projectId,
        next.goal,
        next.status,
        next.plan ? JSON.stringify(next.plan) : null,
        next.budgetUsd,
        next.spentUsd,
        next.summary,
        next.startedAt,
        next.finishedAt,
        id,
      );
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToRun);
  }

  // --- tasks ----------------------------------------------------------------
  createTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, run_id, parent_id, role, title, instructions, status,
          depends_on_json, acceptance_json, branch, report_json, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.runId,
        task.parentId,
        task.role,
        task.title,
        task.instructions,
        task.status,
        JSON.stringify(task.dependsOn),
        JSON.stringify(task.acceptanceCriteria),
        task.branch,
        task.report ? JSON.stringify(task.report) : null,
        task.startedAt,
        task.finishedAt,
      );
  }

  updateTask(id: string, patch: Partial<TaskRecord>): void {
    const current = this.getTask(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE tasks SET parent_id = ?, role = ?, title = ?, instructions = ?, status = ?,
         depends_on_json = ?, acceptance_json = ?, branch = ?, report_json = ?, started_at = ?,
         finished_at = ? WHERE id = ?`,
      )
      .run(
        next.parentId,
        next.role,
        next.title,
        next.instructions,
        next.status,
        JSON.stringify(next.dependsOn),
        JSON.stringify(next.acceptanceCriteria),
        next.branch,
        next.report ? JSON.stringify(next.report) : null,
        next.startedAt,
        next.finishedAt,
        id,
      );
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(runId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY started_at, rowid")
      .all(runId) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  // --- agents ---------------------------------------------------------------
  createAgent(agent: AgentRecord): void {
    this.db
      .prepare("INSERT INTO agents (id, run_id, role, name, model, state) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agent.id, agent.runId, agent.role, agent.name, agent.model, agent.state);
  }

  updateAgent(id: string, patch: Partial<AgentRecord>): void {
    const current = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!current) return;
    const next = { ...rowToAgent(current), ...patch };
    this.db
      .prepare("UPDATE agents SET role = ?, name = ?, model = ?, state = ? WHERE id = ?")
      .run(next.role, next.name, next.model, next.state, id);
  }

  listAgents(runId: string): AgentRecord[] {
    const rows = this.db.prepare("SELECT * FROM agents WHERE run_id = ?").all(runId) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToAgent);
  }

  // --- events ---------------------------------------------------------------
  appendEvent(runId: string, type: string, payload: unknown): EventEnvelope {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?")
      .get(runId) as { seq: number };
    const envelope: EventEnvelope = {
      seq: row.seq + 1,
      ts: new Date().toISOString(),
      runId,
      type: type as EventEnvelope["type"],
      payload: (payload ?? {}) as Record<string, unknown>,
    };
    this.db
      .prepare("INSERT INTO events (run_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(runId, envelope.seq, envelope.ts, envelope.type, JSON.stringify(envelope.payload));
    return envelope;
  }

  listEvents(runId: string, sinceSeq = 0): EventEnvelope[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, sinceSeq) as Record<string, unknown>[];
    return rows.map((row) =>
      EventEnvelopeSchema.parse({
        seq: row.seq,
        ts: row.ts,
        runId: row.run_id,
        type: row.type,
        payload: parse(row.payload_json as string, {}),
      }),
    );
  }

  // --- usage ----------------------------------------------------------------
  recordUsage(row: UsageRecordRow): void {
    this.db
      .prepare(
        `INSERT INTO usage (run_id, task_id, agent_id, model, input_tokens, output_tokens,
          cached_input_tokens, cost_usd, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.taskId,
        row.agentId,
        row.model,
        row.usage.inputTokens,
        row.usage.outputTokens,
        row.usage.cachedInputTokens ?? null,
        row.costUsd,
        row.ts,
      );
  }

  listUsage(runId: string): UsageRecordRow[] {
    const rows = this.db.prepare("SELECT * FROM usage WHERE run_id = ? ORDER BY id").all(runId) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => ({
      runId: row.run_id as string,
      taskId: row.task_id as string,
      agentId: row.agent_id as string,
      model: row.model as string,
      usage: {
        inputTokens: row.input_tokens as number,
        outputTokens: row.output_tokens as number,
        cachedInputTokens: (row.cached_input_tokens as number | null) ?? undefined,
      },
      costUsd: row.cost_usd as number,
      ts: row.ts as string,
    }));
  }

  // --- approvals ------------------------------------------------------------
  createApproval(approval: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, agent_id, tool, input_json, risk, status, summary, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.runId,
        approval.agentId,
        approval.tool,
        JSON.stringify(approval.input),
        approval.risk,
        approval.status,
        approval.summary,
        approval.decidedAt,
      );
  }

  resolveApproval(id: string, status: "approved" | "denied"): void {
    this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  listApprovals(runId: string, status?: ApprovalRecord["status"]): ApprovalRecord[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM approvals WHERE run_id = ? AND status = ?").all(runId, status)
        : this.db.prepare("SELECT * FROM approvals WHERE run_id = ?").all(runId)
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      runId: row.run_id as string,
      agentId: row.agent_id as string,
      tool: row.tool as string,
      input: parse(row.input_json as string, {}),
      risk: row.risk as string,
      status: row.status as ApprovalRecord["status"],
      summary: row.summary as string,
      decidedAt: (row.decided_at as string | null) ?? null,
    }));
  }

  // --- agent sessions -------------------------------------------------------
  readAgentSession(runId: string, role: string): import("@corpix/agents").AgentSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agent_sessions WHERE run_id = ? AND role = ?")
      .get(runId, role) as Record<string, unknown> | undefined;
    return row ? sessionFrom(row) : null;
  }

  writeAgentSession(row: import("@corpix/agents").AgentSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions (run_id, role, memory, tasks, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, role) DO UPDATE SET
           memory = excluded.memory,
           tasks = excluded.tasks,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           updated_at = excluded.updated_at`,
      )
      .run(row.runId, row.role, row.memory, row.tasks, row.inputTokens, row.outputTokens, row.updatedAt);
  }

  listAgentSessions(runId: string): import("@corpix/agents").AgentSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_sessions WHERE run_id = ? ORDER BY role")
      .all(runId) as Record<string, unknown>[];
    return rows.map(sessionFrom);
  }

  // --- messages -------------------------------------------------------------
  appendMessage(row: MessageRow): void {
    this.db
      .prepare("INSERT INTO messages (task_id, agent_id, idx, role, content_json) VALUES (?, ?, ?, ?, ?)")
      .run(row.taskId, row.agentId, row.idx, row.role, JSON.stringify(row.content));
  }

  listMessages(taskId: string): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY idx, id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      taskId: row.task_id as string,
      agentId: row.agent_id as string,
      idx: row.idx as number,
      role: row.role as string,
      content: parse(row.content_json as string, []),
    }));
  }

  // --- settings -------------------------------------------------------------
  readSettings(): unknown | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    return parse<unknown>(row.value, null);
  }

  writeSettings(settings: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings));
  }

  /**
   * API keys never enter SQLite. They live in `data/secrets.json` with mode
   * 0600, or in the environment. `/settings` only ever returns a masked preview.
   */
  readApiKey(): string {
    if (!this.secretsFile) return "";
    try {
      const raw = readFileSync(this.secretsFile, "utf8");
      const parsed = JSON.parse(raw) as { apiKey?: unknown };
      return typeof parsed.apiKey === "string" ? parsed.apiKey : "";
    } catch {
      return "";
    }
  }

  writeApiKey(apiKey: string): void {
    if (!this.secretsFile) return;
    mkdirSync(path.dirname(path.resolve(this.secretsFile)), { recursive: true });
    writeFileSync(
      this.secretsFile,
      JSON.stringify({ apiKey }, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(this.secretsFile, 0o600);
  }

  close(): void {
    this.db.close();
  }
}

function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    repoPath: row.repo_path as string,
    createdAt: row.created_at as string,
  };
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    goal: row.goal as string,
    status: row.status as RunStatus,
    plan: parse<Plan | null>(row.plan_json as string | null, null),
    budgetUsd: row.budget_usd as number,
    spentUsd: row.spent_usd as number,
    summary: (row.summary as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    parentId: (row.parent_id as string | null) ?? null,
    role: row.role as string,
    title: row.title as string,
    instructions: row.instructions as string,
    status: row.status as TaskStatus,
    dependsOn: parse<string[]>(row.depends_on_json as string, []),
    acceptanceCriteria: parse<string[]>(row.acceptance_json as string, []),
    branch: (row.branch as string | null) ?? null,
    report: parse<Report | null>(row.report_json as string | null, null),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

function rowToAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    role: row.role as string,
    name: row.name as string,
    model: row.model as string,
    state: row.state as AgentRecord["state"],
  };
}


function sessionFrom(row: Record<string, unknown>): import("@corpix/agents").AgentSessionRecord {
  return {
    runId: row.run_id as string,
    role: row.role as string,
    memory: (row.memory as string) ?? "",
    tasks: (row.tasks as number) ?? 0,
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    updatedAt: (row.updated_at as string) ?? "",
  };
}
