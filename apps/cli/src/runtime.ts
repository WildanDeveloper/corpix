import path from "node:path";
import {
  SettingsService,
  applyRoleOverrides,
  createProviderFromSettings,
  envForRoles,
  loadTeam,
} from "@corpix/agents";
import type { Env } from "@corpix/shared";
import { openMigrated, SqliteStore } from "@corpix/server/db";
import "dotenv/config";

export interface RuntimeBundle {
  service: SettingsService;
  store: SqliteStore;
  env: Env;
  close: () => void;
}

export function openRuntime(env: Env): RuntimeBundle {
  const store = new SqliteStore(
    openMigrated(path.join(env.DATA_DIR, "corpix.sqlite")),
    path.join(env.DATA_DIR, "secrets.json"),
  );
  return {
    service: new SettingsService(store, process.env, env),
    store,
    env,
    close: () => store.close(),
  };
}

export async function buildRunContext(bundle: RuntimeBundle) {
  const runtime = bundle.service.load();
  const team = applyRoleOverrides(
    await loadTeam(path.resolve("config"), "team.default.yaml", envForRoles(bundle.env)),
    runtime.settings.models,
  );
  return {
    runtime,
    team,
    provider: createProviderFromSettings(runtime),
  };
}
