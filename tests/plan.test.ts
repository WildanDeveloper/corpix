import { describe, expect, it } from "vitest";
import {
  makePlanSchema,
  validatePlan,
  type Plan,
} from "@corpix/shared";

function validPlan(): Plan {
  return {
    summary: "Two parallel tasks",
    tasks: [
      {
        id: "t1",
        role: "backend",
        title: "API",
        instructions: "Build the API",
        dependsOn: [],
        acceptanceCriteria: ["GET /health returns 200"],
      },
      {
        id: "t2",
        role: "frontend",
        title: "UI",
        instructions: "Build the UI",
        dependsOn: ["t1"],
        acceptanceCriteria: ["The page renders"],
      },
    ],
  };
}

describe("makePlanSchema", () => {
  it("accepts known roles", () => {
    const schema = makePlanSchema(["boss", "backend", "frontend"]);
    expect(schema.safeParse(validPlan()).success).toBe(true);
  });

  it("rejects unknown roles", () => {
    const schema = makePlanSchema(["boss", "backend"]);
    const result = schema.safeParse(validPlan());
    expect(result.success).toBe(false);
  });

  it("requires at least one acceptance criterion", () => {
    const schema = makePlanSchema(["backend"]);
    const plan = validPlan();
    plan.tasks[0]!.acceptanceCriteria = [];
    expect(schema.safeParse(plan).success).toBe(false);
  });
});

describe("validatePlan", () => {
  it("accepts a valid graph and returns a topological order", () => {
    const result = validatePlan(validPlan(), ["boss", "backend", "frontend"]);
    expect(result.ok).toBe(true);
    expect(result.order).toEqual(["t1", "t2"]);
  });

  it("rejects duplicate ids", () => {
    const plan = validPlan();
    plan.tasks[1]!.id = "t1";
    const result = validatePlan(plan, ["backend", "frontend"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Duplicate task id/);
  });

  it("rejects dependencies on missing tasks", () => {
    const plan = validPlan();
    plan.tasks[1]!.dependsOn = ["nope"];
    const result = validatePlan(plan, ["backend", "frontend"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/missing task/);
  });

  it("rejects self-dependencies", () => {
    const plan = validPlan();
    plan.tasks[0]!.dependsOn = ["t1"];
    const result = validatePlan(plan, ["backend", "frontend"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/depends on itself/);
  });

  it("detects cycles", () => {
    const plan = validPlan();
    plan.tasks[0]!.dependsOn = ["t2"];
    plan.tasks[1]!.dependsOn = ["t1"];
    const result = validatePlan(plan, ["backend", "frontend"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cycle/);
  });

  it("rejects unknown roles", () => {
    const plan = validPlan();
    plan.tasks[1]!.role = "designer";
    const result = validatePlan(plan, ["backend", "frontend"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unknown role/);
  });

  it("enforces the max task count", () => {
    const result = validatePlan(validPlan(), ["backend", "frontend"], { maxTasks: 1 });
    expect(result.ok).toBe(false);
  });
});

describe("placeholder plans", () => {
  function planWith(patch: Partial<Plan["tasks"][number]>): Plan {
    const plan = validPlan();
    plan.tasks[0] = { ...plan.tasks[0]!, ...patch };
    return plan;
  }

  it("rejects a plan made of literal placeholders", () => {
    const plan: Plan = {
      summary: "placeholder",
      tasks: [
        {
          id: "placeholder",
          role: "docs",
          title: "placeholder",
          instructions: "placeholder",
          dependsOn: [],
          acceptanceCriteria: ["placeholder"],
        },
      ],
    };
    const result = validatePlan(plan, ["boss", "docs"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/placeholder/i);
  });

  it("rejects an empty instruction even when the title looks fine", () => {
    const result = validatePlan(planWith({ instructions: "todo" }), ["boss", "backend", "frontend"]);
    expect(result.ok).toBe(false);
  });

  it("still accepts a short but real title", () => {
    const result = validatePlan(planWith({ title: "UI" }), ["boss", "backend", "frontend"]);
    expect(result.ok).toBe(true);
  });
});
