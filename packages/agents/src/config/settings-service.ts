import {
  AppSettingsSchema,
  SettingsPatchSchema,
  mergeSettings,
  modelForRole,
  resolveSettings,
  settingsFromEnv,
  type AppSettings,
  type Env,
  type ModelSettings,
  type RuntimeSettings,
  type SettingsPatch,
} from "@corpix/shared";
import type { LoadedTeam, TeamMember } from "../roles/loader";
import type { SettingsStore } from "../store/types";

/**
 * Loads settings from the database, seeds them from the environment on first
 * boot, and applies environment overrides on every read.
 */
export class SettingsService {
  constructor(
    private readonly store: SettingsStore,
    private readonly env: NodeJS.ProcessEnv,
    private readonly envDefaults: Env,
  ) {}

  load(): RuntimeSettings {
    return resolveSettings(this.stored(), this.store.readApiKey(), this.env);
  }

  save(patch: SettingsPatch): RuntimeSettings {
    // Merge into the *stored* settings, not the resolved view: environment
    // pins must never leak into the database.
    const locked = this.load().locked;
    const clean = stripPinned(patch, locked);
    const next = mergeSettings(this.stored(), SettingsPatchSchema.parse(clean));
    this.store.writeSettings(next);
    return this.load();
  }

  setApiKey(apiKey: string): RuntimeSettings {
    this.store.writeApiKey(apiKey.trim());
    return this.load();
  }

  hasStoredApiKey(): boolean {
    return this.store.readApiKey().length > 0;
  }

  /** Persisted settings only, without environment pins. */
  private stored(): AppSettings {
    const raw = this.store.readSettings();
    if (raw === null) {
      const seeded = settingsFromEnv(this.envDefaults);
      this.store.writeSettings(seeded);
      return seeded;
    }
    const parsed = AppSettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : settingsFromEnv(this.envDefaults);
  }
}

/**
 * Remove pinned paths from a patch so an API client cannot write a value the
 * deployment has pinned, which would resurface if the pin were removed later.
 */
export function stripPinned(patch: SettingsPatch, locked: readonly string[]): SettingsPatch {
  const clean = structuredClone(patch) as Record<string, Record<string, unknown> | undefined>;
  for (const path of locked) {
    if (path === "provider.apiKey") continue; // not part of the patch
    const [section, key] = path.split(".");
    if (!section || !key) continue;
    const bucket = clean[section];
    if (bucket && typeof bucket === "object") delete bucket[key];
  }
  return clean as SettingsPatch;
}

/**
 * Apply per-role model, step and temperature overrides. Returns a new team so an
 * in-flight run keeps the settings it started with.
 */
export function applyRoleOverrides(team: LoadedTeam, models: ModelSettings): LoadedTeam {
  const roles = new Map(team.roles);
  const apply = (member: TeamMember): TeamMember => {
    const override = models.roles[member.role.id];
    const role = {
      ...member.role,
      model: override?.model ?? modelForRole(member.role.id, models),
      maxSteps: override?.maxSteps ?? member.role.maxSteps,
      ...(override?.contextTokens !== undefined
        ? { contextTokens: override.contextTokens }
        : {}),
      ...(override?.temperature !== undefined ? { temperature: override.temperature } : {}),
    };
    roles.set(role.id, role);
    return { ...member, role };
  };

  return {
    ...team,
    boss: apply(team.boss),
    workers: team.workers.map(apply),
    roles,
  };
}

/** Cap every role's steps by the global limit. */
export function capTeamSteps(team: LoadedTeam, maxSteps: number): LoadedTeam {
  const roles = new Map(team.roles);
  const cap = (member: TeamMember): TeamMember => {
    const role = { ...member.role, maxSteps: Math.min(member.role.maxSteps, maxSteps) };
    roles.set(role.id, role);
    return { ...member, role };
  };
  return {
    ...team,
    boss: cap(team.boss),
    workers: team.workers.map(cap),
    roles,
  };
}
