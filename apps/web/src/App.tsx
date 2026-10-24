import { useEffect, useMemo, useState, type ReactElement } from "react";
import { api, formatUsd, wsUrl } from "./api";
import { SettingsPanel } from "./SettingsPanel";
import type { ApprovalRow, Project, RunEvent, RunRecord, UsageResponse } from "./types";

type Tab = "office" | "settings";

export function App(): ReactElement {
  const [tab, setTab] = useState<Tab>("office");
  return (
    <div className="app">
      <nav className="tabs">
        <strong>Corpix</strong>
        <button className={tab === "office" ? "active" : ""} onClick={() => setTab("office")}>
          Office
        </button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          Settings
        </button>
      </nav>
      <main>{tab === "settings" ? <SettingsPanel /> : <OfficePanel />}</main>
    </div>
  );
}

function OfficePanel(): ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const [projectList, runList] = await Promise.all([
        api<Project[]>("/api/projects"),
        api<RunRecord[]>("/api/runs"),
      ]);
      setProjects(projectList);
      setRuns(runList);
      if (projectList[0]) setProjectId(projectList[0].id);
    })().catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!runId) return;
    const socket = new WebSocket(wsUrl(`/ws?runId=${runId}`));
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as RunEvent;
      setEvents((current) => [...current.filter((item) => item.seq !== event.seq), event]);
      if (event.type === "usage.updated") {
        void api<UsageResponse>(`/api/usage?runId=${runId}`).then(setUsage).catch(() => undefined);
      }
      if (event.type === "approval.requested") {
        void api<ApprovalRow[]>(`/api/approvals?runId=${runId}&status=pending`).then(setApprovals).catch(() => undefined);
      }
    };
    return () => socket.close();
  }, [runId]);

  const dispatch = async (): Promise<void> => {
    setError("");
    setEvents([]);
    setUsage(null);
    try {
      const result = await api<{ runId: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ projectId, goal }),
      });
      setRunId(result.runId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const decide = async (approvalId: string, decision: "approve" | "deny"): Promise<void> => {
    await api(`/api/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    setApprovals((current) => current.filter((row) => row.id !== approvalId));
  };

  const spent = useMemo(() => usage?.totalUsd ?? 0, [usage]);

  return (
    <div className="office">
      <section className="panel">
        <header className="panel-header">
          <h2>Dispatch a goal</h2>
          <span className="badge">{formatUsd(spent)} spent</span>
        </header>
        <div className="row">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Select a project…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input
            value={goal}
            placeholder="Build a todo app with email login"
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && goal.length > 0) void dispatch();
            }}
          />
          <button className="primary" onClick={() => void dispatch()} disabled={goal.length === 0}>
            Dispatch
          </button>
        </div>
        {error.length > 0 && <p className="status error">{error}</p>}
        {projects.length === 0 && (
          <p className="muted">
            No projects yet. Register one with <code>POST /api/projects</code> or add a form here.
          </p>
        )}
      </section>

      {approvals.length > 0 && (
        <section className="panel">
          <h2>Approvals</h2>
          {approvals.map((approval) => (
            <div key={approval.id} className="approval">
              <code>{approval.agentId}</code> wants to run <code>{approval.summary}</code>
              <span className="badge warn">{approval.risk}</span>
              <button onClick={() => void decide(approval.id, "approve")}>Approve</button>
              <button onClick={() => void decide(approval.id, "deny")}>Deny</button>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <h2>Activity log</h2>
        <ol className="log">
          {events.map((event) => (
            <li key={event.seq}>
              <span className="muted">{event.seq}</span> <code>{event.type}</code>{" "}
              <span className="muted">{summarise(event)}</span>
            </li>
          ))}
          {events.length === 0 && <li className="muted">No events yet.</li>}
        </ol>
      </section>

      <section className="panel">
        <h2>Past runs</h2>
        <ul className="runs">
          {runs.map((run) => (
            <li key={run.id}>
              <code>{run.status}</code> {formatUsd(run.spentUsd)} — {run.goal.slice(0, 70)}
            </li>
          ))}
          {runs.length === 0 && <li className="muted">No runs yet.</li>}
        </ul>
      </section>
    </div>
  );
}

function summarise(event: RunEvent): string {
  const payload = event.payload;
  if (typeof payload.role === "string" && typeof payload.title === "string") {
    return `${payload.role}: ${payload.title}`;
  }
  if (typeof payload.tool === "string") return payload.tool;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.spentUsd === "number") return formatUsd(payload.spentUsd);
  return "";
}
