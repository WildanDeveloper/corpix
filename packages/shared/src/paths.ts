import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Walk up until we find the repository that contains `config/team.default.yaml`.
 * `pnpm --filter @corpix/server dev` runs with cwd=apps/server, so relying on
 * process.cwd() alone breaks config and data paths.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "config", "team.default.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function repoPath(...segments: string[]): string {
  return path.join(findRepoRoot(), ...segments);
}

export function resolveDataDir(dataDir: string, root: string = findRepoRoot()): string {
  return path.isAbsolute(dataDir) ? dataDir : path.resolve(root, dataDir);
}

/**
 * True when a path lives in a temporary directory. The OS wipes those on
 * reboot, so a database there loses projects, runs, settings and API keys.
 */
export function isTemporaryDir(target: string): boolean {
  const normalised = path.resolve(target);
  return /^\/(tmp|var\/tmp)(\/|$)/.test(normalised);
}
