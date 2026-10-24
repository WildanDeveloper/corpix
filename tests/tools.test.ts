import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeToolCall,
  loadTeam,
  schemasForRole,
  WorkspaceJail,
  type LoadedTeam,
} from "@corpix/agents";
import type { Role, ToolCallBlock } from "@corpix/shared";
import type { ToolContext } from "@corpix/agents";
import type { ToolResultBlock } from "@corpix/shared";
let workspace: string;
let jail: WorkspaceJail;
let team: LoadedTeam;
let frontend: Role;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-tools-"));
  await fs.mkdir(path.join(workspace, "apps/web"), { recursive: true });
  await fs.writeFile(path.join(workspace, "apps/web/index.html"), "<h1>hi</h1>\n");
  await fs.writeFile(path.join(workspace, ".env"), "SECRET=abc123\n");
  jail = await WorkspaceJail.open(workspace);
  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
  frontend = team.roles.get("frontend") as Role;
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    jail,
    role: frontend,
    agentId: "a1",
    taskId: "t1",
    runId: "r1",
    limits: { toolOutputMaxChars: 4000, commandTimeoutMs: 5000 },
    runCommand: async () => ({
      command: "x",
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
    messageAgent: () => undefined,
    recordChange: () => undefined,
    recordCommand: () => undefined,
    sharedContext: ["SPEC.md", "NOTES.md"],
    ...overrides,
  };
}

function call(name: string, input: unknown): ToolCallBlock {
  return { type: "tool_call", id: `c_${name}`, name, input };
}

async function run(
  toolCall: ToolCallBlock,
  ctx = context(),
  role = frontend,
  approve: () => Promise<boolean> = async () => true,
): Promise<ToolResultBlock> {
  return await executeToolCall(toolCall, { ctx, role, approve });
}

describe("tool schemas", () => {
  it("only exposes tools listed on the role", () => {
    const names = schemasForRole(frontend).map((schema) => schema.name);
    expect(names).toContain("write_file");
    expect(names).toContain("submit_report");
    expect(names).not.toContain("submit_plan");
  });

  it("gives the Boss a plan schema restricted to loaded roles", () => {
    const boss = team.roles.get("boss") as Role;
    const schema = schemasForRole(boss, [...team.roles.keys()]).find(
      (entry) => entry.name === "submit_plan",
    );
    expect(schema).toBeDefined();
    const roles = [...team.roles.keys()];
    const json = JSON.stringify(schema?.jsonSchema);
    for (const roleId of roles) {
      expect(json).toContain(`"${roleId}"`);
    }
    // A role that is not loaded must not be selectable.
    expect(json).not.toContain('"designer"');
  });
});

describe("read tools", () => {
  it("lists files and skips .git and secrets", async () => {
    const result = await run(call("list_files", { path: ".", depth: 2 }));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("apps/web/index.html");
    expect(result.content).not.toContain(".env");
  });

  it("reads a file with a line range", async () => {
    await fs.writeFile(path.join(workspace, "apps/web/lines.txt"), "a\nb\nc\n");
    const result = await run(call("read_file", { path: "apps/web/lines.txt", startLine: 2, endLine: 3 }));
    expect(result.content).toBe("2: b\n3: c");
  });

  it("refuses to read .env", async () => {
    const result = await run(call("read_file", { path: ".env" }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/protected file/);
  });

  it("never leaks secrets through search_files", async () => {
    const result = await run(call("search_files", { pattern: "SECRET", path: "." }));
    expect(result.content).not.toContain("abc123");
  });

  it("reports a missing file as an error result", async () => {
    const result = await run(call("read_file", { path: "nope.txt" }));
    expect(result.isError).toBe(true);
  });
});

describe("write tools", () => {
  it("writes inside the scope and records the change", async () => {
    const changes: string[] = [];
    const result = await run(
      call("write_file", { path: "apps/web/new.ts", content: "export const a = 1;\n" }),
      context({ recordChange: (p) => changes.push(p) }),
    );
    expect(result.isError).toBe(false);
    expect(changes).toEqual(["apps/web/new.ts"]);
    expect(await fs.readFile(path.join(workspace, "apps/web/new.ts"), "utf8")).toContain("a = 1");
  });

  it("refuses writes outside the scope", async () => {
    const result = await run(call("write_file", { path: "apps/server/x.ts", content: "x" }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside this role's write scope/);
  });

  it("refuses writes to .env even with a broad scope", async () => {
    const wildcard = { ...frontend, scope: { write: ["**"], read: ["**"] } };
    const result = await run(call("write_file", { path: ".env", content: "X=1" }), context(), wildcard);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/protected file/);
  });

  it("edits a unique string once", async () => {
    const result = await run(
      call("edit_file", { path: "apps/web/index.html", oldString: "hi", newString: "hello" }),
    );
    expect(result.isError).toBe(false);
    expect(await fs.readFile(path.join(workspace, "apps/web/index.html"), "utf8")).toContain("hello");
  });

  it("refuses a non-unique edit", async () => {
    await fs.writeFile(path.join(workspace, "apps/web/dup.txt"), "aa\naa\n");
    const result = await run(
      call("edit_file", { path: "apps/web/dup.txt", oldString: "aa", newString: "bb" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not unique/);
  });
});

describe("exec and approval", () => {
  it("asks for approval before running a command", async () => {
    let asked = 0;
    const result = await run(
      call("run_command", { command: "node", args: ["-e", "1"] }),
      context(),
      frontend,
      async () => {
        asked += 1;
        return true;
      },
    );
    expect(asked).toBe(1);
    expect(result.isError).toBe(false);
  });

  it("returns an error result when the human denies", async () => {
    const result = await run(
      call("run_command", { command: "node", args: ["x"] }),
      context(),
      frontend,
      async () => false,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/denied/);
  });

  it("does not ask for approval on safe reads", async () => {
    let asked = 0;
    await run(call("read_file", { path: "apps/web/index.html" }), context(), frontend, async () => {
      asked += 1;
      return true;
    });
    expect(asked).toBe(0);
  });

  it("rejects an unknown tool", async () => {
    const result = await run(call("rm_rf", {}));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unknown tool/);
  });

  it("rejects a tool the role may not call", async () => {
    const result = await run(call("submit_plan", { summary: "x", tasks: [] }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/may not call/);
  });

  it("rejects invalid arguments without throwing", async () => {
    const result = await run(call("write_file", { path: 42 }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid tool arguments/);
  });
});
