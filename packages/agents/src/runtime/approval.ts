import type { ApprovalMode } from "@corpix/shared";
import type { ApprovalDecider, ApprovalRequest } from "../tools";

/** Commands that change dependencies or fetch from the network. */
const NETWORKISH = /\b(install|add|update|upgrade|publish|clone|curl|wget)\b/i;

/**
 * Decide automatically only when the mode allows it. `safe` and `write` never
 * reach the approver; this only covers `exec` / `network`.
 *
 * `auto-safe` approves allowlisted, non-install commands; everything else asks.
 */
export function shouldAutoApprove(mode: ApprovalMode, request: ApprovalRequest): boolean {
  if (mode === "auto") return true;
  if (mode === "auto-safe") {
    return request.risk === "exec" && !NETWORKISH.test(request.summary);
  }
  return false;
}

/** Wrap a human prompt with the mode rules, so CLI and server behave the same. */
export function approvalDecider(
  mode: ApprovalMode,
  ask: (request: ApprovalRequest) => Promise<boolean>,
): ApprovalDecider {
  return async (request) => {
    if (shouldAutoApprove(mode, request)) return true;
    return await ask(request);
  };
}
