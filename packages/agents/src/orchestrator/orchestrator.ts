import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BudgetExceededError,
  CancelledError,
  DEFAULT_LIMITS,
  validatePlan,
  newAgentId,
  newRunId,
  newTaskId,
  type ApprovalMode,
  type EventEnvelope,
  type EventInput,
  type Message,
  type Plan,
  type Report,
  type Role,
  type RunStatus,
  type RuntimeSettings,
} from "@corpix/shared";
import type { LLMProvider } from "../providers/types";
import { renderPrompt, type LoadedTeam } from "../roles/loader";
import { applyRoleOverrides, capTeamSteps } from "../config/settings-service";
import { GitWorkspace, type Worktree } from "../git/workspace";
import { ContextManager } from "../runtime/context";
import type { AgentRunResult } from "../runtime/agent-loop";
import { runAgent, type AgentRuntime, type TaskBrief } from "../runtime/agent-loop";
import { BudgetGuard } from "../runtime/budget";
import type { ApprovalDecider } from "../tools";
import { checkCommand, scrubbedEnv } from "../tools/policy";
import type { CommandOutcome } from "../tools/types";
import { WorkspaceJail } from "../tools/workspace";
import type { Store, TaskRecord } from "../store/types";
import type { TeamMember } from "../roles/loader";
import {
  buildSandboxCommand,
  describeSandbox,
  detectSandboxes,
  gitDirsFor,
  type SandboxKind,
} from "../sandbox";
import {
  REVIEW_SCHEMA_DESCRIPTION,
  buildFixInstructions,
  fixTasksFor,
  verdictFromReport,
  type ReviewVerdict,
} from "./review";

export interface OrchestratorOptions {
  store: Store;
  provider: LLMProvider;
  team: LoadedTeam;
  workspacePath: string;
  projectId: string;
  /** Optional pre-allocated run id, e.g. when the HTTP client subscribes first. */
  runId?: string;
  /** Resolved runtime settings from the settings service. */
  runtime?: RuntimeSettings;
  company?: string;
  approvalMode?: ApprovalMode;
  budgetUsd?: number;
  pricing?: Record<string, { input: number; output: number; cached_input?: number }>;
  limits?: {
    maxConcurrentAgents?: number;
    maxStepsPerTask?: number;
    toolOutputMaxChars?: number;
    taskTimeoutMinutes?: number;
    commandTimeoutMs?: number;
    contextTokens?: number;
    maxOutputTokens?: number;
    reviewRounds?: number;
    planAttempts?: number;
  };
  approve?: ApprovalDecider;
  /** Optional cheap summariser used when an agent's context is compacted. */
  summariser?: (text: string) => Promise<string>;
  /** Receives every persisted event, in `seq` order. */
  onEvent?: (event: EventEnvelope) => void;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  summary: string;
  spentUsd: number;
  tasks: TaskRecord[];
  /** QA rounds that ran before the run ended. */
  reviewRounds: number;
  /** Final QA verdict when review ran. */
  reviewed: boolean;
}

const SHARED_CONTEXT = ["SPEC.md", "NOTES.md"];

/**
 * Runs one goal end to end: plan, schedule, execute, summarise.
 * Git worktrees, QA review rounds and merging land in later phases; Phase 0
 * runs every agent against the same workspace.
 */
export class Orchestrator {
  private readonly store: Store;
  private readonly provider: LLMProvider;
  private readonly team: LoadedTeam;
  private readonly workspacePath: string;
  private readonly projectId: string;
  private readonly company: string;
  private readonly approvalMode: ApprovalMode;
  private readonly limits: Required<NonNullable<OrchestratorOptions["limits"]>>;
  private readonly log: (message: string) => void;
  private baseJail?: WorkspaceJail;
  private integrationJail?: WorkspaceJail;
  private git?: GitWorkspace;
  private worktrees = false;
  private sandboxKind: SandboxKind = "none";
  private gitQueue: Promise<unknown> = Promise.resolve();
  private budget!: BudgetGuard;
  private mailbox = new Map<string, string[]>();
  private currentRunId = "";
  private readonly pricing: Record<string, { input: number; output: number; cached_input?: number }>;
  private readonly defaultBudgetUsd: number;

  constructor(private readonly options: OrchestratorOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.workspacePath = options.workspacePath;
    this.projectId = options.projectId;
    this.company = options.company ?? "Corpix";
    this.approvalMode =
      options.approvalMode ?? options.runtime?.settings.safety.approvalMode ?? "ask";
    const settingsLimits = options.runtime?.settings.limits;
    this.limits = {
      maxConcurrentAgents:
        options.limits?.maxConcurrentAgents ??
        settingsLimits?.maxConcurrentAgents ??
        DEFAULT_LIMITS.maxConcurrentAgents,
      maxStepsPerTask:
        options.limits?.maxStepsPerTask ??
        settingsLimits?.maxStepsPerTask ??
        DEFAULT_LIMITS.maxStepsPerTask,
      toolOutputMaxChars:
        options.limits?.toolOutputMaxChars ??
        settingsLimits?.toolOutputMaxChars ??
        DEFAULT_LIMITS.toolOutputMaxChars,
      taskTimeoutMinutes:
        options.limits?.taskTimeoutMinutes ??
        settingsLimits?.taskTimeoutMinutes ??
        DEFAULT_LIMITS.taskTimeoutMinutes,
      commandTimeoutMs: options.limits?.commandTimeoutMs ?? 120_000,
      contextTokens:
        options.limits?.contextTokens ??
        settingsLimits?.contextTokens ??
        DEFAULT_LIMITS.contextTokens,
      maxOutputTokens:
        options.limits?.maxOutputTokens ??
        settingsLimits?.maxOutputTokens ??
        DEFAULT_LIMITS.maxOutputTokens,
      reviewRounds:
        options.limits?.reviewRounds ??
        settingsLimits?.reviewRounds ??
        DEFAULT_LIMITS.reviewRounds,
      planAttempts: options.limits?.planAttempts ?? DEFAULT_LIMITS.planAttempts,
    };
    this.pricing = options.pricing ?? options.runtime?.settings.pricing ?? {};
    this.defaultBudgetUsd =
      options.budgetUsd ?? settingsLimits?.budgetUsdPerGoal ?? DEFAULT_LIMITS.budgetUsdPerGoal;
    this.team = options.runtime
      ? capTeamSteps(
          applyRoleOverrides(options.team, options.runtime.settings.models),
          this.limits.maxStepsPerTask,
        )
      : options.team;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Every event is persisted first, then handed to the sink. Persisting here
   * keeps the log authoritative even when no client is listening.
   */
  private emit(event: EventInput): void {
    if (!this.currentRunId) return;
    const envelope = this.store.appendEvent(this.currentRunId, event.type, event.payload);
    if (event.type === "agent.state_changed") {
      const agentId = event.payload.agentId;
      const state = event.payload.to;
      if (typeof agentId === "string" && typeof state === "string") {
        this.store.updateAgent(agentId, {
          state: state as "idle" | "walking" | "thinking" | "working" | "blocked" | "done" | "error",
        });
      }
    }
    this.options.onEvent?.(envelope);
  }

  private roleIds(): string[] {
    return [...this.team.roles.keys()];
  }

  private renderFor(role: Role, name: string): string {
    return renderPrompt(role.systemPrompt, {
      name,
      title: role.title,
      company: this.company,
      workspace: this.workspacePath,
      role,
      bossName: this.team.boss.name,
      roles: this.roleIds(),
    });
  }

  async run(goal: string): Promise<RunOutcome> {
    const runId = this.options.runId ?? newRunId();
    this.currentRunId = runId;
    const budgetUsd = this.options.budgetUsd ?? this.defaultBudgetUsd;
    const startedAt = new Date().toISOString();

    this.store.createRun({
      id: runId,
      projectId: this.projectId,
      goal,
      status: "planning",
      plan: null,
      budgetUsd,
      spentUsd: 0,
      startedAt,
      finishedAt: null,
      summary: null,
    });

    this.baseJail = await WorkspaceJail.open(this.workspacePath);
    this.budget = new BudgetGuard({
      budgetUsd,
      action: this.options.runtime?.settings.limits.budgetAction ?? "pause",
      pricing: this.pricing,
      onRecord: (record) => {
        this.store.recordUsage({
          runId,
          taskId: record.taskId,
          agentId: record.agentId,
          model: record.model,
          usage: record.usage,
          costUsd: record.costUsd,
          ts: record.ts,
        });
        this.store.updateRun(runId, { spentUsd: this.budget.spentUsd });
      },
    });

    this.emit({
      type: "run.started",
      payload: {
        goal,
        projectId: this.projectId,
        budgetUsd,
        approvalMode: this.approvalMode,
      },
    });

    try {
      await this.prepareSandbox();
      await this.prepareGit();
      const plan = await this.plan(runId, goal);
      const { tasks, planByTaskId } = this.persistPlan(runId, plan);
      const executed = await this.execute(runId, tasks, planByTaskId);
      const reviewOutcome = await this.review(
        runId,
        goal,
        executed.map((task) => this.store.getTask(task.id) ?? task),
      );
      const finished = reviewOutcome.tasks.map((task) => this.store.getTask(task.id) ?? task);
      await this.releaseIntegrationWorktree();
      const summary = summarise(goal, finished, this.git?.integrationBranch);
      const paused = this.budget.isPaused || this.budget.isStopped;
      // A blocked task means the goal was not achieved, so the run is not
      // "completed" just because nothing crashed. Review tasks are a verdict,
      // not deliverable work, so they are excluded from the completion check.
      const deliverable = finished.filter((task) => !isReviewTask(task));
      const allDone = deliverable.every((task) => task.status === "done");
      const reviewBlocked = reviewOutcome.reviewed && !reviewOutcome.approved;
      const status: RunStatus = paused
        ? "paused"
        : allDone && !reviewBlocked
          ? "completed"
          : "failed";

      this.store.updateRun(runId, {
        status,
        summary,
        finishedAt: new Date().toISOString(),
        spentUsd: this.budget.spentUsd,
      });
      this.emit({
        type: paused ? "run.paused" : status === "completed" ? "run.finished" : "run.failed",
        payload: {
          status,
          summary,
          spentUsd: this.budget.spentUsd,
          review: {
            ran: reviewOutcome.reviewed,
            rounds: reviewOutcome.rounds,
            approved: reviewOutcome.approved,
          },
          tasks: {
            total: deliverable.length,
            done: deliverable.filter((task) => task.status === "done").length,
            failed: deliverable.filter((task) => task.status !== "done").length,
          },
        },
      });

      return {
        runId,
        status,
        summary,
        spentUsd: this.budget.spentUsd,
        tasks: finished,
        reviewRounds: reviewOutcome.rounds,
        reviewed: reviewOutcome.reviewed,
      };
    } catch (error) {
      await this.releaseIntegrationWorktree().catch(() => undefined);
      const cancelled = error instanceof CancelledError;
      const status: RunStatus = cancelled ? "cancelled" : "failed";
      const message = cancelled ? "Run cancelled" : (error as Error).message;
      this.store.updateRun(runId, {
        status,
        summary: message,
        finishedAt: new Date().toISOString(),
        spentUsd: this.budget.spentUsd,
      });
      this.emit({
        type: cancelled ? "run.cancelled" : "run.failed",
        payload: { status, summary: message, spentUsd: this.budget.spentUsd },
      });
      if (cancelled) {
        return {
          runId,
          status,
          summary: message,
          spentUsd: this.budget.spentUsd,
          tasks: this.store.listTasks(runId),
          reviewRounds: 0,
          reviewed: false,
        };
      }
      throw error;
    }
  }

  /** Boss plans; the plan is validated and retried on failure. */
  /**
   * Set up the integration branch and per-task worktrees. Falls back to the
   * shared workspace when git is disabled or the target is not a repository.
   */
  /**
   * Pick the sandbox for this run. An unavailable sandbox degrades to "none"
   * with a warning instead of failing the run, so a laptop without bubblewrap
   * still works.
   */
  private async prepareSandbox(): Promise<void> {
    const requested = this.options.runtime?.settings.safety.sandbox ?? "none";
    if (requested === "none") {
      this.sandboxKind = "none";
      return;
    }
    const available = await detectSandboxes();
    const entry = available.find((item) => item.kind === requested);
    if (entry?.available) {
      this.sandboxKind = requested;
      this.emit({
        type: "sandbox.ready",
        payload: { kind: requested, detail: describeSandbox(requested) },
      });
      return;
    }
    this.sandboxKind = "none";
    this.log(
      `Sandbox "${requested}" is unavailable (${entry?.detail ?? "unknown"}), running without isolation.`,
    );
    this.emit({
      type: "error",
      payload: {
        message: `Sandbox "${requested}" unavailable: ${entry?.detail ?? "unknown"}. Commands ran with policy and jail only.`,
        code: "sandbox_unavailable",
      },
    });
  }

  private async prepareGit(): Promise<void> {
    const config = this.options.runtime?.settings.git;
    if (config && !config.enabled) {
      this.worktrees = false;
      return;
    }
    try {
      const workspace = await GitWorkspace.open(this.workspacePath, {
        integrationBranch: config?.integrationBranch ?? "integration",
        worktreesDir: config?.worktreesDir,
      });
      if (!(await workspace.isClean())) {
        this.log("Workspace has uncommitted changes; agents share one workspace this run.");
        this.worktrees = false;
        return;
      }
      const { created, branch } = await workspace.ensureIntegrationBranch();
      this.git = workspace;
      this.worktrees = true;
      this.integrationJail = await WorkspaceJail.open(
        await workspace.ensureIntegrationWorktree(),
      );
      this.emit({
        type: "git.ready",
        payload: {
          branch,
          created,
          worktreesDir: workspace.worktreesRoot,
          isolation: "worktree",
        },
      });
    } catch (error) {
      // Not a repo, or a branch we must not touch: run without isolation.
      this.worktrees = false;
      this.log(`Git isolation disabled: ${(error as Error).message}`);
    }
  }

  private async createWorktree(task: TaskRecord): Promise<Worktree | null> {
    if (!this.git) return null;
    const git = this.git;
    const worktree = await this.serialiseGit(() => git.createWorktree(task.id, task.role));
    this.emit({
      type: "git.worktree_created",
      payload: { taskId: task.id, branch: worktree.branch, path: worktree.path },
    });
    return worktree;
  }

  /** Commit whatever the agent produced so the branch can be merged. */
  private async commitTask(task: TaskRecord, worktree: Worktree): Promise<boolean> {
    if (!this.git) return false;
    const git = this.git;
    try {
      const result = await this.serialiseGit(() =>
        git.commitAll(
          worktree.path,
          `${task.role}: ${task.title}\n\nTask ${task.id} of run ${task.runId}`,
        ),
      );
      if (!result.committed) {
        // No changes: drop the empty branch so the repo stays tidy.
        await this.serialiseGit(() => git.removeWorktree(worktree.path));
        return false;
      }
      return true;
    } catch (error) {
      this.emit({
        type: "error",
        payload: {
          message: `Could not commit ${task.role} work: ${(error as Error).message}`,
          code: "git_commit_failed",
          taskId: task.id,
        },
      });
      return false;
    }
  }

  /** Remove the temporary integration checkout. Safe to call twice. */
  private async releaseIntegrationWorktree(): Promise<void> {
    if (!this.git) return;
    await this.serialiseGit(() => this.git!.releaseIntegrationWorktree()).catch(() => undefined);
  }

  /** git operations mutate shared refs, so run them one at a time. */
  private serialiseGit<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.gitQueue.then(operation, operation);
    this.gitQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * QA gate: review the merged integration branch, then open fix tasks for the
   * issues found. Runs at most `limits.reviewRounds` rounds, and never reviews
   * when the reviewer role is not on the team.
   */
  private async review(
    runId: string,
    goal: string,
    tasks: TaskRecord[],
  ): Promise<{
    tasks: TaskRecord[];
    rounds: number;
    reviewed: boolean;
    approved: boolean;
  }> {
    const reviewer = this.team.workers.find((worker) => worker.role.id === "qa");
    const maxRounds = this.limits.reviewRounds;
    const deliverable = tasks.filter((task) => !isReviewTask(task));
    const done = deliverable.filter((task) => task.status === "done");
    if (!reviewer || maxRounds === 0 || done.length === 0) {
      return { tasks, rounds: 0, reviewed: false, approved: false };
    }
    // Reviewing an incomplete result wastes tokens and can approve work that is
    // missing a deliverable, so the gate requires every deliverable to be done.
    if (done.length !== deliverable.length) {
      this.log("Skipping review: at least one deliverable task did not finish.");
      return { tasks, rounds: 0, reviewed: false, approved: false };
    }

    let current = tasks;
    let round = 0;
    let lastVerdict: ReviewVerdict | null = null;

    while (round < maxRounds) {
      round += 1;
      this.emit({
        type: "review.started",
        payload: {
          round,
          maxRounds,
          reviewer: reviewer.role.id,
          integrationBranch: this.git?.integrationBranch,
        },
      });

      const { verdict, task } = await this.runReviewRound(
        runId,
        goal,
        reviewer,
        round,
        maxRounds,
        current,
      );
      lastVerdict = verdict;
      current = [...current, task];
      this.emit({
        type: "review.finished",
        payload: {
          round,
          taskId: task.id,
          approved: verdict.approved,
          inconclusive: verdict.inconclusive,
          issues: verdict.issues,
          summary: verdict.summary,
        },
      });

      if (verdict.approved || verdict.inconclusive) {
        return {
          tasks: current,
          rounds: round,
          reviewed: true,
          approved: verdict.approved,
        };
      }

      const fixes = fixTasksFor(verdict.issues);
      if (fixes.length === 0) {
        return { tasks: current, rounds: round, reviewed: true, approved: false };
      }

      const fixTasks = this.persistFixTasks(runId, task, round, fixes, verdict);
      const planByTaskId = new Map<string, Plan["tasks"][number]>();
      for (const fix of fixTasks) {
        planByTaskId.set(fix.id, {
          id: fix.id,
          role: fix.role,
          title: fix.title,
          instructions: fix.instructions,
          dependsOn: [],
          acceptanceCriteria: fix.acceptanceCriteria,
        });
      }
      const executed = await this.execute(runId, fixTasks, planByTaskId);
      current = [
        ...current.map((item) => this.store.getTask(item.id) ?? item),
        ...executed.map((item) => this.store.getTask(item.id) ?? item),
      ];
    }

    return {
      tasks: current,
      rounds: round,
      reviewed: true,
      approved: lastVerdict?.approved ?? false,
    };
  }

  private async runReviewRound(
    runId: string,
    goal: string,
    reviewer: TeamMember,
    round: number,
    maxRounds: number,
    tasks: TaskRecord[],
  ): Promise<{ verdict: ReviewVerdict; task: TaskRecord }> {    const agentId = newAgentId(reviewer.role.id);
    const model = reviewer.role.model;
    this.store.createAgent({
      id: agentId,
      runId,
      role: reviewer.role.id,
      name: reviewer.name,
      model,
      state: "idle",
    });

    const agent: AgentRuntime = {
      id: agentId,
      name: reviewer.name,
      model,
      role: reviewer.role,
      systemPrompt: this.renderFor(reviewer.role, reviewer.name),
    };

    const files = this.git
      ? await this.serialiseGit(() => this.git!.changedSinceBase()).catch(() => [] as string[])
      : [];
    const stat = this.git
      ? await this.serialiseGit(() => this.git!.diffStat()).catch(() => "")
      : "";

    const instructions = [
      `Goal from the user: ${goal}`,
      "",
      `You are already inside a checkout of the integration branch${this.git ? ` "${this.git.integrationBranch}"` : ""}.`,
      "The files below are the ones this run changed; read them directly.",
      "",
      files.length > 0
        ? `Changed files:\n${files.map((file) => `- ${file}`).join("\n")}`
        : "No changed-file list is available; inspect the workspace yourself.",
      stat.length > 0 ? `\nDiff stat:\n${stat}` : "",
      "",
      "Tasks reported by the team:",
      ...tasks
        .filter((task) => task.status === "done")
        .map((task) => `- ${task.role}: ${task.title}`),
      "",
      "How to review, efficiently (you have a limited number of steps):",
      "1. Read SPEC.md and only the changed files listed above. Do not scan the whole repo.",
      "2. Run the project's test command once, then the type check if the project has one.",
      "3. Check each acceptance criterion against what you read.",
      "4. Call submit_report. Do not fix product code: your write scope is tests only.",
      "",
      REVIEW_SCHEMA_DESCRIPTION,
    ]
      .filter((line) => line !== "")
      .join("\n");

    const taskId = newTaskId();
    const record: TaskRecord = {
      id: taskId,
      runId,
      parentId: null,
      role: reviewer.role.id,
      title: `Review round ${round} of ${maxRounds}`,
      instructions,
      status: "review",
      dependsOn: [],
      acceptanceCriteria: ["A verdict with concrete issues when the work is not acceptable"],
      branch: null,
      report: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.store.createTask(record);
    this.emit({
      type: "task.created",
      payload: {
        taskId,
        role: record.role,
        title: record.title,
        reviewRound: round,
      },
    });
    this.emit({
      type: "task.started",
      payload: { taskId, role: record.role, title: record.title, agentId },
    });

    // The reviewer gets a worktree cut from the integration branch, exactly like
    // a task, so it sees the merged result and cannot touch the user's checkout.
    const worktree = this.worktrees ? await this.createWorktree(record) : null;

    let result: AgentRunResult;
    try {
      result = await this.runAgentWithTimeout(
        agent,
        {
          id: taskId,
          title: record.title,
          instructions,
          acceptanceCriteria: record.acceptanceCriteria,
        },
        runId,
        taskId,
        undefined,
        worktree,
        // Reviews read a lot and run tests, so give them a floor of 30 steps
        // even when the global per-task cap is lower.
        Math.max(this.limits.maxStepsPerTask, 30),
      );
    } catch (error) {
      // A reviewer that crashes or times out is inconclusive, not a failed run.
      const message = (error as Error).message;
      const report: Report = {
        status: "blocked",
        summary: `Reviewer failed: ${message}`,
        filesChanged: [],
        commandsRun: [],
        openIssues: [`Reviewer error: ${message}`],
      };
      this.store.updateTask(taskId, {
        status: "blocked",
        report,
        finishedAt: new Date().toISOString(),
      });
      this.store.updateAgent(agentId, { state: "error" });
      this.emit({
        type: "task.failed",
        payload: {
          taskId,
          role: record.role,
          title: record.title,
          agentId,
          status: "blocked",
          summary: report.summary,
        },
      });
      this.emit({
        type: "error",
        payload: { message, code: "review_error", taskId, agentId },
      });
      if (worktree) {
        await this.serialiseGit(() => this.git!.removeWorktree(worktree.path)).catch(
          () => undefined,
        );
      }
      return {
        verdict: {
          approved: false,
          issues: [message],
          summary: report.summary,
          inconclusive: true,
        },
        task: this.store.getTask(taskId) ?? { ...record, status: "blocked", report },
      };
    }

    const report: Report = result.report ?? {
      status: "blocked",
      summary: result.text || "The reviewer produced no report",
      filesChanged: [],
      commandsRun: [],
      openIssues: ["Reviewer did not call submit_report"],
    };
    const verdict = verdictFromReport(report);
    const status = verdict.approved ? "done" : "blocked";

    // A reviewer only writes tests, so its work is kept on its branch and never
    // merged: review findings are reported through the verdict, not the diff.
    if (worktree) {
      await this.serialiseGit(() => this.git!.removeWorktree(worktree.path)).catch(
        () => undefined,
      );
    }

    this.store.updateTask(taskId, {
      status,
      report,
      finishedAt: new Date().toISOString(),
    });
    this.store.updateAgent(agentId, { state: verdict.approved ? "done" : "error" });
    this.emit({
      type: verdict.approved ? "task.completed" : "task.failed",
      payload: {
        taskId,
        role: record.role,
        title: record.title,
        agentId,
        status: report.status,
        summary: report.summary,
      },
    });

    return { verdict, task: this.store.getTask(taskId) ?? { ...record, status, report } };
  }

  /** Turn review issues into tasks that run on the integration branch. */
  private persistFixTasks(
    runId: string,
    reviewTask: TaskRecord,
    round: number,
    issues: readonly string[],
    verdict: ReviewVerdict,
  ): TaskRecord[] {
    const reviewerRole = reviewTask.role;
    const candidates = this.team.workers.filter((worker) => worker.role.id !== reviewerRole);
    const fallback =
      candidates.find((worker) => worker.role.id === "backend") ?? candidates[0];

    const created: TaskRecord[] = [];
    for (const issue of issues) {
      const role = this.guessRoleForIssue(issue, candidates) ?? fallback;
      if (!role) continue;
      const id = newTaskId();
      const record: TaskRecord = {
        id,
        runId,
        parentId: reviewTask.id,
        role: role.role.id,
        title: `Fix round ${round}: ${issue.slice(0, 60)}`,
        instructions: buildFixInstructions({
          round,
          originalTitle: reviewTask.title,
          originalRole: role.role.id,
          issues: [issue],
          reviewSummary: verdict.summary,
        }),
        status: "pending",
        dependsOn: [],
        acceptanceCriteria: [`The issue is fixed: ${issue.slice(0, 120)}`],
        branch: null,
        report: null,
        startedAt: null,
        finishedAt: null,
      };
      this.store.createTask(record);
      this.emit({
        type: "task.created",
        payload: {
          taskId: id,
          role: record.role,
          title: record.title,
          fixRound: round,
        },
      });
      created.push(record);
    }
    return created;
  }

  /** Cheap keyword routing so a docs problem goes to docs, not backend. */
  private guessRoleForIssue(
    issue: string,
    candidates: readonly TeamMember[],
  ): TeamMember | undefined {
    const text = issue.toLowerCase();
    const rules: Array<[RegExp, string]> = [
      [/readme|docs?\/|documentation|changelog/, "docs"],
      [/docker|ci\b|workflow|github actions|deploy|infra/, "devops"],
      [/test|spec\b|coverage|assert/, "qa"],
      [/css|style|component|react|ui\b|page|frontend/, "frontend"],
      [/api\b|route|database|auth|server|endpoint|backend/, "backend"],
    ];
    for (const [pattern, roleId] of rules) {
      if (!pattern.test(text)) continue;
      const match = candidates.find((worker) => worker.role.id === roleId);
      if (match) return match;
    }
    return undefined;
  }

  private async plan(runId: string, goal: string): Promise<Plan> {
    const boss = this.team.boss;
    const agentId = newAgentId("boss");
    const model = boss.role.model;
    this.store.createAgent({
      id: agentId,
      runId,
      role: boss.role.id,
      name: boss.name,
      model,
      state: "idle",
    });

    const agent: AgentRuntime = {
      id: agentId,
      name: boss.name,
      model,
      role: boss.role,
      systemPrompt: this.renderFor(boss.role, boss.name),
    };

    let lastErrors: string[] = [];
    for (let attempt = 1; attempt <= this.limits.planAttempts; attempt++) {
      const task: TaskBrief = {
        id: "planning",
        title: "Plan the goal",
        instructions: [
          `Goal from the user: ${goal}`,
          "",
          `Workspace: ${this.integrationJail?.root ?? this.workspacePath}`,
          `Roles available: ${this.roleIds().join(", ")}`,
          "",
          "Write scopes (a role can only write inside its own list):",
          ...this.team.workers.map(
            (worker) =>
              `- ${worker.role.id}: ${worker.role.scope.write.join(", ") || "(no write scope)"}`,
          ),
          "",
          "Write SPEC.md and NOTES.md, then call submit_plan.",
          "Assign each task to a role that is allowed to write the files it needs.",
          "If the goal needs a file outside every scope, say so in the plan summary instead of assigning an impossible task.",
          lastErrors.length > 0
            ? `Your previous plan was rejected:\n- ${lastErrors.join("\n- ")}\nFix these issues.`
            : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
        acceptanceCriteria: ["A plan with at least one task"],
      };

      const result = await this.runAgentWithTimeout(
        agent,
        task,
        runId,
        "planning",
        attempt > 1
          ? { name: "submit_plan" }
          : (step: number) => (step >= 3 ? { name: "submit_plan" } : undefined),
      );
      if (result.status !== "plan" || !result.plan) {
        lastErrors = ["submit_plan was not called with a valid plan object"];
        continue;
      }

      const validation = validatePlan(result.plan, this.roleIds());
      if (validation.ok) {
        this.store.updateRun(runId, { plan: result.plan, status: "running" });
        await this.commitSpec(runId);
        this.emit({
          type: "plan.created",
          payload: {
            plan: result.plan,
            taskCount: result.plan.tasks.length,
            integrationBranch: this.git?.integrationBranch,
          },
        });
        return result.plan;
      }
      lastErrors = validation.errors;
      this.emit({
        type: "error",
        payload: {
          message: `Plan rejected: ${validation.errors.join("; ")}`,
          code: "plan_invalid",
          agentId,
        },
      });
    }

    throw new Error(`The Boss failed to produce a valid plan: ${lastErrors.join("; ")}`);
  }

  /** Commit SPEC.md / NOTES.md onto the integration branch before fan-out. */
  private async commitSpec(runId: string): Promise<void> {
    if (!this.git || !this.integrationJail) return;
    const git = this.git;
    const path = this.integrationJail.root;
    await this.serialiseGit(() => git.commitAll(path, `spec: plan for ${runId}`)).catch(
      (error: unknown) => {
        this.emit({
          type: "error",
          payload: {
            message: `Could not commit SPEC.md: ${(error as Error).message}`,
            code: "git_commit_failed",
          },
        });
      },
    );
  }

  private persistPlan(
    runId: string,
    plan: Plan,
  ): { tasks: TaskRecord[]; planByTaskId: Map<string, Plan["tasks"][number]> } {
    const tasks: TaskRecord[] = [];
    const planByTaskId = new Map<string, Plan["tasks"][number]>();
    const idMap = new Map<string, string>();

    for (const planTask of plan.tasks) {
      const id = newTaskId();
      idMap.set(planTask.id, id);
      planByTaskId.set(id, planTask);
      const record: TaskRecord = {
        id,
        runId,
        parentId: null,
        role: planTask.role,
        title: planTask.title,
        instructions: planTask.instructions,
        status: "pending",
        dependsOn: [],
        acceptanceCriteria: planTask.acceptanceCriteria,
        branch: null,
        report: null,
        startedAt: null,
        finishedAt: null,
      };
      tasks.push(record);
    }

    // Second pass: rewrite plan ids into store ids now that all exist.
    for (const record of tasks) {
      const planTask = planByTaskId.get(record.id);
      record.dependsOn = (planTask?.dependsOn ?? []).map((dep) => idMap.get(dep) ?? dep);
      this.store.createTask(record);
      this.emit({
        type: "task.created",
        payload: {
          taskId: record.id,
          role: record.role,
          title: record.title,
          dependsOn: record.dependsOn,
        },
      });
    }
    return { tasks, planByTaskId };
  }

  /** Dependency-graph scheduler with a concurrency limit. */
  private async execute(
    runId: string,
    tasks: TaskRecord[],
    planByTaskId: Map<string, Plan["tasks"][number]>,
  ): Promise<TaskRecord[]> {
    this.store.updateRun(runId, { status: "running" });
    const completed = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const failed = new Set<string>();

    while (completed.size + failed.size < tasks.length) {
      // Mark tasks whose dependency failed before computing what is ready.
      for (const task of tasks) {
        if (completed.has(task.id) || failed.has(task.id) || running.has(task.id)) continue;
        if (task.dependsOn.some((dep) => failed.has(dep))) {
          failed.add(task.id);
          this.store.updateTask(task.id, { status: "blocked", finishedAt: new Date().toISOString() });
          this.emit({
            type: "task.failed",
            payload: {
              taskId: task.id,
              role: task.role,
              title: task.title,
              status: "blocked",
              summary: "A dependency failed",
            },
          });
        }
      }

      if (this.budget.isPaused || this.budget.isStopped) {
        for (const task of tasks) {
          if (completed.has(task.id) || failed.has(task.id) || running.has(task.id)) continue;
          failed.add(task.id);
          this.store.updateTask(task.id, { status: "cancelled" });
        }
        break;
      }

      const ready = tasks.filter((task) => {
        if (completed.has(task.id) || failed.has(task.id) || running.has(task.id)) return false;
        return task.dependsOn.every((dep) => completed.has(dep));
      });

      if (ready.length === 0 && running.size === 0) {
        const remaining = tasks.filter((task) => !completed.has(task.id) && !failed.has(task.id));
        for (const task of remaining) {
          failed.add(task.id);
          this.store.updateTask(task.id, { status: "cancelled" });
        }
        break;
      }

      for (const task of ready) {
        if (running.size >= this.limits.maxConcurrentAgents) break;
        if (failed.has(task.id) || completed.has(task.id)) continue;
        const promise = this.runTask(runId, task, planByTaskId)
          .then((ok) => {
            if (ok) completed.add(task.id);
            else failed.add(task.id);
          })
          .catch((error: unknown) => {
            failed.add(task.id);
            const paused = error instanceof BudgetExceededError;
            const message = (error as Error).message;
            const report: Report = {
              status: "failed",
              summary: message,
              filesChanged: [],
              commandsRun: [],
              openIssues: [message],
            };
            this.store.updateTask(task.id, {
              status: paused ? "blocked" : "failed",
              report,
              finishedAt: new Date().toISOString(),
            });
            this.emit({
              type: "error",
              payload: {
                message,
                code: paused ? "budget_exceeded" : "task_error",
                taskId: task.id,
              },
            });
          })
          .finally(() => {
            running.delete(task.id);
          });
        running.set(task.id, promise);
      }

      if (running.size > 0) {
        await Promise.race(running.values());
      }
    }

    return tasks.map((task) => this.store.getTask(task.id) ?? task);
  }

  private async runTask(
    runId: string,
    task: TaskRecord,
    planByTaskId: Map<string, Plan["tasks"][number]>,
  ): Promise<boolean> {
    const member = this.team.workers.find((worker) => worker.role.id === task.role);
    if (!member) throw new Error(`No team member for role ${task.role}`);

    const agentId = newAgentId(task.role);
    const model = member.role.model;
    this.store.createAgent({
      id: agentId,
      runId,
      role: member.role.id,
      name: member.name,
      model,
      state: "idle",
    });
    this.store.updateTask(task.id, { status: "running", startedAt: new Date().toISOString() });
    this.emit({
      type: "task.assigned",
      payload: { taskId: task.id, role: task.role, title: task.title, agentId },
    });
    this.emit({
      type: "task.started",
      payload: { taskId: task.id, role: task.role, title: task.title, agentId },
    });

    const planTask = planByTaskId.get(task.id);

    const agent: AgentRuntime = {
      id: agentId,
      name: member.name,
      model,
      role: member.role,
      systemPrompt: this.renderFor(member.role, member.name),
    };

    const brief: TaskBrief = {
      id: task.id,
      title: task.title,
      instructions: planTask?.instructions ?? task.instructions,
      acceptanceCriteria: task.acceptanceCriteria,
    };

    // Each task works in its own worktree and branch, so two agents can never
    // overwrite each other's files.
    const worktree = this.worktrees ? await this.createWorktree(task) : null;
    let result: AgentRunResult;
    let committed = false;
    try {
      result = await this.runAgentWithTimeout(agent, brief, runId, task.id, undefined, worktree);
    } finally {
      if (worktree) {
        committed = await this.commitTask(task, worktree);
        if (committed) {
          this.store.updateTask(task.id, { branch: worktree.branch });
        }
      }
    }

    let report: Report = result.report ?? {
      status: "failed",
      summary: result.text || "The agent produced no report",
      filesChanged: [],
      commandsRun: [],
      openIssues: ["No submit_report call"],
    };

    let ok = report.status === "done";

    // Merge immediately, before dependents are scheduled. A dependent task
    // branches from the integration branch, so it must see its dependency.
    if (worktree && committed) {
      const outcome = await this.serialiseGit(() =>
        this.git!.mergeIntoIntegration(worktree.branch),
      );
      if (outcome.status === "merged") {
        this.emit({
          type: "git.merged",
          payload: { taskId: task.id, branch: worktree.branch, detail: outcome.detail },
        });
      } else {
        ok = false;
        report = {
          ...report,
          status: "blocked",
          openIssues: [
            ...report.openIssues,
            `${outcome.status === "conflict" ? "Merge conflict" : "Merge failed"}: ${outcome.detail}`,
          ],
        };
        this.emit({
          type: "git.conflict",
          payload: {
            taskId: task.id,
            branch: worktree.branch,
            status: outcome.status,
            detail: outcome.detail,
            conflicts: outcome.conflicts,
          },
        });
      }
      await this.serialiseGit(() => this.git!.removeWorktree(worktree.path)).catch(
        () => undefined,
      );
    } else if (worktree) {
      // Nothing committed (no changes) or the run failed: keep the branch if it
      // has commits, but free the checkout.
      await this.serialiseGit(() => this.git!.removeWorktree(worktree.path)).catch(
        () => undefined,
      );
    }

    this.store.updateTask(task.id, {
      status: ok ? "done" : report.status === "blocked" ? "blocked" : "failed",
      report,
      finishedAt: new Date().toISOString(),
    });
    this.emit({
      type: ok ? "task.completed" : "task.failed",
      payload: {
        taskId: task.id,
        role: task.role,
        title: task.title,
        agentId,
        status: report.status,
        summary: report.summary,
      },
    });
    this.store.updateAgent(agentId, { state: ok ? "done" : "error" });
    return ok;
  }

  private async runAgentWithTimeout(
    agent: AgentRuntime,
    brief: TaskBrief,
    runId: string,
    taskId: string,
    toolChoice?: { name: string } | ((step: number) => { name: string } | undefined),
    worktree?: Worktree | null,
    maxStepsOverride?: number,
  ): Promise<AgentRunResult> {
    const jail = worktree
      ? await WorkspaceJail.open(worktree.path)
      : (this.integrationJail ?? this.baseJail);
    if (!jail) throw new Error("Workspace is not initialised");

    const controller = new AbortController();
    const timeoutMs = this.limits.taskTimeoutMinutes * 60_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = this.options.signal;
    const onOuterAbort = (): void => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      return await runAgent(agent, brief, {
        runId,
        provider: this.provider,
        budget: this.budget,
        jail,
        limits: {
          maxSteps: maxStepsOverride ?? agent.role.maxSteps,
          toolOutputMaxChars: this.limits.toolOutputMaxChars,
          commandTimeoutMs: this.limits.commandTimeoutMs,
          maxOutputTokens: this.limits.maxOutputTokens,
        },
        emit: (event) => this.emit(event),
        approve: this.options.approve ?? (async () => this.approvalMode === "auto"),
        runCommand: (command, args) => this.execCommand(agent.role, command, args, jail.root),
        messageAgent: (from, to, text) => {
          const queue = this.mailbox.get(to) ?? [];
          queue.push(`${from}: ${text}`);
          this.mailbox.set(to, queue);
          this.emit({ type: "message.sent", payload: { from, to, text } });
        },
        onMessage: (message: Message, step) => {
          this.store.appendMessage({
            taskId,
            agentId: agent.id,
            idx: step,
            role: message.role,
            content: message.content,
          });
        },
        // Each agent gets its own ContextManager sized by its role. Budgets are
        // never shared between agents in the same run.
        context: new ContextManager({
          maxTokens: agent.role.contextTokens ?? this.limits.contextTokens,
          summarise: this.options.summariser,
        }),
        sharedContext: SHARED_CONTEXT,
        roleIds: this.roleIds(),
        toolChoice,
        contextMessages: () => {
          const notes = this.mailbox.get(agent.name) ?? [];
          if (notes.length === 0) return [];
          this.mailbox.set(agent.name, []);
          return [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `Messages from other agents:\n${notes.join("\n")}`,
                },
              ],
            },
          ];
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * Commands go through the policy, then run with a scrubbed environment. The
   * child gets its own process group so a timeout or a cancelled run kills the
   * whole tree, not just the direct child.
   */
  private async execCommand(
    role: Role,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<CommandOutcome> {
    const printable = [command, ...args].join(" ");
    const decision = checkCommand(command, args, {
      allow: role.commands.allow,
      deny: role.commands.deny,
      workspaceRoot: cwd,
    });
    if (!decision.allowed) {
      return {
        command: printable,
        exitCode: 126,
        stdout: "",
        stderr: `POLICY: ${decision.reason ?? "command denied"}`,
        timedOut: false,
      };
    }
    const { spawn } = await import("node:child_process");
    const timeoutMs = this.limits.commandTimeoutMs;
    const outer = this.options.signal;

    // Wrap the command in the configured sandbox. A network command only gets
    // network access after the approval gate has allowed it.
    const sandboxed = await buildSandboxCommand(this.sandboxKind, {
      workspaceRoot: cwd,
      command,
      args,
      env: scrubbedEnv(),
      allowNetwork: decision.risk === "network",
      gitDirs: this.sandboxKind === "bwrap" ? await gitDirsFor(cwd) : undefined,
    });

    return await new Promise<CommandOutcome>((resolve) => {
      const child = spawn(sandboxed.command, sandboxed.args, {
        cwd: sandboxed.command === "bwrap" ? undefined : cwd,
        env: sandboxed.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // New process group, so kill(-pid) reaches grandchildren too.
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const cap = 200_000;

      const killTree = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already gone
          }
        }
      };

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
        resolve({ command: printable, exitCode, stdout, stderr, timedOut });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGKILL");
        // Do not wait forever for a wedged process.
        setTimeout(() => finish(124), 2_000);
      }, timeoutMs);

      const onAbort = (): void => {
        killTree("SIGKILL");
        finish(130);
      };
      outer?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < cap) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < cap) stderr += chunk.toString();
      });
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        finish(127);
      });
      child.on("close", (code) => {
        finish(timedOut ? 124 : (code ?? -1));
      });
    });
  }

  async readSpec(): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.workspacePath, "SPEC.md"), "utf8");
    } catch {
      return null;
    }
  }
}

function isReviewTask(task: TaskRecord): boolean {
  return task.role === "qa" && task.title.startsWith("Review round ");
}

function summarise(goal: string, tasks: TaskRecord[], integrationBranch?: string): string {
  const done = tasks.filter((task) => task.status === "done");
  const failed = tasks.filter((task) => task.status !== "done");
  const lines = [
    `Goal: ${goal}`,
    "",
    `Tasks: ${done.length} done, ${failed.length} not done.`,
  ];
  for (const task of tasks) {
    lines.push(`- [${task.status}] ${task.role}: ${task.title}`);
    if (task.branch) lines.push(`  branch: ${task.branch}`);
    if (task.report?.summary) lines.push(`  ${task.report.summary}`);
    for (const issue of task.report?.openIssues ?? []) lines.push(`  open: ${issue}`);
  }
  if (integrationBranch) {
    lines.push(
      "",
      `Review the result with: git diff ${integrationBranch} -- . `,
      `Merge it yourself with: git merge ${integrationBranch}`,
    );
  }
  return lines.join("\n");
}
