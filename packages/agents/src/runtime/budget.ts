import {
  BudgetExceededError,
  type BudgetAction,
  type Pricing,
  type Usage,
} from "@corpix/shared";

export interface UsageRecord {
  agentId: string;
  taskId: string;
  model: string;
  usage: Usage;
  costUsd: number;
  ts: string;
}

export interface BudgetOptions {
  budgetUsd: number;
  action: BudgetAction;
  pricing: Pricing;
  /** Spend already recorded before a resume. */
  initialSpentUsd?: number;
  onRecord?: (record: UsageRecord) => void;
}

/**
 * Tracks spend per run. The check runs after every provider response, exactly
 * as described in "Cost control": pause (default) or stop.
 */
export class BudgetGuard {
  private spent = 0;
  private paused = false;
  private stopped = false;
  readonly records: UsageRecord[] = [];

  constructor(private readonly options: BudgetOptions) {
    this.spent = options.initialSpentUsd ?? 0;
    if (this.spent >= options.budgetUsd) {
      if (options.action === "stop") this.stopped = true;
      else this.paused = true;
    }
  }

  get spentUsd(): number {
    return this.spent;
  }

  get budgetUsd(): number {
    return this.options.budgetUsd;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Cost of one response, using the pricing table (0 for unknown models). */
  costOf(model: string, usage: Usage): number {
    const price = this.options.pricing[model];
    if (!price) return 0;
    const cached = usage.cachedInputTokens ?? 0;
    const fresh = Math.max(usage.inputTokens - cached, 0);
    return (
      (fresh / 1_000_000) * price.input +
      (cached / 1_000_000) * (price.cached_input ?? price.input) +
      (usage.outputTokens / 1_000_000) * price.output
    );
  }

  record(agentId: string, taskId: string, model: string, usage: Usage): UsageRecord {
    const costUsd = this.costOf(model, usage);
    this.spent += costUsd;
    const record: UsageRecord = {
      agentId,
      taskId,
      model,
      usage,
      costUsd,
      ts: new Date().toISOString(),
    };
    this.records.push(record);
    this.options.onRecord?.(record);
    if (this.spent >= this.options.budgetUsd) {
      if (this.options.action === "stop") this.stopped = true;
      else this.paused = true;
    }
    return record;
  }

  /** Throws when the run must not continue. */
  assertWithinLimits(): void {
    if (this.stopped) throw new BudgetExceededError(this.spent, this.options.budgetUsd);
    if (this.paused) throw new BudgetExceededError(this.spent, this.options.budgetUsd);
  }

  /** Called by the API when a paused run is resumed with a higher cap. */
  resume(extraUsd = 0): void {
    this.paused = false;
    this.stopped = false;
    if (extraUsd > 0) {
      (this.options as { budgetUsd: number }).budgetUsd += extraUsd;
    }
  }
}
