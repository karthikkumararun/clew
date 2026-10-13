/**
 * Paste into an editable result: reads the clipboard, plans against the selection, asks what the
 * spec says to ask, stages ONE undo group and shows the "Interpret as" notice.
 *
 * Wiring (useEditingUi): `const pasting = usePaste({ editor, grid, toStoreRow, source, notify })`,
 * return `paste: pasting.paste` from the edit target, and render `pasting.notice` and
 * `pasting.dialogs` next to the result grid.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { ResultEditor } from "../../results/ResultEditor";
import type { GridHandle } from "../ResultGrid";
import type { GridSource } from "../source";
import { stage } from "./adapter";
import type { Staged } from "./adapter";
import { readPaste, toInput } from "./clipboard";
import type { PasteSource } from "./clipboard";
import { readClipboard } from "./clipboardIo";
import { FORMAT_LABELS } from "./detect";
import type { InterpretFormat } from "./detect";
import { plan as makePlan, REFUSE_CELLS } from "./plan";
import type { PasteColumn, PastePlan } from "./plan";
import {
  AddRowsDialog,
  ConfirmLargeDialog,
  InvalidValuesDialog,
  PasteNotice,
} from "./PasteDialogs";

export interface UsePasteArgs {
  editor: ResultEditor | null;
  grid: RefObject<GridHandle | null>;
  toStoreRow: (displayRow: number) => number;
  /** The change set the grid shows (row count including staged inserts). */
  source: GridSource;
  notify: (message: string) => void;
}

export interface UsePaste {
  paste(asNewRows: boolean): void;
  dialogs: ReactNode;
  notice: ReactNode;
}

type Dialog =
  | { kind: "confirm"; cells: number }
  | { kind: "rows"; extra: number; fit: number }
  | { kind: "errors"; plan: PastePlan; valid: number };

type Answer = "primary" | "secondary" | "cancel";

interface Run {
  source: PasteSource;
  asNewRows: boolean;
  forceFormat?: InterpretFormat;
}

interface NoticeState {
  text: string;
  run: Run;
  staged: Staged;
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function usePaste(args: UsePasteArgs): UsePaste {
  const [dialog, setDialog] = useState<(Dialog & { resolve(a: Answer): void }) | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const latest = useRef(args);
  latest.current = args;
  const busy = useRef(false);

  // A different result: the old notice no longer applies.
  useEffect(() => setNotice(null), [args.editor]);

  const ask = useCallback(
    (d: Dialog) => new Promise<Answer>((resolve) => setDialog({ ...d, resolve })),
    [],
  );
  const answer = (a: Answer) => {
    const d = dialog;
    setDialog(null);
    d?.resolve(a);
  };

  const execute = useCallback(
    async (run: Run) => {
      const { editor, grid, toStoreRow, source, notify } = latest.current;
      const cs = editor?.changes;
      if (!editor || !cs || !editor.editable) {
        const res = editor?.resolution;
        notify(
          res?.kind === "readOnly"
            ? `This result is read-only: ${res.reason.message}`
            : "This result can't be edited, so nothing was pasted",
        );
        return;
      }
      if (run.asNewRows && !editor.canAddRows.ok) {
        notify(editor.canAddRows.reason ?? "Rows can't be added to this result");
        return;
      }
      const sel = grid.current?.selection();
      if ((!sel || sel.cols.length === 0 || sel.rows.length === 0) && !run.asNewRows) {
        notify("Select a cell to paste into first");
        return;
      }
      const srcCols = grid.current?.sourceColumns?.() ?? source.columns.map((_, i) => i);
      const res = editor.resolution;
      if (res?.kind !== "editable") return;
      const columns: PasteColumn[] = srcCols.map((sc) => ({
        name: source.columns[sc]?.name ?? "",
        kind: source.columns[sc]?.kind ?? "text",
        nullable: res.columns[sc]?.nullable ?? null,
        editable: editor.cellState(sc, source.rowCount).editable,
      }));
      const input = toInput(
        run.source,
        columns.map((c) => c.name),
        run.forceFormat,
      );
      if (input.error) {
        notify(input.error);
        return;
      }
      const selection = sel?.rows.length
        ? { row: sel.rows[0], col: sel.cols[0], rows: sel.rows.length, cols: sel.cols.length }
        : { row: 0, col: 0, rows: 1, cols: 1 };
      const raw = makePlan(input.table, selection, columns, true, {
        rowCount: source.rowCount,
        hasHeader: input.hasHeader,
        canAddRows: editor.canAddRows.ok,
        asNewRows: run.asNewRows,
        format: input.format,
      });

      if (raw.limit === "refuse") {
        notify(
          `A paste over ${REFUSE_CELLS.toLocaleString()} cells is too large. Import the data into the table instead.`,
        );
        return;
      }

      // Display coordinates -> source columns and store rows; rows the user can't change are skipped.
      const skipped = new Map(raw.skippedColumns.map((s) => [srcCols[s.col], s.name]));
      const assignments = [];
      for (const a of raw.assignments) {
        const row = toStoreRow(a.row);
        const col = srcCols[a.col];
        if (!(row >= 0) || col === undefined) continue;
        if (!editor.cellState(col, row).editable) {
          skipped.set(col, source.columns[col]?.name ?? "");
          continue;
        }
        assignments.push({ row, col, value: a.value });
      }
      const mapRows = (rows: PastePlan["extraRows"]) =>
        rows.map((r) => ({
          cells: r.cells.flatMap((c) =>
            srcCols[c.col] === undefined ? [] : [{ col: srcCols[c.col], value: c.value }],
          ),
        }));
      const staging: PastePlan = {
        ...raw,
        assignments,
        extraRows: mapRows(raw.extraRows),
        newRows: raw.newRows ? mapRows(raw.newRows) : undefined,
      };

      if (
        raw.limit === "confirm" &&
        (await ask({ kind: "confirm", cells: raw.cells })) !== "primary"
      )
        return;
      let includeExtraRows = false;
      if (staging.extraRows.length > 0) {
        const a = await ask({
          kind: "rows",
          extra: staging.extraRows.length,
          fit: raw.rowsFit,
        });
        if (a === "cancel") return;
        includeExtraRows = a === "primary";
      }
      if (raw.errors.length > 0) {
        const valid =
          assignments.length +
          (includeExtraRows ? staging.extraRows.reduce((s, r) => s + r.cells.length, 0) : 0) +
          (staging.newRows?.reduce((s, r) => s + r.cells.length, 0) ?? 0);
        if ((await ask({ kind: "errors", plan: raw, valid })) !== "primary") return;
      }

      const staged = stage(staging, cs, { includeExtraRows });
      if (staged.cells === 0 && staged.rowsAdded === 0) {
        notify(
          skipped.size > 0
            ? `Nothing pasted: ${count(skipped.size, "read-only column", "read-only columns")} skipped`
            : "Nothing to paste",
        );
        setNotice(null);
        return;
      }
      const label = input.format === "typed" ? "Clew" : FORMAT_LABELS[input.format];
      const parts = [
        `Pasted ${count(raw.rowsPasted, "row", "rows")} × ${count(raw.colsPasted, "column", "columns")} · ${label}`,
      ];
      if (skipped.size > 0)
        parts.push(`${count(skipped.size, "read-only column", "read-only columns")} skipped`);
      if (raw.errors.length > 0)
        parts.push(`${count(raw.errors.length, "value", "values")} skipped`);
      if (raw.droppedColumns > 0)
        parts.push(`${count(raw.droppedColumns, "column", "columns")} didn't fit`);
      if (raw.droppedRows > 0) parts.push(`${count(raw.droppedRows, "row", "rows")} not added`);
      setNotice({ text: parts.join(" · "), run, staged });
    },
    [ask],
  );

  const guarded = useCallback(async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } finally {
      busy.current = false;
    }
  }, []);

  const paste = useCallback(
    (asNewRows: boolean) =>
      void guarded(async () => {
        const { notify } = latest.current;
        let clip;
        try {
          clip = await readClipboard();
        } catch {
          notify("Couldn't read the clipboard");
          return;
        }
        if (clip.text === "" && !clip.typed) {
          notify("The clipboard is empty");
          return;
        }
        setNotice(null);
        await execute({ source: readPaste(clip.text, clip.typed), asNewRows });
      }),
    [execute, guarded],
  );

  const interpret = (format: InterpretFormat) =>
    void guarded(async () => {
      if (!notice) return;
      if (!notice.staged.undo()) {
        latest.current.notify("Other changes were made since the paste, so it can't be redone");
        return;
      }
      const run = { ...notice.run, forceFormat: format };
      setNotice(null);
      await execute(run);
    });

  const undo = () => {
    if (!notice) return;
    if (notice.staged.undo()) setNotice(null);
    else
      latest.current.notify("Other changes were made since the paste, so it can't be undone here");
  };

  const dialogs = dialog ? (
    dialog.kind === "confirm" ? (
      <ConfirmLargeDialog
        cells={dialog.cells}
        onPaste={() => answer("primary")}
        onCancel={() => answer("cancel")}
      />
    ) : dialog.kind === "rows" ? (
      <AddRowsDialog
        extra={dialog.extra}
        fit={dialog.fit}
        onFit={() => answer("secondary")}
        onAdd={() => answer("primary")}
        onCancel={() => answer("cancel")}
      />
    ) : (
      <InvalidValuesDialog
        errors={dialog.plan.errors}
        valid={dialog.valid}
        onPasteOthers={() => answer("primary")}
        onCancel={() => answer("cancel")}
      />
    )
  ) : null;

  return {
    paste,
    dialogs,
    notice: notice ? (
      <PasteNotice
        text={notice.text}
        onInterpret={interpret}
        onUndo={undo}
        onDismiss={() => setNotice(null)}
      />
    ) : null,
  };
}
