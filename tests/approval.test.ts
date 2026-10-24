import { describe, expect, it } from "vitest";
import { shouldAutoApprove } from "@corpix/agents";
import type { ApprovalRequest } from "@corpix/agents";

function request(risk: ApprovalRequest["risk"], summary: string): ApprovalRequest {
  return { agentId: "a", tool: "run_command", risk, input: {}, summary };
}

describe("approval modes", () => {
  it("ask never auto-approves", () => {
    expect(shouldAutoApprove("ask", request("exec", "node --test"))).toBe(false);
    expect(shouldAutoApprove("ask", request("network", "pnpm add zod"))).toBe(false);
  });

  it("auto approves everything", () => {
    expect(shouldAutoApprove("auto", request("exec", "node --test"))).toBe(true);
    expect(shouldAutoApprove("auto", request("network", "pnpm add zod"))).toBe(true);
  });

  it("auto-safe approves allowlisted test/lint/build commands", () => {
    expect(shouldAutoApprove("auto-safe", request("exec", "node --test"))).toBe(true);
    expect(shouldAutoApprove("auto-safe", request("exec", "pnpm test"))).toBe(true);
    expect(shouldAutoApprove("auto-safe", request("exec", "tsc --noEmit"))).toBe(true);
  });

  it("auto-safe still asks for installs and network access", () => {
    expect(shouldAutoApprove("auto-safe", request("exec", "pnpm add zod"))).toBe(false);
    expect(shouldAutoApprove("auto-safe", request("exec", "npm install"))).toBe(false);
    expect(shouldAutoApprove("auto-safe", request("exec", "git clone https://x/y"))).toBe(false);
    expect(shouldAutoApprove("auto-safe", request("network", "curl https://x"))).toBe(false);
  });
});
