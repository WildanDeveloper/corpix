import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, MockProvider, Orchestrator, loadTeam, type LoadedTeam } from "@corpix/agents";
import { defaultSettings, mergeSettings, type RuntimeSettings } from "@corpix/shared";

let workspace: string;
let team: LoadedTeam;

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-review-fail-"));
  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("review failure handling", () => {
  it("treats a reviewer that hits the step limit as inconclusive, not fatal", async () => {
    const store = new MemoryStore();
    const events: string[] = [];
    let reviewCalls = 0;

    // A reviewer that never calls submit_report: it just loops on a tool.
    const provider = new MockProvider({
      respond: (request) => {
        const block = request.messages[0]?.content[0];
        const text = block && block.type === "text" ? (block.text ?? "") : "";
        if (!text.includes("You are already inside a checkout of the integration branch")) return undefined;
        reviewCalls += 1;
        return {
          content: [
            { type: "tool_call", id: `loop${reviewCalls}`, name: "list_files", input: { path: "." } },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 1, maxStepsPerTask: 3 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_review_crash",
      approvalMode: "auto",
      onEvent: (event) => events.push(event.type),
    });

    const outcome = await orchestrator.run("Reviewer goes nowhere");

    // The deliverables succeeded; only the review is inconclusive.
    const deliverables = outcome.tasks.filter(
      (task) => !task.title.startsWith("Review round ") && !task.title.startsWith("Fix round "),
    );
    expect(deliverables.every((task) => task.status === "done")).toBe(true);
    expect(events).toContain("review.finished");
    expect(events).toContain("error");

    const reviewTask = outcome.tasks.find((task) => task.title.startsWith("Review round "));
    expect(reviewTask?.status).toBe("blocked");
    expect(reviewTask?.report?.summary).toMatch(/Reviewer failed|step limit/i);
  });

  it("gives the reviewer at least 20 steps regardless of the task cap", async () => {
    const store = new MemoryStore();
    // Real files so every read succeeds and only the step budget can stop us.
    for (let index = 1; index <= 12; index++) {
      await fs.writeFile(path.join(workspace, `file-${index}.ts`), `export const n = ${index};\n`);
    }
    let reviewSteps = 0;
    const provider = new MockProvider({
      respond: (request) => {
        const block = request.messages[0]?.content[0];
        const text = block && block.type === "text" ? (block.text ?? "") : "";
        if (!text.includes("You are already inside a checkout of the integration branch")) return undefined;
        reviewSteps += 1;
        if (reviewSteps < 12) {
          // Vary the input so this is a real multi-step review, not a loop.
          return {
            content: [
              {
                type: "tool_call",
                id: `s${reviewSteps}`,
                name: "read_file",
                input: { path: `file-${reviewSteps}.ts` },
              },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: [
            {
              type: "tool_call",
              id: "final",
              name: "submit_report",
              input: {
                status: "done",
                summary: "verified",
                filesChanged: [],
                commandsRun: [],
                openIssues: [],
              },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 1, maxStepsPerTask: 2 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_review_steps",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("Reviewer needs many steps");
    // The reviewer gets at least 20 steps even though maxStepsPerTask is 2,
    // so it can run a dozen tool calls before reporting.
    expect(reviewSteps).toBeGreaterThanOrEqual(12);
    expect(outcome.reviewed).toBe(true);
    const reviewTask = outcome.tasks.find((task) => task.title.startsWith("Review round "));
    expect(reviewTask?.status).toBe("done");
  });
});
