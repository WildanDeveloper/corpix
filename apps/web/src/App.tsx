import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api, formatUsd, getToken, setToken, wsUrl } from "./api";
import { LanguageSwitch, useI18n } from "./i18n";
import { MindPanel } from "./MindPanel";
import { SettingsPanel } from "./SettingsPanel";
import { OfficeCanvas } from "./office/OfficeCanvas";
import type { ApprovalRow, Project, RolesView, RunEvent, RunRecord, UsageResponse } from "./types";

type Tab = "office" | "minds" | "settings";

export function App(): ReactElement {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("office");
  const [token, setTokenState] = useState(getToken());
  const [authRequired, setAuthRequired] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);

  // `?token=...` makes the first login painless; the token is stored locally and
  // removed from the address bar so it does not linger in history.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("token");
    if (!fromUrl) return;
    setTokenState(fromUrl);
    setToken(fromUrl);
    params.delete("token");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);

  useEffect(() => {
    void fetch("/api/health")
      .then((response) => response.json())
      .then((health: { authRequired?: boolean }) => setAuthRequired(Boolean(health.authRequired)))
      .catch(() => undefined);
  }, []);

  const needsToken = authRequired && token.trim().length === 0;

  return (
    <div className="app">
      <nav className="tabs">
        <strong>Corpix</strong>
        <button className={tab === "office" ? "active" : ""} onClick={() => setTab("office")}>
          {t("Office")}
        </button>
        <button className={tab === "minds" ? "active" : ""} onClick={() => setTab("minds")}>
          {t("Minds")}
        </button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          {t("Settings")}
        </button>
        <LanguageSwitch />
        <label
          className="token"
          title={t("Required only when ADMIN_TOKEN is set on the server")}
        >
          {t("Admin token")}
          <input
            ref={tokenInput}
            type="password"
            value={token}
            placeholder={t("optional")}
            onChange={(event) => {
              setTokenState(event.target.value);
              setToken(event.target.value);
            }}
          />
        </label>
      </nav>
      {needsToken && (
        <div className="auth-banner">
          <strong>{t("This server requires an admin token.")}</strong> {t("Paste the token from")}
          <code>docker compose exec corpix cat /data/admin-token</code>
          {t("into the")}
          <em>{t("Admin token")}</em> {t("field above, then press Enter.")}
          <button className="inline" onClick={() => tokenInput.current?.focus()}>
            {t("Focus field")}
          </button>
        </div>
      )}
      <main>
        {tab === "settings" ? (
          <SettingsPanel key={token} />
        ) : tab === "minds" ? (
          <MindPanel key={token} />
        ) : (
          <OfficePanel key={token} />
        )}
      </main>
    </div>
  );
}

function OfficePanel(): ReactElement {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState("");
  const [newProject, setNewProject] = useState({ name: "", repoPath: "" });
  const [roleNames, setRoleNames] = useState<Record<string, string>>({});
  const lastSeq = useRef(0);

  // Names come from the team, not the event payload, so the office can label
  // agents the moment they appear.
  useEffect(() => {
    void api<RolesView>("/api/roles")
      .then((roles) => {
        const names: Record<string, string> = { [roles.boss.role.id]: roles.boss.name };
        for (const worker of roles.workers) names[worker.role.id] = worker.name;
        setRoleNames(names);
      })
      .catch(() => undefined);
  }, []);

  // Refreshing is used after a run finishes and after registering a project.
  const refresh = async (): Promise<void> => {
    const [projectList, runList] = await Promise.all([
      api<Project[]>("/api/projects"),
      api<RunRecord[]>("/api/runs"),
    ]);
    setProjects(projectList);
    setRuns(runList);
    if (projectList[0] && !projectId) setProjectId(projectList[0].id);
  };

  useEffect(() => {
    void (async () => {
      const [projectList, runList] = await Promise.all([
        api<Project[]>("/api/projects"),
        api<RunRecord[]>("/api/runs"),
      ]);
      setProjects(projectList);
      setRuns(runList);
      if (projectList[0] && !projectId) setProjectId(projectList[0].id);

      // Open on the most recent run instead of an empty office, even when that
      // run was started from the CLI or another browser tab.
      const latest = runList[0];
      if (!latest) return;
      const history = await api<RunEvent[]>(`/api/runs/${latest.id}/events`).catch(
        () => [] as RunEvent[],
      );
      lastSeq.current = history.at(-1)?.seq ?? 0;
      setEvents(history);
      setRunId(latest.id);
      void api<UsageResponse>(`/api/usage?runId=${latest.id}`).then(setUsage).catch(() => undefined);
    })().catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live events with `since` resume and a simple reconnect loop.
  useEffect(() => {
    if (!runId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      socket = new WebSocket(wsUrl(`/ws?runId=${runId}&since=${lastSeq.current}`));
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as RunEvent;
        if (event.seq <= lastSeq.current) return;
        lastSeq.current = event.seq;
        setEvents((current) => [...current, event].slice(-500));
        if (event.type === "usage.updated") {
          void api<UsageResponse>(`/api/usage?runId=${runId}`).then(setUsage).catch(() => undefined);
        }
        if (event.type === "approval.requested") {
          void api<ApprovalRow[]>(`/api/approvals?runId=${runId}&status=pending`)
            .then(setApprovals)
            .catch(() => undefined);
        }
        if (event.type === "run.finished" || event.type === "run.failed" || event.type === "run.paused") {
          void refresh().catch(() => undefined);
        }
      };
      socket.onclose = () => {
        if (closed) return;
        retry = setTimeout(connect, 1200);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const registerProject = async (): Promise<void> => {
    setError("");
    try {
      const project = await api<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify(newProject),
      });
      setNewProject({ name: "", repoPath: "" });
      setProjectId(project.id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const dispatch = async (): Promise<void> => {
    setError("");
    setEvents([]);
    setUsage(null);
    lastSeq.current = 0;
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

  const cancel = async (): Promise<void> => {
    if (!runId) return;
    await api(`/api/runs/${runId}/cancel`, { method: "POST" }).catch((err: Error) =>
      setError(err.message),
    );
  };

  const resume = async (run: RunRecord): Promise<void> => {
    setError("");
    setEvents([]);
    lastSeq.current = 0;
    let budgetUsd = run.budgetUsd;
    if (run.status === "paused") {
      const answer = window.prompt(
        t("This run paused on its budget. New budget in USD:"),
        String((run.budgetUsd * 2).toFixed(2)),
      );
      if (answer === null) return;
      const parsed = Number(answer);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError(t("Budget must be a positive number."));
        return;
      }
      budgetUsd = parsed;
    }
    try {
      const result = await api<{ runId: string }>(`/api/runs/${run.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ budgetUsd }),
      });
      setRunId(result.runId);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const spent = useMemo(() => usage?.totalUsd ?? 0, [usage]);

  // Derive what the team is working on, so office chatter references real work.
  const officeContext = useMemo(() => {
    const goal = events.find((event) => event.type === "run.started")?.payload.goal;
    const tasks: string[] = [];
    const files: string[] = [];
    for (const event of events) {
      if (event.type === "task.created" && typeof event.payload.title === "string") {
        tasks.push(event.payload.title);
      }
      if (event.type === "tool.called" && event.payload.tool === "write_file") {
        const input = event.payload.input as { path?: unknown } | undefined;
        if (typeof input?.path === "string") files.push(input.path);
      }
    }
    return {
      goal: typeof goal === "string" ? goal : undefined,
      tasks: tasks.slice(-6),
      files: files.slice(-6),
    };
  }, [events]);

  return (
    <div className="office">
      <section className="panel office-panel">
        <header className="panel-header">
          <h2>{t("Office")}</h2>
          <span className="badge">{runId ?? t("idle")}</span>
        </header>
        <OfficeCanvas
          runId={runId}
          events={events}
          roleNames={roleNames}
          context={officeContext}
        />
      </section>

      <section className="panel">
        <header className="panel-header">
          <h2>{t("Dispatch a goal")}</h2>
          <span className="badge">
            {formatUsd(spent)} {t("spent")}
            {usage && usage.cacheHitRate > 0
              ? ` · ${(usage.cacheHitRate * 100).toFixed(0)}% ${t("cached")}`
              : ""}
          </span>
        </header>
        <div className="row">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">{t("Select a project…")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input
            value={goal}
            placeholder={t("Build a todo app with email login")}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && goal.length > 0) void dispatch();
            }}
          />
          <button className="primary" onClick={() => void dispatch()} disabled={goal.length === 0}>
            {t("Dispatch")}
          </button>
          {runId && (
            <button onClick={() => void cancel()}>{t("Cancel")}</button>
          )}        </div>
        {error.length > 0 && <p className="status error">{error}</p>}

        {projects.length === 0 && (
          <fieldset>
            <legend>{t("Register your first project")}</legend>
            <div className="row">
              <input
                placeholder={t("Name")}
                value={newProject.name}
                onChange={(event) => setNewProject({ ...newProject, name: event.target.value })}
              />
              <input
                placeholder={t("/absolute/path/to/repo")}
                value={newProject.repoPath}
                onChange={(event) => setNewProject({ ...newProject, repoPath: event.target.value })}
              />
              <button
                onClick={() => void registerProject()}
                disabled={newProject.name === "" || newProject.repoPath === ""}
              >
                {t("Register")}
              </button>
            </div>
          </fieldset>
        )}
      </section>

      {approvals.length > 0 && (
        <section className="panel">
          <h2>{t("Approvals")}</h2>
          {approvals.map((approval) => (
            <div key={approval.id} className="approval">
              <code>{approval.agentId}</code> {t("wants to run")} <code>{approval.summary}</code>
              <span className="badge warn">{approval.risk}</span>
              <button onClick={() => void decide(approval.id, "approve")}>{t("Approve")}</button>
              <button onClick={() => void decide(approval.id, "deny")}>{t("Deny")}</button>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <h2>{t("Activity log")}</h2>
        <ol className="log">
          {events.map((event) => (
            <li key={event.seq}>
              <span className="muted">{event.seq}</span> <code>{event.type}</code>{" "}
              <span className="muted">{summarise(event)}</span>
            </li>
          ))}
          {events.length === 0 && <li className="muted">{t("No events yet.")}</li>}
        </ol>
      </section>

      <section className="panel">
        <h2>{t("Past runs")}</h2>
        <ul className="runs">
          {runs.map((run) => (
            <li key={run.id}>
              <code>{run.status}</code> {formatUsd(run.spentUsd)} — {run.goal.slice(0, 70)}
              {run.status !== "completed" && (
                <button
                  className="inline"
                  onClick={() => void resume(run)}
                  title={t("Continue this run where it stopped")}
                >
                  {t("Resume")}
                </button>
              )}
            </li>
          ))}
          {runs.length === 0 && <li className="muted">{t("No runs yet.")}</li>}
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
