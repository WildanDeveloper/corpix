import { promises as fs } from "node:fs";
import path from "node:path";
import {
  RoleSchema,
  TeamSchema,
  expandEnvRefs,
  type Role,
  type Team,
} from "@corpix/shared";
import YAML from "yaml";

export interface TeamMember {
  role: Role;
  name: string;
}

export interface LoadedTeam {
  team: Team;
  boss: TeamMember;
  workers: TeamMember[];
  roles: Map<string, Role>;
  configDir: string;
}

function substituteEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return expandEnvRefs(value, env);
  if (Array.isArray(value)) return value.map((item) => substituteEnv(item, env));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = substituteEnv(inner, env);
    return out;
  }
  return value;
}

export function envForRoles(env: {
  BOSS_MODEL: string;
  WORKER_MODEL: string;
  CHEAP_MODEL: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BOSS_MODEL: env.BOSS_MODEL,
    WORKER_MODEL: env.WORKER_MODEL,
    CHEAP_MODEL: env.CHEAP_MODEL,
  };
}

export async function loadRoleFile(file: string, env: NodeJS.ProcessEnv): Promise<Role> {
  const raw = await fs.readFile(file, "utf8");
  const parsed = YAML.parse(raw) as unknown;
  return RoleSchema.parse(substituteEnv(parsed, env));
}

export async function loadTeam(
  configDir: string,
  teamFile = "team.default.yaml",
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedTeam> {
  const teamPath = path.isAbsolute(teamFile) ? teamFile : path.join(configDir, teamFile);
  const team = TeamSchema.parse(YAML.parse(await fs.readFile(teamPath, "utf8")) as unknown);

  const roles = new Map<string, Role>();
  const load = async (roleId: string): Promise<Role> => {
    const cached = roles.get(roleId);
    if (cached) return cached;
    const role = await loadRoleFile(path.join(configDir, "roles", `${roleId}.yaml`), env);
    roles.set(roleId, role);
    return role;
  };

  const boss = { role: await load(team.boss.role), name: team.boss.name };
  const workers: TeamMember[] = [];
  for (const member of team.workers) {
    workers.push({ role: await load(member.role), name: member.name });
  }

  return { team, boss, workers, roles, configDir };
}

/** Fill `{{name}}`, `{{title}}`, `{{company}}`, `{{scope.write}}`, ... */
export function renderPrompt(
  template: string,
  vars: {
    name: string;
    title: string;
    company: string;
    workspace: string;
    role: Role;
    bossName: string;
    roles: readonly string[];
  },
): string {
  const values: Record<string, string> = {
    name: vars.name,
    title: vars.title,
    company: vars.company,
    workspace: vars.workspace,
    "scope.write": vars.role.scope.write.join(", ") || "(none)",
    "scope.read": vars.role.scope.read.join(", ") || "(none)",
    tools: vars.role.tools.join(", "),
    boss: vars.bossName,
    roles: vars.roles.join(", "),
  };
  return template.replace(/\{\{([a-z.]+)\}\}/gi, (match, key: string) => values[key] ?? match);
}

export async function writeDefaultConfig(dir: string): Promise<void> {
  const roles = [
    "boss",
    "frontend",
    "backend",
    "devops",
    "qa",
  ];
  await fs.mkdir(path.join(dir, "roles"), { recursive: true });
  for (const role of roles) {
    const source = path.join(process.cwd(), "config", "roles", `${role}.yaml`);
    const target = path.join(dir, "roles", `${role}.yaml`);
    await fs.copyFile(source, target).catch(() => undefined);
  }
}
