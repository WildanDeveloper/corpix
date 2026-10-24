import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { api, formatUsd } from "./api";
import { useI18n } from "./i18n";
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
type Section = "provider" | "models" | "limits" | "safety" | "mind" | "team" | "git" | "pricing";

const emptyPricing: PricingEntry = { input: 0, output: 0, cached_input: 0 };

/**
 * A server started before a field existed returns settings without it. Filling
 * the default here means an older API can never blank the whole page.
 */
function normalize(view: SettingsView): SettingsView {
  const settings = view.settings;
  return {
    ...view,
    settings: {
      ...settings,
      mind:
        settings.mind ?? {
          enabled: true,
          intervalSeconds: 14,
          model: "",
          maxTokens: 320,
          temperature: 0.95,
          maxTurns: 6,
          maxConcurrent: 2,
          memorySize: 8,
          allowOperatorChat: true,
          language: "auto" as const,
        },
      team: settings.team ?? { company: "Corpix", names: {} },
    },
  };
}

function isLocked(locked: string[], path: string): boolean {
  return locked.includes(path);
}

export function SettingsPanel(): ReactElement {
  const { t } = useI18n();
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
    const normalized = normalize(settingsView);
    setView(normalized);
    setDraft(normalized.settings);
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
          mind: draft.mind,
          team: { company: draft.team.company, names },
          git: draft.git,
          pricing: draft.pricing,
        }),
      });
      const normalized = normalize(next);
      setView(normalized);
      setDraft(normalized.settings);
      setStatus({ kind: "ok", text: t("Settings saved. New runs use them immediately.") });
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
      setStatus({ kind: "ok", text: t("API key stored outside the database.") });
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
      setStatus({ kind: "ok", text: t("API key cleared.") });
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
        <h2>{t("Settings")}</h2>
        {unauthorized ? (
          <div className="auth-banner">
            <strong>{t("Admin token required.")}</strong>
            <p>
              {t("This server was started with")} <code>ADMIN_TOKEN</code>
              {t(", so every API call needs it. Read the token and paste it into the")}{" "}
              <em>{t("Admin token")}</em>
              {t("field above, then press Enter.")}
            </p>
            <pre>docker compose exec corpix cat /data/admin-token</pre>
            <p className="muted">
              {t("Or open the page once with")} <code>?token=&lt;token&gt;</code>{" "}
              {t("and it will be remembered in this browser.")}
            </p>
          </div>
        ) : (
          <p className="muted">{status.text || t("Loading settings…")}</p>
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
        <h2>{t("Settings")}</h2>
        <div className="row">
          <button onClick={() => void test()} disabled={busy}>
            {t("Test connection")}
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? t("Saving…") : t("Save")}
          </button>
        </div>
      </header>

      {status.text.length > 0 && <p className={`status ${status.kind}`}>{status.text}</p>}

      <fieldset>
        <legend>{t("Provider")}</legend>
        <label>
          {t("Provider")}
          <select
            value={draft.provider.name}
            disabled={isLocked(locked, "provider.name")}
            onChange={(event) =>
              update("provider", { name: event.target.value as ProviderName })
            }
          >
            <option value="mock">{t("Mock (free, scripted)")}</option>
            <option value="openai-compatible">{t("OpenAI-compatible")}</option>
          </select>
        </label>
        <label>
          {t("Base URL")}
          <input
            value={draft.provider.baseUrl}
            disabled={isLocked(locked, "provider.baseUrl")}
            onChange={(event) => update("provider", { baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label>
          {t("Max tokens parameter")}
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
          {t("Request timeout (ms)")}
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
          {t("Forced tool format")}
          <select
            value={draft.provider.toolChoiceStyle}
            disabled={isLocked(locked, "provider.toolChoiceStyle")}
            onChange={(event) =>
              update("provider", {
                toolChoiceStyle: event.target.value as ProviderSettings["toolChoiceStyle"],
              })
            }
          >
            <option value="auto">{t("auto (detect, recommended)")}</option>
            <option value="object">{t("object — OpenAI standard")}</option>
            <option value="name">{t("name string — some gateways")}</option>
            <option value="required">{t("required")}</option>
            <option value="none">{t("none — rely on the prompt")}</option>
          </select>
        </label>
        <label>
          {t("Prompt caching")}
          <select
            value={draft.provider.promptCaching}
            disabled={isLocked(locked, "provider.promptCaching")}
            onChange={(event) =>
              update("provider", {
                promptCaching: event.target.value as ProviderSettings["promptCaching"],
              })
            }
          >
            <option value="auto">{t("auto — provider decides (recommended)")}</option>
            <option value="anthropic">{t("explicit cache_control hints")}</option>
            <option value="off">{t("off")}</option>
          </select>
        </label>
        <label>
          API key {view.apiKeySet ? <span className="badge">{view.apiKeyPreview}</span> : <span className="badge warn">{t("not set")}</span>}
          <div className="row">
            <input
              type="password"
              value={apiKeyInput}
              placeholder={view.apiKeySet ? t("Replace stored key") : "sk-…"}
              onChange={(event) => setApiKeyInput(event.target.value)}
              disabled={isLocked(locked, "provider.apiKey")}
            />
            <button onClick={() => void saveKey()} disabled={busy || apiKeyInput.trim() === ""}>
              {t("Save key")}
            </button>
            <button
              onClick={() => void clearKey()}
              disabled={busy || !view.apiKeySet || isLocked(locked, "provider.apiKey")}
            >
              {t("Clear")}
            </button>
          </div>
        </label>
        <p className="muted">
          {t(
            "The key is stored in data/secrets.json with mode 600, never in SQLite, and never sent back to the browser.",
          )}
        </p>
      </fieldset>

      <fieldset>
        <legend>{t("Models")}</legend>
        <label>
          {t("Boss model")}
          <input
            list="known-models"
            value={draft.models.boss}
            disabled={isLocked(locked, "models.boss")}
            onChange={(event) => update("models", { boss: event.target.value })}
          />
        </label>
        <label>
          {t("Worker model")}
          <input
            list="known-models"
            value={draft.models.worker}
            disabled={isLocked(locked, "models.worker")}
            onChange={(event) => update("models", { worker: event.target.value })}
          />
        </label>
        <label>
          {t("Cheap model")}
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
        <legend>{t("Mind")}</legend>
        <label>
          {t("Let agents think for themselves")}
          <select
            value={draft.mind.enabled ? "on" : "off"}
            onChange={(event) => update("mind", { enabled: event.target.value === "on" })}
          >
            <option value="on">{t("on — each agent runs its own model turn")}</option>
            <option value="off">{t("off — agents sit still, no model calls, no cost")}</option>
          </select>
        </label>
        <div className="grid">
          <label>
            {t("Seconds between decisions")}
            <input
              type="number"
              min={3}
              max={600}
              value={draft.mind.intervalSeconds}
              onChange={(event) => update("mind", { intervalSeconds: Number(event.target.value) })}
            />
          </label>
          <label>
            {t("Agents thinking at once")}
            <input
              type="number"
              min={1}
              max={8}
              value={draft.mind.maxConcurrent}
              onChange={(event) => update("mind", { maxConcurrent: Number(event.target.value) })}
            />
          </label>
          <label>
            {t("Max output tokens per thought")}
            <input
              type="number"
              min={64}
              max={4096}
              value={draft.mind.maxTokens}
              onChange={(event) => update("mind", { maxTokens: Number(event.target.value) })}
            />
          </label>
          <label>
            {t("Temperature")}
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={draft.mind.temperature}
              onChange={(event) => update("mind", { temperature: Number(event.target.value) })}
            />
          </label>
          <label>
            {t("Turns per conversation")}
            <input
              type="number"
              min={2}
              max={12}
              value={draft.mind.maxTurns}
              onChange={(event) => update("mind", { maxTurns: Number(event.target.value) })}
            />
          </label>
          <label>
            {t("Memories per agent")}
            <input
              type="number"
              min={0}
              max={24}
              value={draft.mind.memorySize}
              onChange={(event) => update("mind", { memorySize: Number(event.target.value) })}
            />
          </label>
        </div>
        <label>
          {t("Agent language")}
          <select
            value={draft.mind.language}
            onChange={(event) =>
              update("mind", { language: event.target.value as "auto" | "id" | "en" })
            }
          >
            <option value="auto">{t("auto — follow the office")}</option>
            <option value="id">Bahasa Indonesia</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          {t("Mind model")}
          <input
            value={draft.mind.model}
            placeholder={draft.models.cheap}
            onChange={(event) => update("mind", { model: event.target.value })}
          />
        </label>
        <p className="muted">
          {t(
            "Each agent gets its own turn with the real goal, its colleagues, its mood and its memories, and decides what to do. Thoughts, moods and opinions are never generated by Corpix — only stored and rendered. Leave the model empty to use the cheap model.",
          )}
        </p>
      </fieldset>

      <fieldset>
        <legend>{t("Team")}</legend>
        <label>
          {t("Company name")}
          <input
            value={draft.team.company}
            maxLength={40}
            onChange={(event) => update("team", { company: event.target.value })}
          />
        </label>
        <p className="muted">
          {t(
            "Agent names are editable per role in the table below and apply to the office, prompts and the event log. Clear a field to fall back to the name in",
          )}{" "}
          <code>config/team.default.yaml</code>.
        </p>
      </fieldset>

      <fieldset>
        <legend>{t("Per-agent overrides")}</legend>
        <p className="muted">
          {t("Leave empty to inherit the tier model and the role's YAML defaults.")}
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>{t("Agent")}</th>
              <th>{t("Name")}</th>
              <th>{t("Model")}</th>
              <th>{t("Max steps")}</th>
              <th>{t("Context tokens")}</th>
              <th>{t("Temperature")}</th>
              <th>{t("Effective")}</th>
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
        <legend>{t("Limits")}</legend>
        <div className="grid-2">
          {limitFields.map(([key, label, hint]) => (
            <label key={key}>
              {t(label)} <span className="muted">({t(hint)})</span>
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
            {t("When the budget is hit")}
            <select
              value={draft.limits.budgetAction}
              disabled={isLocked(locked, "limits.budgetAction")}
              onChange={(event) =>
                update("limits", { budgetAction: event.target.value as "pause" | "stop" })
              }
            >
              <option value="pause">{t("Pause the run")}</option>
              <option value="stop">{t("Stop the run")}</option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t("Git isolation")}</legend>
        <label>
          <span className="row">
            <input
              type="checkbox"
              checked={draft.git.enabled}
              disabled={isLocked(locked, "git.enabled")}
              onChange={(event) => update("git", { enabled: event.target.checked })}
            />
            {t("One worktree and branch per task")}
          </span>
        </label>
        <label>
          {t("Integration branch")}
          <input
            value={draft.git.integrationBranch}
            disabled={isLocked(locked, "git.integrationBranch")}
            onChange={(event) => update("git", { integrationBranch: event.target.value })}
            placeholder="integration"
          />
        </label>
        <label>
          {t("Worktrees directory (optional, absolute)")}
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
          {t(
            "Each task gets its own branch cut from the integration branch. Results are merged automatically; conflicts are escalated, never guessed. Agents never push.",
          )}
        </p>
      </fieldset>

      <fieldset>
        <legend>{t("Safety")}</legend>
        <label>
          {t("Approval mode")}
          <select
            value={draft.safety.approvalMode}
            disabled={isLocked(locked, "safety.approvalMode")}
            onChange={(event) =>
              update("safety", {
                approvalMode: event.target.value as "ask" | "auto-safe" | "auto",
              })
            }
          >
            <option value="ask">{t("ask — approve every command")}</option>
            <option value="auto-safe">{t("auto-safe — allowlisted tests and builds")}</option>
            <option value="auto">{t("auto — approve everything except hard denials")}</option>
          </select>
        </label>
        <label>
          {t("Sandbox")}
          <select
            value={draft.safety.sandbox}
            disabled={isLocked(locked, "safety.sandbox")}
            onChange={(event) =>
              update("safety", {
                sandbox: event.target.value as "none" | "bwrap" | "docker",
              })
            }
          >
            <option value="none">{t("none — policy and jail only")}</option>
            <option value="bwrap">{t("bubblewrap — no daemon needed (recommended)")}</option>
            <option value="docker">{t("docker — container per command")}</option>
          </select>
        </label>
        {sandboxes.length > 0 && (
          <ul className="muted sandbox-list">
            {sandboxes.map((entry) => (
              <li key={entry.kind}>
                <code>{entry.kind}</code>{" "}
                {entry.available ? (
                  <span className="ok">{t("available")}</span>
                ) : (
                  <span className="warn">{t("unavailable")}</span>
                )}{" "}
                — {entry.detail}
              </li>
            ))}
          </ul>
        )}
        {locked.length > 0 && (
          <p className="muted">
            {t("Pinned by environment variables:")} <code>{locked.join(", ")}</code>
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>{t("Pricing (USD per million tokens)")}</legend>
        <p className="muted">
          {t("Required for the budget guard and cost meter. Use 0 for local models.")}
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>{t("Model")}</th>
              <th>{t("Input")}</th>
              <th>{t("Output")}</th>
              <th>{t("Cached input")}</th>
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
          {t("Add worker model price")}
        </button>
      </fieldset>

      {probe && (
        <p className="muted">
          {t("Probe:")} {probe.ok ? t("ok") : t("failed")} — {probe.detail}
          {probe.models.length > 0 ? ` (${probe.models.length} models listed)` : ""}
        </p>
      )}

      <footer className="muted">
        {t("Last saved:")} {view.settings.updatedAt ?? t("never")} ·{" "}
        {t("Budget default")} {formatUsd(draft.limits.budgetUsdPerGoal)}
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
