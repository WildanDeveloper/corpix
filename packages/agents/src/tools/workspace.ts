import { promises as fs } from "node:fs";
import path from "node:path";
import { ScopeError } from "@corpix/shared";

/** Files that are never readable or writable, regardless of scope. */
const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.git\/config$/i,
];

const GIT_DIR = /(^|\/)\.git(\/|$)/;

export function isSecretPath(relative: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(relative));
}

export function isInsideGitDir(relative: string): boolean {
  return GIT_DIR.test(relative);
}

/**
 * Resolves every path against the worktree root. The trailing-separator
 * comparison blocks `../` tricks and symlink escapes that survive a naive
 * `startsWith` check.
 */
export class WorkspaceJail {
  private constructor(
    readonly root: string,
    private readonly realRoot: string,
  ) {}

  static async open(root: string): Promise<WorkspaceJail> {
    const absolute = path.resolve(root);
    const realRoot = await fs.realpath(absolute);
    const stat = await fs.stat(realRoot);
    if (!stat.isDirectory()) throw new ScopeError(`Workspace is not a directory: ${absolute}`);
    return new WorkspaceJail(absolute, realRoot);
  }

  /** Resolve a user-supplied path, refusing anything that escapes the root. */
  resolve(input: string, options: { allowMissing?: boolean } = {}): string {
    if (input.includes("\0")) throw new ScopeError("Path contains a null byte");
    const candidate = path.resolve(this.realRoot, input);
    const prefix = this.realRoot.endsWith(path.sep) ? this.realRoot : this.realRoot + path.sep;
    if (candidate !== this.realRoot && !candidate.startsWith(prefix)) {
      throw new ScopeError(`Path escapes the workspace: ${input}`);
    }
    if (isSecretPath(this.relative(candidate))) {
      throw new ScopeError(`Access to a protected file is denied: ${input}`);
    }
    if (options.allowMissing === false) return candidate;
    return candidate;
  }

  /** Resolve and follow symlinks, then re-check containment. */
  async resolveReal(input: string): Promise<string> {
    const candidate = this.resolve(input);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      // Missing file: check the nearest existing parent instead.
      const parent = path.dirname(candidate);
      const realParent = await fs.realpath(parent).catch(() => parent);
      const prefix = this.realRoot.endsWith(path.sep) ? this.realRoot : this.realRoot + path.sep;
      if (realParent !== this.realRoot && !realParent.startsWith(prefix)) {
        throw new ScopeError(`Path escapes the workspace through a symlink: ${input}`);
      }
      return path.join(realParent, path.basename(candidate));
    }
    const prefix = this.realRoot.endsWith(path.sep) ? this.realRoot : this.realRoot + path.sep;
    if (real !== this.realRoot && !real.startsWith(prefix)) {
      throw new ScopeError(`Path escapes the workspace through a symlink: ${input}`);
    }
    return real;
  }

  relative(absolute: string): string {
    const rel = path.relative(this.realRoot, absolute);
    return rel.split(path.sep).join("/");
  }
}

/** Tiny glob matcher: `**`, `*`, `?` and literal segments. No brace expansion. */
export function matchesGlob(glob: string, relativePath: string): boolean {
  const pattern = glob.replace(/^\.\//, "");
  if (pattern === "**" || pattern === "*") return true;
  const regex = globToRegExp(pattern);
  return regex.test(relativePath);
}

export function matchesAnyGlob(globs: readonly string[], relativePath: string): boolean {
  return globs.some((glob) => matchesGlob(glob, relativePath));
}

const regexCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        const next = pattern[i + 2];
        if (next === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$+{}[]()|.".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  out += "$";
  const regex = new RegExp(out);
  regexCache.set(pattern, regex);
  return regex;
}

/** Write-scope enforcement, layered on top of the jail. */
export function assertWritable(
  relativePath: string,
  writeGlobs: readonly string[],
  options: { sharedContext?: readonly string[] } = {},
): void {
  if (isInsideGitDir(relativePath)) {
    throw new ScopeError(`Writes inside .git are denied: ${relativePath}`);
  }
  if (isSecretPath(relativePath)) {
    throw new ScopeError(`Writes to a protected file are denied: ${relativePath}`);
  }
  if (options.sharedContext?.includes(relativePath)) return;
  if (matchesAnyGlob(writeGlobs, relativePath)) return;
  throw new ScopeError(
    `"${relativePath}" is outside this role's write scope (${writeGlobs.join(", ") || "none"}). ` +
      `Ask the Boss with message_agent if you need a change there.`,
  );
}
