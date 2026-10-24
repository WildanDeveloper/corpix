import type { Report } from "@corpix/shared";

export const REVIEW_SCHEMA_DESCRIPTION = [
  "Read the diff, run the project's tests, and decide whether the work satisfies the",
  "acceptance criteria. Then call submit_report with:",
  "  status: 'done'    the work is acceptable, no fix needed",
  "  status: 'failed'  the work is broken; list every problem in openIssues",
  "  status: 'blocked' only when you truly cannot check anything (say why in openIssues)",
].join("\n");

export interface ReviewVerdict {
  approved: boolean;
  /** Concrete problems the reviewer found, used to open fix tasks. */
  issues: string[];
  summary: string;
  /** True when QA could not verify anything, so a fix task makes no sense. */
  inconclusive: boolean;
}

export function verdictFromReport(report: Report): ReviewVerdict {
  const issues = report.openIssues.map((issue) => issue.trim()).filter((issue) => issue.length > 0);
  if (report.status === "done") {
    return { approved: true, issues: [], summary: report.summary, inconclusive: false };
  }
  if (report.status === "blocked") {
    // "blocked" with concrete issues means "this is wrong and I cannot finish";
    // with no issues it means "I could not verify", which a fix task cannot solve.
    if (issues.length > 0) {
      return { approved: false, issues, summary: report.summary, inconclusive: false };
    }
    return {
      approved: false,
      issues: [report.summary],
      summary: report.summary,
      inconclusive: true,
    };
  }
  return {
    approved: false,
    issues: issues.length > 0 ? issues : [report.summary],
    summary: report.summary,
    inconclusive: false,
  };
}

/** Cap the number of fix tasks so one review cannot explode the plan. */
export function fixTasksFor(issues: readonly string[], max = 3): string[] {
  return issues.slice(0, max);
}

/**
 * Build the instructions for a fix task. The reviewer's own wording is kept so
 * the fixing agent sees the exact problem rather than a paraphrase.
 */
export function buildFixInstructions(input: {
  round: number;
  originalTitle: string;
  originalRole: string;
  issues: readonly string[];
  reviewSummary: string;
}): string {
  return [
    `Fix the problems a reviewer found in the work for "${input.originalTitle}".`,
    "",
    `Review round: ${input.round}`,
    `Original role: ${input.originalRole}`,
    "",
    "Problems to fix:",
    ...input.issues.map((issue) => `- ${issue}`),
    "",
    `Reviewer summary: ${input.reviewSummary}`,
    "",
    "Read SPEC.md, NOTES.md and the current state of the integration branch first.",
    "Fix only what is listed above. Run the tests again before reporting.",
    "Call submit_report when finished; be explicit about anything still broken.",
  ].join("\n");
}

/** Human-readable line for the run summary. */
export function describeReview(round: number, max: number, verdict: ReviewVerdict): string {
  if (verdict.approved) return `Review ${round}/${max}: approved`;
  if (verdict.inconclusive) return `Review ${round}/${max}: could not verify`;
  return `Review ${round}/${max}: ${verdict.issues.length} issue(s) found`;
}
