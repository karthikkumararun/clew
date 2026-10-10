import { CompactSelection } from "@glideapps/glide-data-grid";
import type { GridSelection } from "@glideapps/glide-data-grid";

/** What is selected, as lists of display-column and row indexes. */
export interface SelectedCells {
  cols: number[];
  rows: number[];
}

const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

export const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

/**
 * The cells a selection covers: whole rows (all columns), whole columns (all rows), or the
 * rectangle of a range / single cell. Nothing selected gives an empty set.
 */
export function selectedCells(
  sel: GridSelection,
  rowCount: number,
  colCount: number,
): SelectedCells {
  const allCols = range(0, colCount);
  if (sel.rows.length > 0) return { rows: [...sel.rows], cols: allCols };
  if (sel.columns.length > 0) return { rows: range(0, rowCount), cols: [...sel.columns] };
  const r = sel.current?.range;
  if (!r) return { rows: [], cols: [] };
  return {
    rows: range(r.y, Math.min(r.y + r.height, rowCount)),
    cols: range(r.x, Math.min(r.x + r.width, colCount)),
  };
}
