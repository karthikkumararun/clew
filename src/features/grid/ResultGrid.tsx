import { CompactSelection, DataEditor, GridCellKind } from "@glideapps/glide-data-grid";
import type {
  DrawCellCallback,
  DrawHeaderCallback,
  GridCell,
  GridColumn,
  GridSelection,
  Item,
  Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Value } from "../../lib/ipc/drivers";
import { CellViewer } from "./CellViewer";
import { lookOf } from "./cellStyle";
import type { CellLook } from "./cellStyle";
import { format } from "./copyFormats";
import type { CopyData, CopyFormat } from "./copyFormats";
import { EMPTY_SELECTION, selectedCells } from "./selection";
import type { SelectedCells } from "./selection";
import type { GridSource } from "./source";
import { flavorOf, quoteIdent } from "./sqlLiteral";
import { HEADER_HEIGHT, ROW_HEIGHT, gridTheme, token } from "./theme";
import { visibleColumns, moveColumn } from "./views";
import type { SortState } from "./views";
import styles from "./ResultGrid.module.css";

const MIN_WIDTH = 48;
const MAX_WIDTH = 720;
const AUTO_MIN = 72;
const AUTO_MAX = 360;
const CHAR = 7.4;
const ROW_MARKER_WIDTH = 52;
const NEAR_END_ROWS = 8;
const COL_PREFIX = "c";

/** Per-row / per-cell state a table editor paints over the data (pending changes). */
export interface GridDecorations {
  /** Row tint token and marker for an inserted / deleted / edited row. */
  row?: (row: number) => { bg?: string; marker?: "+" | "−"; strike?: boolean } | undefined;
  /** Cells to ring as edited, or flag as failed. */
  cell?: (col: number, row: number) => "edited" | "error" | undefined;
}

export interface GridHandle {
  /** The selected cells in display coordinates. */
  selection(): SelectedCells;
  /** The selected cells as copyable data (headers + rows), if anything is selected. */
  selectedData(): CopyData | null;
  /** Copy the selection in a format to the clipboard; resolves with the number of rows copied. */
  copyAs(as: CopyFormat): Promise<number>;
  /** Show the value viewer for a displayed cell. */
  openViewer(col: number, row: number): void;
  /** Make the grid take keyboard focus. */
  focus(): void;
}

export interface ResultGridProps {
  source: GridSource;
  /** Driver id, for quoting in copied INSERT statements. */
  driver: string;
  /** Already-quoted table name used by Copy as SQL INSERT. */
  tableName?: string;
  /** Source columns that are foreign keys (drawn as links). */
  fkColumns?: ReadonlySet<number>;
  sort?: SortState | null;
  onSort?: (column: number) => void;
  hidden?: ReadonlySet<number>;
  /** Source column indexes in display order. */
  order?: number[];
  onOrderChange?: (visible: number[]) => void;
  widths?: Record<number, number>;
  onWidthsChange?: (widths: Record<number, number>) => void;
  /** The last rows are in view; ask for more. */
  onNearEnd?: () => void;
  /** For a truncated cell: how to fetch the whole value. */
  fetchFull?: (col: number, row: number) => Promise<Value> | undefined;
  onSelectionChange?: (cells: SelectedCells) => void;
  /** A double-click / Enter on a cell, when the parent handles it (editing). */
  onActivate?: (col: number, row: number) => boolean | void;
  decorations?: GridDecorations;
  readOnly?: boolean;
}

/** Width that fits the header and the first rows of a column. */
export function autoWidth(source: GridSource, col: number): number {
  const meta = source.columns[col];
  let longest = Math.max(meta?.name.length ?? 0, meta?.type_name.length ?? 0);
  const n = Math.min(source.rowCount, 200);
  for (let r = 0; r < n; r++) {
    const len = lookOf(source.get(col, r)).text.length;
    if (len > longest) longest = len;
  }
  return Math.min(AUTO_MAX, Math.max(AUTO_MIN, Math.ceil(longest * CHAR) + 28));
}

/** The shared canvas grid: console results and the table editor. */
export const ResultGrid = forwardRef<GridHandle, ResultGridProps>(function ResultGrid(props, ref) {
  const {
    source,
    driver,
    fkColumns,
    sort,
    onSort,
    hidden,
    order,
    onOrderChange,
    widths,
    onWidthsChange,
    onNearEnd,
    fetchFull,
    onSelectionChange,
    onActivate,
    decorations,
    readOnly = true,
  } = props;

  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const [viewer, setViewer] = useState<{ col: number; row: number } | null>(null);
  const [autoWidths, setAutoWidths] = useState<Record<number, number>>({});
  const theme = useMemo<Theme>(() => gridTheme(), []);
  const flavor = flavorOf(driver);

  const visible = useMemo(
    () => visibleColumns(source.columns.length, order ?? [], hidden ?? new Set<number>()),
    [source.columns.length, order, hidden],
  );

  // Selection resets when the shape of the result changes.
  const shape = `${source.columns.length}:${visible.join(",")}`;
  useEffect(() => setSelection(EMPTY_SELECTION), [shape]);

  const widthOf = useCallback(
    (c: number) => widths?.[c] ?? autoWidths[c] ?? autoWidth(source, c),
    [widths, autoWidths, source],
  );

  const columns = useMemo<GridColumn[]>(
    () =>
      visible.map((c) => ({
        id: `${COL_PREFIX}${c}`,
        title: source.columns[c]?.name ?? "",
        width: widthOf(c),
      })),
    // `version` makes widths follow newly loaded rows only when the user hasn't set them
    [visible, source.columns, widthOf],
  );

  const themeOverrides = useRef(new Map<string, Partial<Theme>>());
  const overrideFor = (look: CellLook): Partial<Theme> => {
    const key = `${look.token}|${look.italic}`;
    let o = themeOverrides.current.get(key);
    if (!o) {
      o = {
        textDark: token(look.token),
        ...(look.italic ? { baseFontStyle: `italic ${theme.baseFontStyle}` } : {}),
      };
      themeOverrides.current.set(key, o);
    }
    return o;
  };

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const sc = visible[col];
      const look = lookOf(source.get(sc, row), { foreignKey: fkColumns?.has(sc) });
      return {
        kind: GridCellKind.Text,
        data: look.text,
        displayData: look.text,
        copyData: look.copy,
        allowOverlay: false,
        readonly: true,
        contentAlign: look.align,
        themeOverride: overrideFor(look),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, source, source.version, fkColumns, theme],
  );

  const selectionCells = useCallback(
    () => selectedCells(selection, source.rowCount, visible.length),
    [selection, source.rowCount, visible.length],
  );

  const dataOf = useCallback(
    (cells: SelectedCells): CopyData | null => {
      if (cells.rows.length === 0 || cells.cols.length === 0) return null;
      const sc = cells.cols.map((c) => visible[c]);
      return {
        columns: sc.map((c) => source.columns[c]?.name ?? ""),
        rows: cells.rows.map((r) => sc.map((c) => source.get(c, r))),
      };
    },
    [visible, source],
  );

  useImperativeHandle(
    ref,
    () => ({
      selection: selectionCells,
      selectedData: () => dataOf(selectionCells()),
      copyAs: async (as) => {
        const data = dataOf(selectionCells());
        if (!data) return 0;
        const table = props.tableName ?? quoteIdent(flavor, "table_name");
        await navigator.clipboard.writeText(format(data, as, { flavor, table }));
        return data.rows.length;
      },
      openViewer: (col, row) => setViewer({ col, row }),
      focus: () =>
        document.querySelector<HTMLCanvasElement>("[data-testid='data-grid-canvas']")?.focus(),
    }),
    [selectionCells, dataOf, flavor, props.tableName],
  );

  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      const { ctx, rect, column, theme: t, isSelected } = args;
      if (!column.id?.startsWith(COL_PREFIX)) {
        drawContent();
        return;
      }
      const sc = Number(column.id.slice(COL_PREFIX.length));
      const meta = source.columns[sc];
      const pad = t.cellHorizontalPadding;
      const arrow = sort && sort.column === sc ? (sort.dir === "asc" ? "↑" : "↓") : "";
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.textBaseline = "middle";
      ctx.font = `${isSelected ? 600 : 500} ${t.baseFontStyle} ${t.fontFamily}`;
      ctx.fillStyle = isSelected ? t.textHeaderSelected : t.textHeader;
      const nameMax = rect.width - pad * 2 - (arrow ? 16 : 0);
      ctx.fillText(clip(ctx, meta?.name ?? column.title, nameMax), rect.x + pad, rect.y + 14);
      ctx.font = `10.5px ${t.fontFamily}`;
      ctx.fillStyle = t.textLight;
      ctx.fillText(
        clip(ctx, meta?.type_name ?? "", rect.width - pad * 2),
        rect.x + pad,
        rect.y + 29,
      );
      if (arrow) {
        ctx.font = `600 13px ${t.fontFamily}`;
        ctx.fillStyle = t.accentColor;
        ctx.textAlign = "right";
        ctx.fillText(arrow, rect.x + rect.width - pad, rect.y + 14);
      }
      ctx.restore();
    },
    [source, sort],
  );

  const deco = decorations;
  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      const { ctx, rect, col, row, theme: t } = args;
      const sc = visible[col];
      if (sc === undefined) return;
      const look = lookOf(source.get(sc, row), { foreignKey: fkColumns?.has(sc) });
      const rowDeco = deco?.row?.(row);
      if (look.underline && look.align === "left") {
        ctx.save();
        ctx.font = `${t.baseFontStyle} ${t.fontFamily}`;
        const w = Math.min(
          ctx.measureText(look.text).width,
          rect.width - t.cellHorizontalPadding * 2,
        );
        ctx.strokeStyle = t.linkColor;
        ctx.lineWidth = 1;
        const y = rect.y + rect.height / 2 + 7;
        ctx.beginPath();
        ctx.moveTo(rect.x + t.cellHorizontalPadding, y);
        ctx.lineTo(rect.x + t.cellHorizontalPadding + w, y);
        ctx.stroke();
        ctx.restore();
      }
      if (rowDeco?.strike) {
        ctx.save();
        ctx.strokeStyle = token("danger");
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(rect.x + 4, rect.y + rect.height / 2);
        ctx.lineTo(rect.x + rect.width - 4, rect.y + rect.height / 2);
        ctx.stroke();
        ctx.restore();
      }
      if (rowDeco?.marker && col === 0) {
        ctx.save();
        ctx.font = `700 12px ${t.fontFamily}`;
        ctx.fillStyle = token(rowDeco.marker === "+" ? "success" : "danger");
        ctx.textBaseline = "middle";
        ctx.fillText(rowDeco.marker, rect.x - 14, rect.y + rect.height / 2);
        ctx.restore();
      }
      const cellState = deco?.cell?.(sc, row);
      if (cellState) {
        ctx.save();
        ctx.strokeStyle = token(cellState === "error" ? "danger" : "accent");
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.width - 3, rect.height - 3);
        ctx.restore();
      }
    },
    [visible, source, fkColumns, deco],
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      const bg = deco?.row?.(row)?.bg;
      return bg ? { bgCell: token(bg) } : undefined;
    },
    [deco],
  );

  const open = (col: number, row: number) => setViewer({ col, row });

  return (
    <div className={styles.grid} data-testid="result-grid">
      <DataEditor
        columns={columns}
        rows={source.rowCount}
        getCellContent={getCellContent}
        theme={theme}
        rowHeight={ROW_HEIGHT}
        headerHeight={HEADER_HEIGHT}
        rowMarkers={{ kind: "number", width: ROW_MARKER_WIDTH }}
        width="100%"
        height="100%"
        smoothScrollX
        smoothScrollY
        gridSelection={selection}
        onGridSelectionChange={(sel) => {
          setSelection(sel);
          onSelectionChange?.(selectedCells(sel, source.rowCount, visible.length));
        }}
        getCellsForSelection
        copyHeaders={false}
        drawHeader={drawHeader}
        drawCell={drawCell}
        getRowThemeOverride={getRowThemeOverride}
        columnSelect="multi"
        rangeSelect="multi-rect"
        onColumnResize={(col, size) => {
          const sc = visible[columns.findIndex((c) => c.id === col.id)];
          if (sc === undefined) return;
          onWidthsChange?.({
            ...(widths ?? {}),
            [sc]: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, size)),
          });
        }}
        onColumnMoved={(from, to) => onOrderChange?.(moveColumn(visible, from, to))}
        onHeaderClicked={(col, e) => {
          const sc = visible[col];
          if (sc === undefined) return;
          if (e.isEdge && e.isDoubleClick) {
            e.preventDefault();
            const w = autoWidth(source, sc);
            setAutoWidths((cur) => ({ ...cur, [sc]: w }));
            onWidthsChange?.({ ...(widths ?? {}), [sc]: w });
          } else if (!e.isEdge) {
            onSort?.(sc);
          }
        }}
        onCellActivated={([col, row]) => {
          if (onActivate?.(visible[col], row) === true) return;
          if (readOnly) open(col, row);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey && e.location) {
            e.preventDefault();
            e.cancel();
            open(e.location[0], e.location[1]);
          }
        }}
        onVisibleRegionChanged={(range) => {
          if (range.y + range.height >= source.rowCount - NEAR_END_ROWS) onNearEnd?.();
        }}
      />
      {viewer ? (
        <CellViewer
          value={source.get(visible[viewer.col], viewer.row)}
          column={source.columns[visible[viewer.col]]}
          fetchFull={fetchFull?.(visible[viewer.col], viewer.row)}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </div>
  );
});

/** Shorten text with an ellipsis so it fits `max` px. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 0) return "";
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

export { CompactSelection };
