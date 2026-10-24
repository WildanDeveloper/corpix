import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, MockProvider, Orchestrator, loadTeam, type LoadedTeam } from "@corpix/agents";
import { CancelledError, defaultSettings, mergeSettings, type RuntimeSettings } from "@corpix/shared";

let workspace: string;
let team: LoadedTeam;

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-cmd-"));
  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** A provider that asks the backend agent to run one command, then reports. */
function commandProvider(command: string, args: string[]) {
  let turn = 0;
  return new MockProvider({
    respond: (request) => {
      const isBoss = request.tools.some((tool) => tool.name === "submit_plan");
      if (isBoss) return undefined; // default scripted plan
      turn += 1;
      if (turn === 1) {
        return {
          content: [
            { type: "tool_call", id: "c1", name: "run_command", input: { command, args } },
          ],
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
                summary: "ran the command",
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

describe("command execution", () => {
  it("runs an allowlisted command and reports its output", async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: commandProvider("node", ["-e", "console.log('hello-from-child')"]),
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_cmd",
      approvalMode: "auto",
    });

    await orchestrator.run("Run a command");
    const results = store
      .listEvents("run_cmd")
      .filter((event) => event.type === "tool.result")
      .map((event) => String(event.payload.preview));
    expect(results.some((preview) => preview.includes("hello-from-child"))).toBe(true);
  });

  it("returns a policy error for a command that is not allowlisted", async () => {
    const store = new MemoryStore();
    const orchestrator = new Orchestrator({
      store,
      provider: commandProvider("curl", ["http://example.com"]),
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_policy",
      approvalMode: "auto",
    });

    await orchestrator.run("Run a blocked command");
    const results = store
      .listEvents("run_policy")
      .filter((event) => event.type === "tool.result")
      .map((event) => String(event.payload.preview));
    expect(results.some((preview) => preview.includes("POLICY"))).toBe(true);
  });

  it("kills the process tree when the task timeout fires", async () => {
    const store = new MemoryStore();
    const marker = path.join(workspace, "should-not-exist.txt");
    // A child that outlives its parent would still write the marker.
    const script = `
      const { spawn } = require('node:child_process');
      spawn('node', ['-e', "setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)"], { stdio: 'ignore' });
      setTimeout(() => {}, 60000);
    `;

    const orchestrator = new Orchestrator({
      store,
      provider: commandProvider("node", ["-e", script]),
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_kill",
      approvalMode: "auto",
      limits: { commandTimeoutMs: 500 },
    });

    await orchestrator.run("Trigger a timeout");
    // Wait past the grandchild's own timer.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const exists = await fs
      .access(marker)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  }, 20_000);
});

describe("cancellation", () => {
  it("returns a cancelled outcome and does not emit run.failed", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    const provider = {
      name: "hang",
      complete: (request: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(new CancelledError());
            return;
          }
          request.signal?.addEventListener("abort", () => reject(new CancelledError()), {
            once: true,
          });
        }),
    };

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({}),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_cancel2",
      approvalMode: "auto",
      signal: controller.signal,
    });

    const promise = orchestrator.run("Hang");
    setTimeout(() => controller.abort(), 20);
    const outcome = await promise;

    expect(outcome.status).toBe("cancelled");
    expect(store.getRun("run_cancel2")?.status).toBe("cancelled");
    const types = store.listEvents("run_cancel2").map((event) => event.type);
    expect(types).toContain("run.cancelled");
    expect(types).not.toContain("run.failed");
  });
});
