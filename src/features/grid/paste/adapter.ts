/**
 * Staging adapter (no React): applies a `PastePlan` to a `ChangeSet`.
 *
 * Contract:
 *  - `stage(plan, changeSet, { includeExtraRows })` stages every assignment like a typed edit and
 *    makes the whole paste ONE undo step (cells, plus added rows when `includeExtraRows` is true;
 *    `plan.newRows` are always added). Staging nothing is a no-op with no undo step.
 *  - The edits run inside `ChangeSet.group`, which collapses their undo snapshots into one.
 *  - The result's `undo()` reverts the paste only while nothing was staged after it (used by
 *    "Interpret as": undo, re-plan, stage again, and by the notice's Undo button).
 */

import type { ChangeSet } from "../../table-editor/changeSet";
import type { PastePlan } from "./plan";

export interface StageOptions {
  /** Also add `plan.extraRows` as new rows ("Add N rows"). */
  includeExtraRows?: boolean;
}

export interface Staged {
  cells: number;
  rowsAdded: number;
  /** Always true now that `ChangeSet.group` exists; kept so callers need not change. */
  grouped: boolean;
  /** Undo this paste; false when other changes were staged since or nothing was staged. */
  undo(): boolean;
}

export function stage(plan: PastePlan, cs: ChangeSet, opts: StageOptions = {}): Staged {
  const start = cs.undoDepth;
  let cells = 0;
  let rowsAdded = 0;

  cs.group(() => {
    for (const a of plan.assignments) {
      cs.setCell(a.row, a.col, { kind: "value", value: a.value });
      cells++;
    }
    const fresh = [...(plan.newRows ?? []), ...(opts.includeExtraRows ? plan.extraRows : [])];
    for (const r of fresh) {
      const row = cs.addRow();
      rowsAdded++;
      for (const c of r.cells) {
        cs.setCell(row, c.col, { kind: "value", value: c.value });
        cells++;
      }
    }
  });

  const after = cs.undoDepth;
  return {
    cells,
    rowsAdded,
    grouped: true,
    undo: () => (cs.undoDepth === after && after > start ? cs.undo() : false),
  };
}
