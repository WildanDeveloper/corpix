import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { api, formatUsd } from "./api";
import type {
  LimitSettings,
  PricingEntry,
  ProbeResult,
  ProviderName,
  ProviderSettings,
  RoleOverride,
  RolesView,
  SandboxInfo,
  SettingsView,
} from "./types";

type Draft = SettingsView["settings"];
type Section = "provider" | "models" | "limits" | "safety" | "team" | "git" | "pricing";

const emptyPricing: PricingEntry = { input: 0, output: 0, cached_input: 0 };

function isLocked(locked: string[], path: string): boolean {
  return locked.includes(path);
}

export function SettingsPanel(): ReactElement {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [roles, setRoles] = useState<RolesView | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [sandboxes, setSandboxes] = useState<SandboxInfo[]>([]);

  const load = useCallback(async () => {
    const [settingsView, rolesView, modelList, sandboxList] = await Promise.all([
      api<SettingsView>("/api/settings"),
      api<RolesView>("/api/roles"),
      api<{ models: string[] }>("/api/models").catch(() => ({ models: [] })),
      api<{ available: SandboxInfo[] }>("/api/sandbox").catch(() => ({ available: [] })),
    ]);
    setView(settingsView);
    setDraft(settingsView.settings);
    setRoles(rolesView);
    setModels(modelList.models);
    setSandboxes(sandboxList.available);
  }, []);

  useEffect(() => {
    void load().catch((error: Error) => setStatus({ kind: "error", text: error.message }));
  }, [load]);

  const locked = view?.locked ?? [];

  const update = <K extends Section>(section: K, patch: Partial<Draft[K]>): void => {
    setDraft((current) => {
      if (!current) return current;
      return { ...current, [section]: { ...current[section], ...patch } };
    });
  };

  const updateRole = (roleId: string, patch: RoleOverride): void => {
    setDraft((current) => {
      if (!current) return current;
      const existing = current.models.roles[roleId] ?? {};
      return {
        ...current,
        models: {
          ...current.models,
          roles: { ...current.models.roles, [roleId]: { ...existing, ...patch } },
        },
      };
    });
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setStatus({ kind: "idle", text: "" });
    try {
      const names = Object.fromEntries(
        Object.entries(draft.team.names)
          .map(([role, name]) => [role, name.trim()] as const)
          .filter(([, name]) => name.length > 0),
      );
      const next = await api<SettingsView>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          provider: draft.provider,
          models: draft.models,
          limits: draft.limits,
          safety: draft.safety,
          team: { company: draft.team.company, names },
          git: draft.git,
          pricing: draft.pricing,
        }),
      });
      setView(next);
      setDraft(next.settings);
      setStatus({ kind: "ok", text: "Settings saved. New runs use them immediately." });
      const refreshed = await api<RolesView>("/api/roles");
      setRoles(refreshed);
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (): Promise<void> => {
    if (apiKeyInput.trim().length === 0) return;
    setBusy(true);
    try {
      const next = await api<SettingsView>("/api/settings/api-key", {
        method: "PUT",
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      setView(next);
      setApiKeyInput("");
      setStatus({ kind: "ok", text: "API key stored outside the database." });
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await api<SettingsView>("/api/settings/api-key", { method: "DELETE" });
      setView(next);
      setStatus({ kind: "ok", text: "API key cleared." });
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api<ProbeResult>("/api/settings/test", {
        method: "POST",
        body: JSON.stringify({
          model: draft?.models.boss,
          patch: { provider: draft?.provider },
        }),
      });
      setProbe(result);
      if (result.models.length > 0) setModels(result.models);
      setStatus({
        kind: result.ok ? "ok" : "error",
        text: result.ok ? `Provider responded: ${result.detail}` : result.detail,
      });
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const knownModels = useMemo(() => {
    if (!draft) return models;
    const set = new Set([...models, draft.models.boss, draft.models.worker, draft.models.cheap]);
    for (const override of Object.values(draft.models.roles)) {
      if (override.model) set.add(override.model);
    }
    return [...set].filter((model) => model.length > 0);
  }, [models, draft]);

  if (!draft || !view) {
    const unauthorized = status.text === "UNAUTHORIZED";
    return (
      <section className="panel">
        <h2>Settings</h2>
        {unauthorized ? (
          <div className="auth-banner">
            <strong>Admin token required.</strong>
            <p>
              This server was started with <code>ADMIN_TOKEN</code>, so every API call
              needs it. Read the token and paste it into the <em>Admin token</em> field
              at the top right:
            </p>
            <pre>docker compose exec corpix cat /data/admin-token</pre>
            <p className="muted">
              Or open the page once with <code>?token=&lt;token&gt;</code> and it will be
              remembered in this browser.
            </p>
          </div>
        ) : (
          <p className="muted">{status.text || "Loading settings…"}</p>
        )}
      </section>
    );
  }

  const limitFields: Array<[keyof LimitSettings, string, string]> = [
    ["maxConcurrentAgents", "Max concurrent agents", "1–32"],
    ["maxStepsPerTask", "Max steps per task", "per agent loop"],
    ["contextTokens", "Context tokens per agent", "each agent gets its own"],
    ["taskTimeoutMinutes", "Task timeout (minutes)", "wall clock"],
    ["toolOutputMaxChars", "Tool output cap (chars)", "truncation"],
    ["maxOutputTokens", "Max output tokens", "per model call"],
    ["reviewRounds", "QA review rounds", "0 disables review"],
    ["budgetUsdPerGoal", "Budget per goal (USD)", "0 = unlimited"],
  ];

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Settings</h2>
        <div className="row">
          <button onClick={() => void test()} disabled={busy}>
            Test connection
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {status.text.length > 0 && <p className={`status ${status.kind}`}>{status.text}</p>}

      <fieldset>
        <legend>Provider</legend>
        <label>
          Provider
          <select
            value={draft.provider.name}
            disabled={isLocked(locked, "provider.name")}
            onChange={(event) =>
              update("provider", { name: event.target.value as ProviderName })
            }
          >
            <option value="mock">Mock (free, scripted)</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        <label>
          Base URL
          <input
            value={draft.provider.baseUrl}
            disabled={isLocked(locked, "provider.baseUrl")}
            onChange={(event) => update("provider", { baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label>
          Max tokens parameter
          <select
            value={draft.provider.maxTokensParam}
            disabled={isLocked(locked, "provider.maxTokensParam")}
            onChange={(event) =>
              update("provider", {
                maxTokensParam: event.target.value as "max_tokens" | "max_completion_tokens",
              })
            }
          >
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
          </select>
        </label>
        <label>
          Request timeout (ms)
          <input
            type="number"
            min={1000}
            value={draft.provider.requestTimeoutMs}
            onChange={(event) =>
              update("provider", { requestTimeoutMs: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Forced tool format
          <select
            value={draft.provider.toolChoiceStyle}
            disabled={isLocked(locked, "provider.toolChoiceStyle")}
            onChange={(event) =>
              update("provider", {
                toolChoiceStyle: event.target.value as ProviderSettings["toolChoiceStyle"],
              })
            }
          >
            <option value="auto">auto (detect, recommended)</option>
            <option value="object">object — OpenAI standard</option>
            <option value="name">name string — some gateways</option>
            <option value="required">required</option>
            <option value="none">none — rely on the prompt</option>
          </select>
        </label>
        <label>
          Prompt caching
          <select
            value={draft.provider.promptCaching}
            disabled={isLocked(locked, "provider.promptCaching")}
            onChange={(event) =>
              update("provider", {
                promptCaching: event.target.value as ProviderSettings["promptCaching"],
              })
            }
          >
            <option value="auto">auto — provider decides (recommended)</option>
            <option value="anthropic">explicit cache_control hints</option>
            <option value="off">off</option>
          </select>
        </label>
        <label>
          API key {view.apiKeySet ? <span className="badge">{view.apiKeyPreview}</span> : <span className="badge warn">not set</span>}
          <div className="row">
            <input
              type="password"
              value={apiKeyInput}
              placeholder={view.apiKeySet ? "Replace stored key" : "sk-…"}
              onChange={(event) => setApiKeyInput(event.target.value)}
              disabled={isLocked(locked, "provider.apiKey")}
            />
            <button onClick={() => void saveKey()} disabled={busy || apiKeyInput.trim() === ""}>
              Save key
            </button>
            <button
              onClick={() => void clearKey()}
              disabled={busy || !view.apiKeySet || isLocked(locked, "provider.apiKey")}
            >
              Clear
            </button>
          </div>
        </label>
        <p className="muted">
          The key is stored in <code>data/secrets.json</code> with mode 600, never in SQLite, and
          never sent back to the browser.
        </p>
      </fieldset>

      <fieldset>
        <legend>Models</legend>
        <label>
          Boss model
          <input
            list="known-models"
            value={draft.models.boss}
            disabled={isLocked(locked, "models.boss")}
            onChange={(event) => update("models", { boss: event.target.value })}
          />
        </label>
        <label>
          Worker model
          <input
            list="known-models"
            value={draft.models.worker}
            disabled={isLocked(locked, "models.worker")}
            onChange={(event) => update("models", { worker: event.target.value })}
          />
        </label>
        <label>
          Cheap model
          <input
            list="known-models"
            value={draft.models.cheap}
            disabled={isLocked(locked, "models.cheap")}
            onChange={(event) => update("models", { cheap: event.target.value })}
          />
        </label>
        <datalist id="known-models">
          {knownModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </fieldset>

      <fieldset>
        <legend>Team</legend>
        <label>
          Company name
          <input
            value={draft.team.company}
            maxLength={40}
            onChange={(event) => update("team", { company: event.target.value })}
          />
        </label>
        <p className="muted">
          Agent names are editable per role in the table below and apply to the office,
          prompts and the event log. Clear a field to fall back to the name in
          <code>config/team.default.yaml</code>.
        </p>
      </fieldset>

      <fieldset>
        <legend>Per-agent overrides</legend>
        <p className="muted">
          Leave a field empty to inherit the tier model and the role's YAML defaults.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Name</th>
              <th>Model</th>
              <th>Max steps</th>
              <th>Context tokens</th>
              <th>Temperature</th>
              <th>Effective</th>
            </tr>
          </thead>
          <tbody>
            {roles && (
              <>
                <RoleRow
                  name={roles.boss.name}
                  roleId={roles.boss.role.id}
                  effective={roles.boss.role}
                  override={draft.models.roles[roles.boss.role.id] ?? {}}
                  nameOverride={draft.team.names[roles.boss.role.id] ?? ""}
                  models={knownModels}
                  defaultContextTokens={draft.limits.contextTokens}
                  onChange={updateRole}
                  onName={(roleId, value) =>
                    setDraft((current) => current ? {
                      ...current,
                      team: { ...current.team, names: { ...current.team.names, [roleId]: value } },
                    } : current)
                  }
                />
                {roles.workers.map((worker) => (
                  <RoleRow
                    key={worker.role.id}
                    name={worker.name}
                    roleId={worker.role.id}
                    effective={worker.role}
                    override={draft.models.roles[worker.role.id] ?? {}}
                    nameOverride={draft.team.names[worker.role.id] ?? ""}
                    models={knownModels}
                    defaultContextTokens={draft.limits.contextTokens}
                    onChange={updateRole}
                    onName={(roleId, value) =>
                      setDraft((current) => current ? {
                        ...current,
                        team: { ...current.team, names: { ...current.team.names, [roleId]: value } },
                      } : current)
                    }
                  />
                ))}
              </>
            )}
          </tbody>
        </table>
      </fieldset>

      <fieldset>
        <legend>Limits</legend>
        <div className="grid-2">
          {limitFields.map(([key, label, hint]) => (
            <label key={key}>
              {label} <span className="muted">({hint})</span>
              <input
                type="number"
                min={0}
                step={key === "budgetUsdPerGoal" ? 0.5 : 1}
                value={draft.limits[key] as number}
                disabled={isLocked(locked, `limits.${key}`)}
                onChange={(event) =>
                  update("limits", { [key]: Number(event.target.value) } as Partial<LimitSettings>)
                }
              />
            </label>
          ))}
          <label>
            When the budget is hit
            <select
              value={draft.limits.budgetAction}
              disabled={isLocked(locked, "limits.budgetAction")}
              onChange={(event) =>
                update("limits", { budgetAction: event.target.value as "pause" | "stop" })
              }
            >
              <option value="pause">Pause the run</option>
              <option value="stop">Stop the run</option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Git isolation</legend>
        <label>
          <span className="row">
            <input
              type="checkbox"
              checked={draft.git.enabled}
              disabled={isLocked(locked, "git.enabled")}
              onChange={(event) => update("git", { enabled: event.target.checked })}
            />
            One worktree and branch per task
          </span>
        </label>
        <label>
          Integration branch
          <input
            value={draft.git.integrationBranch}
            disabled={isLocked(locked, "git.integrationBranch")}
            onChange={(event) => update("git", { integrationBranch: event.target.value })}
            placeholder="integration"
          />
        </label>
        <label>
          Worktrees directory (optional, absolute)
          <input
            value={draft.git.worktreesDir ?? ""}
            disabled={isLocked(locked, "git.worktreesDir")}
            onChange={(event) =>
              update("git", {
                worktreesDir: event.target.value === "" ? undefined : event.target.value,
              })
            }
            placeholder="<repo>.worktrees"
          />
        </label>
        <p className="muted">
          Each task gets its own branch cut from the integration branch. Results are merged
          automatically; conflicts are escalated, never guessed. Agents never push.
        </p>
      </fieldset>

      <fieldset>
        <legend>Safety</legend>
        <label>
          Approval mode
          <select
            value={draft.safety.approvalMode}
            disabled={isLocked(locked, "safety.approvalMode")}
            onChange={(event) =>
              update("safety", {
                approvalMode: event.target.value as "ask" | "auto-safe" | "auto",
              })
            }
          >
            <option value="ask">ask — approve every command</option>
            <option value="auto-safe">auto-safe — allow safe test/lint/build</option>
            <option value="auto">auto — approve everything allowed by policy</option>
          </select>
        </label>
        <label>
          Sandbox
          <select
            value={draft.safety.sandbox}
            disabled={isLocked(locked, "safety.sandbox")}
            onChange={(event) =>
              update("safety", {
                sandbox: event.target.value as "none" | "bwrap" | "docker",
              })
            }
          >
            <option value="none">none — policy and jail only</option>
            <option value="bwrap">bubblewrap — no daemon needed (recommended)</option>
            <option value="docker">docker — container per command</option>
          </select>
        </label>
        {sandboxes.length > 0 && (
          <ul className="muted sandbox-list">
            {sandboxes.map((entry) => (
              <li key={entry.kind}>
                <code>{entry.kind}</code>{" "}
                {entry.available ? (
                  <span className="ok">available</span>
                ) : (
                  <span className="warn">unavailable</span>
                )}{" "}
                — {entry.detail}
              </li>
            ))}
          </ul>
        )}
        {locked.length > 0 && (
          <p className="muted">
            Pinned by environment variables: <code>{locked.join(", ")}</code>
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Pricing (USD per million tokens)</legend>
        <p className="muted">
          Required for the budget guard and cost meter. Use 0 for local models.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cached input</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.entries(draft.pricing).map(([model, price]) => (
              <tr key={model}>
                <td>
                  <code>{model}</code>
                </td>
                {(["input", "output", "cached_input"] as const).map((field) => (
                  <td key={field}>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={price[field] ?? 0}
                      onChange={(event) =>
                        update("pricing", {
                          [model]: { ...price, [field]: Number(event.target.value) },
                        })
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    onClick={() => {
                      const next = { ...draft.pricing };
                      delete next[model];
                      setDraft({ ...draft, pricing: next });
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={() =>
            setDraft({
              ...draft,
              pricing: { ...draft.pricing, [draft.models.worker]: draft.pricing[draft.models.worker] ?? emptyPricing },
            })
          }
        >
          Add worker model price
        </button>
      </fieldset>

      {probe && (
        <p className="muted">
          Probe: {probe.ok ? "ok" : "failed"} — {probe.detail}
          {probe.models.length > 0 ? ` (${probe.models.length} models listed)` : ""}
        </p>
      )}

      <footer className="muted">
        Last saved: {view.settings.updatedAt ?? "never"} · Budget default {formatUsd(draft.limits.budgetUsdPerGoal)}
      </footer>
    </section>
  );
}

interface RoleRowProps {
  name: string;
  roleId: string;
  effective: { model: string; maxSteps: number; contextTokens?: number; temperature?: number };
  override: RoleOverride;
  nameOverride: string;
  models: string[];
  defaultContextTokens: number;
  onChange: (roleId: string, patch: RoleOverride) => void;
  onName: (roleId: string, value: string) => void;
}

function RoleRow({
  name,
  roleId,
  effective,
  override,
  nameOverride,
  models,
  defaultContextTokens,
  onChange,
  onName,
}: RoleRowProps): ReactElement {
  return (
    <tr>
      <td>
        <span className="muted">{roleId}</span>
      </td>
      <td>
        <input
          value={nameOverride}
          placeholder={name}
          maxLength={40}
          onChange={(event) => onName(roleId, event.target.value)}
        />
      </td>
      <td>
        <input
          list="known-models"
          placeholder={effective.model}
          value={override.model ?? ""}
          onChange={(event) =>
            onChange(roleId, { model: event.target.value === "" ? undefined : event.target.value })
          }
        />
      </td>
      <td>
        <input
          type="number"
          min={1}
          placeholder={String(effective.maxSteps)}
          value={override.maxSteps ?? ""}
          onChange={(event) =>
            onChange(roleId, {
              maxSteps: event.target.value === "" ? undefined : Number(event.target.value),
            })
          }
        />
      </td>
      <td>
        <input
          type="number"
          min={1000}
          step={1000}
          placeholder={
            effective.contextTokens !== undefined
              ? String(effective.contextTokens)
              : String(defaultContextTokens)
          }
          value={override.contextTokens ?? ""}
          onChange={(event) =>
            onChange(roleId, {
              contextTokens: event.target.value === "" ? undefined : Number(event.target.value),
            })
          }
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={2}
          step={0.1}
          placeholder={effective.temperature !== undefined ? String(effective.temperature) : "default"}
          value={override.temperature ?? ""}
          onChange={(event) =>
            onChange(roleId, {
              temperature: event.target.value === "" ? undefined : Number(event.target.value),
            })
          }
        />
      </td>
      <td className="muted">
        {effective.model} · {effective.maxSteps} steps ·{" "}
        {effective.contextTokens !== undefined
          ? `${effective.contextTokens} ctx`
          : `${defaultContextTokens} ctx (global)`}
      </td>
    </tr>
  );
}
