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
    const raw = this.store.readSettings();
    let stored: AppSettings;
    if (raw === null) {
      stored = settingsFromEnv(this.envDefaults);
      this.store.writeSettings(stored);
    } else {
      const parsed = AppSettingsSchema.safeParse(raw);
      stored = parsed.success ? parsed.data : settingsFromEnv(this.envDefaults);
    }
    return resolveSettings(stored, this.store.readApiKey(), this.env);
  }

  save(patch: SettingsPatch): RuntimeSettings {
    const current = this.load().settings;
    const valid = SettingsPatchSchema.parse(patch);
    const next = mergeSettings(current, valid);
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
