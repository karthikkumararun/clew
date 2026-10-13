/**
 * Contract: shared input of the Tree and Text views. `storeRows` are the store row indexes to
 * show, in display order (the selection, or every visible row); `cols` the source columns to
 * show (default all). `table` and `flavor` name the target of SQL INSERT output.
 */
import { useMemo } from "react";
import type { GridSource } from "../../grid/source";
import type { SqlFlavor } from "../../grid/sqlLiteral";
import { pickData } from "../../grid/tools/viewAs";
import type { ExtractorColumn, ExtractorData, ExtractorOptions } from "../../grid/tools/viewAs";
import type { ExtractorController } from "./useExtractorOptions";

export interface ResultViewProps {
  source: GridSource;
  columns: ExtractorColumn[];
  storeRows: ArrayLike<number>;
  cols?: readonly number[];
  extractor: ExtractorController;
  transpose: boolean;
  /** Already-quoted table name for SQL INSERT. */
  table?: string;
  flavor?: SqlFlavor;
  /** Cap on rows laid out (default 1000); a note says when rows were left out. */
  maxRows?: number;
  /** Row number shown for the first row (default 1). */
  firstRow?: number;
}

export const DEFAULT_MAX_ROWS = 1000;

export function useResultData(p: ResultViewProps): {
  data: ExtractorData;
  options: ExtractorOptions;
  shown: number;
  total: number;
} {
  const { source, columns, storeRows, cols, table, flavor, maxRows = DEFAULT_MAX_ROWS } = p;
  const base = p.extractor.options;
  const options = useMemo(
    () => ({ ...base, ...(table ? { table } : {}), ...(flavor ? { flavor } : {}) }),
    [base, table, flavor],
  );
  const total = storeRows.length;
  const shown = Math.min(total, maxRows);
  const data = useMemo(
    () => pickData(source, columns, Array.from({ length: shown }, (_, i) => storeRows[i]), cols),
    // `source.version` changes when rows are replaced or appended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, source.version, columns, storeRows, cols, shown],
  );
  return { data, options, shown, total };
}
