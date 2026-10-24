import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  MockProvider,
  Orchestrator,
  detectSandboxes,
  loadTeam,
  type LoadedTeam,
} from "@corpix/agents";
import { defaultSettings, mergeSettings, type RuntimeSettings } from "@corpix/shared";

const run = promisify(execFile);
const created: string[] = [];

let workspace: string;
let team: LoadedTeam;
let bwrapAvailable = false;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e.st",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e.st",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return stdout;
}

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

/** Provider that asks the worker to run one command, then reports done. */
function commandProvider(command: string, args: string[]) {
  let turn = 0;
  return new MockProvider({
    respond: (request) => {
      const isBoss = request.tools.some((tool) => tool.name === "submit_plan");
      if (isBoss) return undefined;
      const block = request.messages[0]?.content[0];
      const text = block && block.type === "text" ? (block.text ?? "") : "";
      if (text.includes("You are already inside a checkout of the integration branch")) {
        return undefined;
      }
      turn += 1;
      if (turn === 1) {
        return {
          content: [{ type: "tool_call", id: "c1", name: "run_command", input: { command, args } }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (turn === 2) {
        return {
          content: [
            {
              type: "tool_call",
              id: "c2",
              name: "submit_report",
              input: {
                status: "done",
                summary: "ran it",
                filesChanged: [],
                commandsRun: [],
                openIssues: [],
              },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return undefined;
    },
  });
}

beforeEach(async () => {
  bwrapAvailable =
    (await detectSandboxes()).find((entry) => entry.kind === "bwrap")?.available ?? false;
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-sbx-"));
  created.push(workspace);
  await git(workspace, ["init", "-q", "-b", "main"]);
  await fs.writeFile(path.join(workspace, "README.md"), "# p\n");
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "-qm", "init"]);

  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(`${dir}.worktrees`, { recursive: true, force: true });
  }
});

async function runWithSandbox(
  command: string,
  args: string[],
  sandbox: "none" | "bwrap",
  runId: string,
) {
  const store = new MemoryStore();
  const previews: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    provider: commandProvider(command, args),
    team,
    runtime: runtimeWith({ safety: { approvalMode: "auto", sandbox } }),
    workspacePath: workspace,
    projectId: "test",
    runId,
    approvalMode: "auto",
    onEvent: (event) => {
      if (event.type === "tool.result") previews.push(String(event.payload.preview));
    },
  });
  await orchestrator.run("Run a command");
  return previews;
}

describe.runIf(process.platform === "linux")("command sandboxing", () => {
  it("runs a command and can write inside the worktree", async () => {
    if (!bwrapAvailable) return;
    const previews = await runWithSandbox(
      "node",
      ["-e", "require('fs').writeFileSync('from-sandbox.txt','ok'); console.log('wrote')"],
      "bwrap",
      "run_sbx_write",
    );
    expect(previews.some((preview) => preview.includes("wrote"))).toBe(true);
  });

  it("blocks network access inside the sandbox", async () => {
    if (!bwrapAvailable) return;
    const previews = await runWithSandbox(
      "node",
      [
        "-e",
        // Build the marker at runtime so it does not appear in the command echo.
        "fetch('https://example.com').then(()=>console.log(['NET','OK'].join('_'))).catch(()=>console.log(['NET','BLOCKED'].join('_')))",
      ],
      "bwrap",
      "run_sbx_net",
    );
    const joined = previews.join("\n");
    expect(joined).toContain("NET_BLOCKED");
    expect(joined).not.toContain("NET_OK");
  });

  it("cannot see the host filesystem outside the worktree", async () => {
    if (!bwrapAvailable) return;
    const previews = await runWithSandbox(
      "node",
      [
        "-e",
        "const fs=require('fs'); console.log('root:', fs.existsSync('/root') ? 'visible' : 'hidden'); console.log('cwd:', process.cwd());",
      ],
      "bwrap",
      "run_sbx_fs",
    );
    expect(previews.some((preview) => preview.includes("root: hidden"))).toBe(true);
    expect(previews.some((preview) => preview.includes("cwd: /work"))).toBe(true);
  });

  it("degrades to no sandbox when bubblewrap is missing", async () => {
    const previews = await runWithSandbox(
      "node",
      ["-e", "console.log('plain run')"],
      "none",
      "run_sbx_none",
    );
    expect(previews.some((preview) => preview.includes("plain run"))).toBe(true);
  });
});
