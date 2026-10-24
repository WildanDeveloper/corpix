import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  MockProvider,
  Orchestrator,
  loadTeam,
  type LoadedTeam,
} from "@corpix/agents";
import { defaultSettings, mergeSettings, type RuntimeSettings } from "@corpix/shared";

let workspace: string;
let team: LoadedTeam;

function runtimeWith(patch: Parameters<typeof mergeSettings>[1]): RuntimeSettings {
  return { settings: mergeSettings(defaultSettings(), patch), apiKey: "", locked: [] };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpix-review-"));
  team = await loadTeam(path.resolve(__dirname, "..", "config"), "team.default.yaml", {
    BOSS_MODEL: "b",
    WORKER_MODEL: "w",
    CHEAP_MODEL: "c",
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function promptOf(request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }): string {
  const block = request.messages[0]?.content[0];
  return block && block.type === "text" ? (block.text ?? "") : "";
}

/** Distinguish the review prompt from a fix-task prompt that also mentions "review". */
function isReviewPrompt(request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }): boolean {
  return promptOf(request).includes("You are already inside a checkout of the integration branch");
}

function reviewReply(status: "done" | "blocked" | "failed", issues: string[] = [], summary = "review") {
  return {
    content: [
      {
        type: "tool_call" as const,
        id: "review",
        name: "submit_report",
        input: {
          status,
          summary,
          filesChanged: [],
          commandsRun: [],
          openIssues: issues,
        },
      },
    ],
    stopReason: "tool_use" as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

describe("QA review loop", () => {
  it("approves the work and records the review", async () => {
    const store = new MemoryStore();
    const events: string[] = [];
    const provider = new MockProvider({
      respond: (request) =>
        isReviewPrompt(request) ? reviewReply("done", [], "looks good") : undefined,
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 2 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_approved",
      approvalMode: "auto",
      onEvent: (event) => events.push(event.type),
    });

    const outcome = await orchestrator.run("Build something");
    expect(outcome.status).toBe("completed");
    expect(outcome.reviewed).toBe(true);
    expect(outcome.reviewRounds).toBe(1);
    expect(events).toContain("review.started");
    expect(events).toContain("review.finished");

    const reviewTask = outcome.tasks.find((task) => task.title.startsWith("Review round "));
    expect(reviewTask).toBeDefined();
    expect(reviewTask?.status).toBe("done");
  });

  it("opens a fix task for each issue and re-reviews", async () => {
    const store = new MemoryStore();
    let reviews = 0;
    const provider = new MockProvider({
      respond: (request) => {
        if (!isReviewPrompt(request)) return undefined;
        reviews += 1;
        return reviews === 1
          ? reviewReply("blocked", ["README.md is missing the Utilities section"], "docs gap")
          : reviewReply("done", [], "fixed");
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 2 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_fix",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("Document the new helper");
    expect(reviews).toBe(2);
    expect(outcome.reviewRounds).toBe(2);
    expect(outcome.status).toBe("completed");

    const reviewTasks = outcome.tasks.filter((task) => task.title.startsWith("Review round "));
    expect(reviewTasks).toHaveLength(2);

    const fix = outcome.tasks.find((task) => task.title.startsWith("Fix round 1"));
    expect(fix).toBeDefined();
    expect(fix?.role).toBe("docs");
    expect(fix?.status).toBe("done");
    expect(fix?.parentId).toBe(reviewTasks[0]?.id);
  });

  it("stops after the configured number of rounds and fails the run", async () => {
    const store = new MemoryStore();
    let reviews = 0;
    const provider = new MockProvider({
      respond: (request) => {
        if (!isReviewPrompt(request)) return undefined;
        reviews += 1;
        return reviewReply("blocked", [`issue ${reviews} still present`]);
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 2 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_loop",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("Never good enough");
    expect(reviews).toBe(2);
    expect(outcome.reviewRounds).toBe(2);
    expect(outcome.status).toBe("failed");
  });

  it("skips review when reviewRounds is 0", async () => {
    const store = new MemoryStore();
    let reviews = 0;
    const provider = new MockProvider({
      respond: (request) => {
        if (!isReviewPrompt(request)) return undefined;
        reviews += 1;
        return reviewReply("done");
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 0 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_noreview",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("No review please");
    expect(reviews).toBe(0);
    expect(outcome.reviewed).toBe(false);
    expect(outcome.status).toBe("completed");
  });

  it("routes a frontend issue to the frontend role", async () => {
    const store = new MemoryStore();
    let reviews = 0;
    const provider = new MockProvider({
      respond: (request) => {
        if (!isReviewPrompt(request)) return undefined;
        reviews += 1;
        return reviews === 1
          ? reviewReply("failed", ["The React component crashes on mount"])
          : reviewReply("done");
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 2 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_route",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("Build a UI");
    const fix = outcome.tasks.find((task) => task.title.startsWith("Fix round 1"));
    expect(fix?.role).toBe("frontend");
  });

  it("skips review when a deliverable failed", async () => {
    const store = new MemoryStore();
    let reviews = 0;
    const provider = new MockProvider({
      respond: (request) => {
        const block = request.messages[0]?.content[0];
        const text = block && block.type === "text" ? (block.text ?? "") : "";
        if (text.includes("You are already inside a checkout of the integration branch")) {
          reviews += 1;
          return reviewReply("done");
        }
        // Make the first worker fail so the deliverable set is incomplete.
        if (text.startsWith("Task t_") && !text.includes("Review round")) {
          return reviewReply("failed", ["deliberate failure"]);
        }
        return undefined;
      },
    });

    const orchestrator = new Orchestrator({
      store,
      provider,
      team,
      runtime: runtimeWith({ limits: { reviewRounds: 2 } }),
      workspacePath: workspace,
      projectId: "test",
      runId: "run_skip_review",
      approvalMode: "auto",
    });

    const outcome = await orchestrator.run("One task will fail");
    expect(reviews).toBe(0);
    expect(outcome.reviewed).toBe(false);
    expect(outcome.status).toBe("failed");
  });
});
