import { z } from "zod";

export const PlanTaskSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const PlanSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(PlanTaskSchema).min(1),
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/**
 * The plan schema is built at runtime so the role enum always matches the
 * loaded team. `roleIds` must not be empty.
 */
export function makePlanSchema(roleIds: readonly string[]) {
  const [first, ...rest] = roleIds;
  if (!first) throw new Error("makePlanSchema needs at least one role id");
  const role = z.enum([first, ...rest] as [string, ...string[]]);
  return z.object({
    summary: z.string().min(1),
    tasks: z
      .array(PlanTaskSchema.extend({ role }))
      .min(1),
  });
}

export interface PlanValidationResult {
  ok: boolean;
  errors: string[];
  /** Valid topological order when `ok` is true. */
  order: string[];
}

/**
 * Validate a plan: unique ids, known roles, existing dependencies, no cycles.
 * The dependency check runs before Kahn's algorithm so the error is readable.
 */
export function validatePlan(
  plan: Plan,
  roleIds: readonly string[],
  options: { maxTasks?: number } = {},
): PlanValidationResult {
  const errors: string[] = [];
  const knownRoles = new Set(roleIds);
  const ids = new Set<string>();

  if (options.maxTasks !== undefined && plan.tasks.length > options.maxTasks) {
    errors.push(`Plan has ${plan.tasks.length} tasks, the limit is ${options.maxTasks}`);
  }

  for (const task of plan.tasks) {
    if (ids.has(task.id)) errors.push(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!knownRoles.has(task.role)) {
      errors.push(`Task ${task.id} uses unknown role "${task.role}"`);
    }
    if (task.dependsOn.includes(task.id)) {
      errors.push(`Task ${task.id} depends on itself`);
    }
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        errors.push(`Task ${task.id} depends on missing task "${dep}"`);
      }
    }
  }

  // Kahn's algorithm; leftover nodes mean at least one cycle.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of plan.tasks) {
    indegree.set(task.id, task.dependsOn.filter((d) => ids.has(d)).length);
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) continue;
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }

  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) queue.push(next);
    }
  }

  if (order.length !== plan.tasks.length) {
    const stuck = plan.tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    errors.push(`Dependency cycle involving: ${stuck.join(", ")}`);
  }

  return { ok: errors.length === 0, errors, order };
}

/** Tasks that can start now, given a set of completed task ids. */
export function readyTasks(plan: Plan, completed: ReadonlySet<string>): PlanTask[] {
  return plan.tasks.filter(
    (t) => !completed.has(t.id) && t.dependsOn.every((dep) => completed.has(dep)),
  );
}
