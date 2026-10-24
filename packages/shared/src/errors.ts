/** Error types shared by the runtime, tools and orchestrator. */

export class CorpixError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class StepLimitError extends CorpixError {
  constructor(
    readonly agentId: string,
    readonly taskId: string,
    readonly steps: number,
  ) {
    super(`Agent ${agentId} hit the step limit (${steps}) on task ${taskId}`, "step_limit");
  }
}

export class BudgetExceededError extends CorpixError {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `Budget exceeded: spent $${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)}`,
      "budget_exceeded",
    );
  }
}

export class ScopeError extends CorpixError {
  constructor(message: string) {
    super(message, "scope_violation");
  }
}

export class PolicyError extends CorpixError {
  constructor(message: string) {
    super(message, "policy_violation");
  }
}

export class ApprovalDeniedError extends CorpixError {
  constructor(message: string) {
    super(message, "approval_denied");
  }
}

export class PlanValidationError extends CorpixError {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message, "plan_invalid");
  }
}

export class ProviderError extends CorpixError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message, "provider_error");
  }
}

export class TimeoutError extends CorpixError {
  constructor(message: string) {
    super(message, "timeout");
  }
}

export class CancelledError extends CorpixError {
  constructor(message = "Run cancelled") {
    super(message, "cancelled");
  }
}
