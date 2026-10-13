import type { PlanNode } from "./types";

/** The highest db-hit count of the plan (0 when there are none, as in EXPLAIN). */
export function maxDbHits(plan: PlanNode): number {
  return Math.max(plan.dbHits ?? 0, ...plan.children.map(maxDbHits));
}

/** Operators in tree order, with their depth. */
export function flattenPlan(plan: PlanNode, depth = 0): { node: PlanNode; depth: number }[] {
  return [{ node: plan, depth }, ...plan.children.flatMap((c) => flattenPlan(c, depth + 1))];
}
