import path from "node:path";
import {
  SettingsService,
  applyRoleOverrides,
  createProviderFromSettings,
  envForRoles,
  loadTeam,
} from "@corpix/agents";
import { findRepoRoot, resolveDataDir, type Env } from "@corpix/shared";
import { openMigrated, SqliteStore } from "@corpix/server/db";

export interface RuntimeBundle {
  service: SettingsService;
  store: SqliteStore;
  env: Env;
  close: () => void;
}

export function openRuntime(env: Env): RuntimeBundle {
  const root = findRepoRoot();
  const dataDir = resolveDataDir(env.DATA_DIR, root);
  const store = new SqliteStore(
    openMigrated(path.join(dataDir, "corpix.sqlite")),
    path.join(dataDir, "secrets.json"),
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
    await loadTeam(path.join(findRepoRoot(), "config"), "team.default.yaml", envForRoles(bundle.env)),
    runtime.settings.models,
  );
  return {
    runtime,
    team,
    provider: createProviderFromSettings(runtime),
  };
}
