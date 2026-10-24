import type {
  AgentState,
  EventEnvelope,
  Plan,
  Report,
  RunStatus,
  TaskStatus,
  Usage,
} from "@corpix/shared";

export interface ProjectRecord {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  goal: string;
  status: RunStatus;
  plan: Plan | null;
  budgetUsd: number;
  spentUsd: number;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
}

export interface TaskRecord {
  id: string;
  runId: string;
  parentId: string | null;
  role: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  dependsOn: string[];
  acceptanceCriteria: string[];
  branch: string | null;
  report: Report | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentRecord {
  id: string;
  runId: string;
  role: string;
  name: string;
  model: string;
  state: AgentState;
}

export interface UsageRecordRow {
  runId: string;
  taskId: string;
  agentId: string;
  model: string;
  usage: Usage;
  costUsd: number;
  ts: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  agentId: string;
  tool: string;
  input: unknown;
  risk: string;
  status: "pending" | "approved" | "denied";
  summary: string;
  decidedAt: string | null;
}

/**
 * One agent's own session. Unlike a task transcript, it survives from task to
 * task inside a run: the backend who did the API remembers doing it when the
 * next task for the same role starts.
 */
export interface AgentSessionRecord {
  runId: string;
  role: string;
  /** Compact, first-person notes from previous tasks. */
  memory: string;
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  updatedAt: string;
}

export interface MessageRow {
  taskId: string;
  agentId: string;
  idx: number;
  role: string;
  content: unknown;
}

export interface SettingsStore {
  /** Persisted settings JSON, or null on first boot. */
  readSettings(): unknown | null;
  writeSettings(settings: unknown): void;
  /** The API key is kept outside the database in production. */
  readApiKey(): string;
  writeApiKey(apiKey: string): void;
}

/**
 * Storage contract. The SQLite implementation lives in the server; tests use
 * an in-memory implementation so the runtime stays dependency-free.
 */
export interface Store {
  createProject(project: ProjectRecord): void;
  getProject(id: string): ProjectRecord | null;
  listProjects(): ProjectRecord[];

  createRun(run: RunRecord): void;
  updateRun(id: string, patch: Partial<RunRecord>): void;
  getRun(id: string): RunRecord | null;
  listRuns(): RunRecord[];

  createTask(task: TaskRecord): void;
  updateTask(id: string, patch: Partial<TaskRecord>): void;
  getTask(id: string): TaskRecord | null;
  listTasks(runId: string): TaskRecord[];

  createAgent(agent: AgentRecord): void;
  updateAgent(id: string, patch: Partial<AgentRecord>): void;
  listAgents(runId: string): AgentRecord[];

  appendEvent(runId: string, type: string, payload: unknown): EventEnvelope;
  listEvents(runId: string, sinceSeq?: number): EventEnvelope[];

  recordUsage(row: UsageRecordRow): void;
  listUsage(runId: string): UsageRecordRow[];

  createApproval(approval: ApprovalRecord): void;
  resolveApproval(id: string, status: "approved" | "denied"): void;
  listApprovals(runId: string, status?: ApprovalRecord["status"]): ApprovalRecord[];

  appendMessage(row: MessageRow): void;
  listMessages(taskId: string): MessageRow[];

  readAgentSession(runId: string, role: string): AgentSessionRecord | null;
  writeAgentSession(row: AgentSessionRecord): void;
  listAgentSessions(runId: string): AgentSessionRecord[];

  readSettings(): unknown | null;
  writeSettings(settings: unknown): void;
  readApiKey(): string;
  writeApiKey(apiKey: string): void;

  close(): void;
}

/** In-memory store for tests and `--dry-run` runs. */
export class MemoryStore implements Store {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly usage: UsageRecordRow[] = [];
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly messages: MessageRow[] = [];
  private readonly sessions = new Map<string, AgentSessionRecord>();

  createProject(project: ProjectRecord): void {
    this.projects.set(project.id, { ...project });
  }

  getProject(id: string): ProjectRecord | null {
    return this.projects.get(id) ?? null;
  }

  listProjects(): ProjectRecord[] {
    return [...this.projects.values()];
  }

  createRun(run: RunRecord): void {
    this.runs.set(run.id, { ...run });
  }

  updateRun(id: string, patch: Partial<RunRecord>): void {
    const run = this.runs.get(id);
    if (run) this.runs.set(id, { ...run, ...patch });
  }

  getRun(id: string): RunRecord | null {
    return this.runs.get(id) ?? null;
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  createTask(task: TaskRecord): void {
    this.tasks.set(task.id, { ...task });
  }

  updateTask(id: string, patch: Partial<TaskRecord>): void {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, { ...task, ...patch });
  }

  getTask(id: string): TaskRecord | null {
    return this.tasks.get(id) ?? null;
  }

  listTasks(runId: string): TaskRecord[] {
    return [...this.tasks.values()].filter((task) => task.runId === runId);
  }

  createAgent(agent: AgentRecord): void {
    this.agents.set(agent.id, { ...agent });
  }

  updateAgent(id: string, patch: Partial<AgentRecord>): void {
    const agent = this.agents.get(id);
    if (agent) this.agents.set(id, { ...agent, ...patch });
  }

  listAgents(runId: string): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => agent.runId === runId);
  }

  appendEvent(runId: string, type: string, payload: unknown): EventEnvelope {
    const list = this.events.get(runId) ?? [];
    const envelope: EventEnvelope = {
      seq: list.length + 1,
      ts: new Date().toISOString(),
      runId,
      type: type as EventEnvelope["type"],
      payload: payload as Record<string, unknown>,
    };
    list.push(envelope);
    this.events.set(runId, list);
    return envelope;
  }

  listEvents(runId: string, sinceSeq = 0): EventEnvelope[] {
    return (this.events.get(runId) ?? []).filter((event) => event.seq > sinceSeq);
  }

  recordUsage(row: UsageRecordRow): void {
    this.usage.push(row);
  }

  listUsage(runId: string): UsageRecordRow[] {
    return this.usage.filter((row) => row.runId === runId);
  }

  createApproval(approval: ApprovalRecord): void {
    this.approvals.set(approval.id, { ...approval });
  }

  resolveApproval(id: string, status: "approved" | "denied"): void {
    const approval = this.approvals.get(id);
    if (approval) {
      this.approvals.set(id, { ...approval, status, decidedAt: new Date().toISOString() });
    }
  }

  listApprovals(runId: string, status?: ApprovalRecord["status"]): ApprovalRecord[] {
    return [...this.approvals.values()].filter(
      (approval) => approval.runId === runId && (status === undefined || approval.status === status),
    );
  }

  readAgentSession(runId: string, role: string): AgentSessionRecord | null {
    return this.sessions.get(`${runId}:${role}`) ?? null;
  }

  writeAgentSession(row: AgentSessionRecord): void {
    this.sessions.set(`${row.runId}:${row.role}`, { ...row });
  }

  listAgentSessions(runId: string): AgentSessionRecord[] {
    return [...this.sessions.values()].filter((row) => row.runId === runId);
  }

  appendMessage(row: MessageRow): void {
    this.messages.push({ ...row });
  }

  listMessages(taskId: string): MessageRow[] {
    return this.messages.filter((row) => row.taskId === taskId).sort((a, b) => a.idx - b.idx);
  }

  private settings: unknown | null = null;
  private apiKey = "";

  readSettings(): unknown | null {
    return this.settings;
  }

  writeSettings(settings: unknown): void {
    this.settings = settings;
  }

  readApiKey(): string {
    return this.apiKey;
  }

  writeApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  close(): void {
    // nothing to release
  }
}
