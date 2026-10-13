/**
 * The React side of editing a console result: finds (or creates) the result's `ResultEditor`,
 * and, once the grid view exists, supplies what the panel needs: decorations, the cell editor,
 * the row operations, the pending bar, the dialogs and the keyboard shortcuts' target
 * (spec: result-editing).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { Button, IconButton } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { Plus } from "../../components/icons";
import { useKeepInWindow } from "../../components/useKeepInWindow";
import { formatShortcut } from "../../lib/platform";
import type { ResultView } from "../../lib/ipc/queryRun";
import { useNotices } from "../../stores/noticesStore";
import { askChoice } from "../console/prompts";
import type { ConsoleRuntime } from "../console/runtime";
import { confirmSwitchToReadWrite } from "../safety/switch";
import { registerEditTarget } from "../grid/editTarget";
import type { GridDecorations, GridHandle } from "../grid/ResultGrid";
import { RowsSource } from "../grid/source";
import type { GridSource } from "../grid/source";
import { CellEditor } from "../table-editor/CellEditor";
import { PendingBar, breakdown } from "../table-editor/PendingBar";
import { PreviewDialog } from "../table-editor/PreviewDialog";
import type { PreviewStatement } from "../table-editor/api";
import { READ_ONLY_KINDS } from "../table-editor/editValue";
import { useWorkspace } from "../../stores/workspaceStore";
import { runCommand } from "../../shell/registry/commands";
import { ResultEditor } from "./ResultEditor";
import type { EditorState } from "./ResultEditor";
import { EditChip } from "./EditChip";
import styles from "./Results.module.css";

const editorsByRuntime = new WeakMap<ConsoleRuntime, Map<string, ResultEditor>>();

function editorsOf(runtime: ConsoleRuntime): Map<string, ResultEditor> {
  let m = editorsByRuntime.get(runtime);
  if (!m) editorsByRuntime.set(runtime, (m = new Map()));
  return m;
}

/** Staged changes across the console's results (the guard, auto-refresh and closing ask this). */
export function pendingInConsole(runtime: ConsoleRuntime): number {
  let n = 0;
  for (const e of editorsOf(runtime).values()) n += e.pendingCount;
  return n;
}

/** Submit, Discard or Cancel for a console with staged changes; true when it is fine to go on. */
export async function confirmConsolePending(runtime: ConsoleRuntime): Promise<boolean> {
  const editors = [...editorsOf(runtime).values()].filter((e) => e.pendingCount > 0);
  if (editors.length === 0) return true;
  const total = editors.reduce((n, e) => n + e.pendingCount, 0);
  const answer = await askChoice({
    title: "Pending changes",
    body: (
      <p>
        This result has {total} pending {total === 1 ? "change" : "changes"}. Submit them, discard
        them, or stay here?
      </p>
    ),
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "discard", label: "Discard" },
      { id: "submit", label: "Submit", variant: "primary" },
    ],
  });
  if (answer === "discard") {
    editors.forEach((e) => e.revertAll());
    return true;
  }
  if (answer === "submit") {
    for (const e of editors) if (!(await e.submit())) return false;
    return true;
  }
  return false;
}

/** The editor of the result on screen; resolves editability when the result is complete. */
export function useEditorFor(
  runtime: ConsoleRuntime,
  active: ResultView | undefined,
  base: RowsSource,
  driver: string,
): ResultEditor | null {
  const statement = useStore(runtime.store, (s) => (active ? s.resultSql[active.key] : undefined));
  const readOnly = useStore(runtime.store, (s) => s.readOnly);
  const [, force] = useState(0);
  const editorRef = useRef<ResultEditor | null>(null);

  const ready =
    !!active && active.done && !active.error && active.columns.length > 0 && !!statement;
  const key = active?.key;

  // One editor per result key; results of an older run are dropped.
  useEffect(() => {
    const map = editorsOf(runtime);
    if (!ready || !key || !statement || !active) {
      editorRef.current = null;
      force((n) => n + 1);
      return;
    }
    let editor = map.get(key);
    if (!editor || editor.statement !== statement) {
      editor = new ResultEditor(runtime, key, base, statement, driver);
      map.set(key, editor);
      void editor.resolve();
    }
    editorRef.current = editor;
    force((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, key, statement, ready]);

  // Switching the session between read-only and read-write changes what can be edited.
  useEffect(() => {
    if (editorRef.current && editorRef.current.resultKey === key) void editorRef.current.resolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  useEffect(() => {
    runtime.pendingChanges = () => pendingInConsole(runtime);
    runtime.beforeRun = () => confirmConsolePending(runtime);
    return () => {
      runtime.pendingChanges = () => 0;
      runtime.beforeRun = null;
    };
  }, [runtime]);

  return editorRef.current && editorRef.current.resultKey === key ? editorRef.current : null;
}

export interface EditingUi {
  /** Props for the pieces the panel places. */
  chip: ReactNode;
  rowOps: ReactNode;
  /** Below the grid: shared-row notice, pending bar, errors. */
  footer: ReactNode;
  /** Dialogs and the cell editor, rendered once. */
  dialogs: ReactNode;
  decorations: GridDecorations | undefined;
  onActivate: (col: number, row: number) => boolean;
  onCellContext: ((col: number, row: number, x: number, y: number) => void) | undefined;
  /** Source columns that are keys (header icon) of the edit table. */
  keyColumns: ReadonlySet<number> | undefined;
  /** Header tooltip: why a column is read-only. */
  headerDetail: ((column: number) => string | undefined) | undefined;
  editable: boolean;
}

const NO_UI: EditingUi = {
  chip: null,
  rowOps: null,
  footer: null,
  dialogs: null,
  decorations: undefined,
  onActivate: () => false,
  onCellContext: undefined,
  keyColumns: undefined,
  headerDetail: undefined,
  editable: false,
};

export interface EditingUiArgs {
  runtime: ConsoleRuntime;
  editor: ResultEditor | null;
  /** Display row -> store row (sort and filters). */
  toStoreRow: (displayRow: number) => number;
  /** Store row -> display row, -1 when hidden. */
  toDisplayRow: (storeRow: number) => number;
  grid: React.RefObject<GridHandle | null>;
  driver: string;
  connectionName: string;
  /** The grid's source for reading values (the change set when editing). */
  source: GridSource;
}

export function useEditingUi(a: EditingUiArgs): EditingUi {
  const { runtime, editor } = a;
  const empty = useStore(editor?.store ?? FALLBACK_STORE, (s) => s) as EditorState;
  const [rev, setRev] = useState(0);
  const [editing, setEditing] = useState<{ col: number; row: number } | null>(null);
  const [preview, setPreview] = useState<{
    statements: PreviewStatement[] | null;
    error: string | null;
  } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; col: number; row: number } | null>(null);
  const [conflict, setConflict] = useState<{ row: number; message: string; now: string } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  useKeepInWindow(menuRef, menu !== null, menu);
  const txOpen = useStore(runtime.store, (s) => s.txOpen);

  // Repaint when staged changes change.
  useEffect(() => {
    const cs = editor?.changes;
    if (!cs) return;
    return cs.subscribe(() => setRev((n) => n + 1));
  }, [editor, editor?.changes]);

  const changes = editor?.changes ?? null;
  const counts = useMemo(
    () => changes?.counts() ?? { edited: 0, inserted: 0, deleted: 0, total: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changes, rev],
  );
  const storeSelection = useCallback(() => {
    const sel = a.grid.current?.selection();
    return {
      cols: sel?.cols ?? [],
      rows: [...new Set((sel?.rows ?? []).map(a.toStoreRow))],
    };
  }, [a.grid, a.toStoreRow]);

  const submit = useCallback(
    async (commit = false) => {
      if (!editor) return;
      const ok = await editor.submit({ commit });
      if (!ok) {
        const err = editor.store.getState().submitError;
        if (err?.conflict && err.row !== null) {
          const current = await editor.currentValues(err.row).catch(() => null);
          setConflict({
            row: err.row,
            message: err.message,
            now: current?.values
              ? current.columns.map((c, i) => `${c} = ${shortValue(current.values![i])}`).join(", ")
              : "the row no longer exists",
          });
        }
      }
    },
    [editor],
  );

  // The keyboard shortcuts act on this result while the console is the active tab.
  useEffect(() => {
    if (!editor?.editable) return;
    return registerEditTarget(() => {
      const { activeTabId } = useWorkspace.getState();
      if (activeTabId !== runtime.tabId || !editor.editable) return undefined;
      return {
        submitsWithEnter: true,
        addRow: () => void addRowAndEdit(),
        cloneRows: () => void editor.cloneRows(storeSelection().rows),
        deleteRows: () => void deleteSelected(),
        undo: () => void editor.changes?.undo(),
        redo: () => void editor.changes?.redo(),
        revertSelection: () => {
          const s = storeSelection();
          editor.revertCells(s.rows.flatMap((row) => s.cols.map((col) => ({ col, row }))));
        },
        setNull: () => forSelectedCells((c, r) => editor.setNull(c, r)),
        setDefault: () => forSelectedCells((c, r) => editor.setDefault(c, r)),
        submit: () => void submit(false),
        submitAndCommit: () => void submit(true),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editor?.changes, runtime, submit]);

  function forSelectedCells(f: (col: number, row: number) => void) {
    const s = storeSelection();
    for (const row of s.rows) for (const col of s.cols) f(col, row);
  }

  const addRowAndEdit = () => {
    const row = editor?.addRow();
    if (row === null || row === undefined) {
      const why = editor?.canAddRows.reason;
      if (why) useNotices.getState().push(why);
    }
  };

  const deleteSelected = async () => {
    if (!editor) return;
    const rows = storeSelection().rows;
    if (rows.length === 0) return;
    const info = editor.deleteInfo(rows);
    if (info.resultRows > info.tableRows) {
      const answer = await askChoice({
        title: "Delete rows",
        body: (
          <p>
            This deletes {info.tableRows} {info.tableRows === 1 ? "row" : "rows"} of{" "}
            <strong>
              {editor.resolution?.kind === "editable" ? editor.resolution.target.table : ""}
            </strong>
            , shown on {info.resultRows} result rows.
          </p>
        ),
        choices: [
          { id: "cancel", label: "Cancel" },
          { id: "delete", label: "Delete", variant: "primary" },
        ],
      });
      if (answer !== "delete") return;
    }
    editor.deleteRows(rows);
  };

  if (!editor) return NO_UI;
  const res = editor.resolution;
  const editable = res?.kind === "editable";

  const decorations: GridDecorations | undefined = editable
    ? {
        row: (displayRow) => {
          const r = a.toStoreRow(displayRow);
          const st = changes?.rowState(r);
          if (st === "inserted") return { bg: "grid-inserted-row", marker: "+" };
          if (st === "deleted") return { bg: "grid-deleted-row", marker: "−", strike: true };
          if (st === "edited") return { bg: "grid-edited-row" };
          return undefined;
        },
        cell: (c, displayRow) => {
          const r = a.toStoreRow(displayRow);
          if (empty.submitError?.row === r) return "error";
          if (changes?.isEdited(c, r)) return "edited";
          return editor.isStale(c, r) ? "stale" : undefined;
        },
      }
    : undefined;

  const onActivate = (col: number, displayRow: number): boolean => {
    if (!editable) return false;
    const row = a.toStoreRow(displayRow);
    const meta = a.source.columns[col];
    if (meta && READ_ONLY_KINDS.has(meta.kind)) return false; // binary: the value viewer
    const st = editor.cellState(col, row);
    if (!st.editable) {
      if (st.reason) useNotices.getState().push(st.reason);
      return false;
    }
    setEditing({ col, row });
    return true;
  };

  const onCellContext = editable
    ? (col: number, displayRow: number, x: number, y: number) =>
        setMenu({ x, y, col, row: a.toStoreRow(displayRow) })
    : undefined;

  const cellMenuItems = (col: number, row: number): MenuItem[] => {
    const st = editor.cellState(col, row);
    const meta = a.source.columns[col];
    const items: MenuItem[] = [];
    if (st.editable) {
      items.push({ id: "edit", label: "Edit cell" });
      if (editor.canSetNull(col)) {
        items.push({ id: "null", label: "Set NULL", hint: formatShortcut("Mod+Alt+N") });
      }
      items.push({ id: "default", label: "Set DEFAULT", hint: formatShortcut("Mod+Alt+D") });
      if (meta && (meta.kind === "uuid" || meta.kind === "text")) {
        items.push({ id: "uuid", label: "Generate UUID" });
      }
    }
    if (changes?.isEdited(col, row)) items.push({ id: "revert", label: "Revert cell" });
    const rowOk = changes?.rowState(row) !== "deleted";
    items.push({ id: "delete", label: "Delete row", disabled: !rowOk });
    if (editor.canAddRows.ok) items.push({ id: "clone", label: "Clone row" });
    return items;
  };

  const pickCellMenu = (id: string) => {
    const m = menu;
    setMenu(null);
    if (!m) return;
    if (id === "edit") setEditing({ col: m.col, row: m.row });
    else if (id === "null") editor.setNull(m.col, m.row);
    else if (id === "default") editor.setDefault(m.col, m.row);
    else if (id === "uuid") {
      editor.stage(m.col, m.row, {
        kind: "value",
        value: { kind: "text", value: crypto.randomUUID(), truncated: false },
      });
    } else if (id === "revert") editor.revertCells([{ col: m.col, row: m.row }]);
    else if (id === "delete") editor.deleteRows([m.row]);
    else if (id === "clone") editor.cloneRows([m.row]);
  };

  const reason = !editable ? null : editor.canAddRows.reason;
  const rowOps = editable ? (
    <>
      <IconButton
        aria-label="Add row"
        title={reason ?? `Add row (${formatShortcut("Mod+N")})`}
        disabled={!editor.canAddRows.ok}
        onClick={addRowAndEdit}
      >
        <Plus size={14} />
      </IconButton>
      <IconButton
        aria-label="Clone row"
        title={reason ?? `Clone row (${formatShortcut("Mod+Shift+D")})`}
        disabled={!editor.canAddRows.ok}
        onClick={() => editor.cloneRows(storeSelection().rows)}
      >
        <span aria-hidden="true">⧉</span>
      </IconButton>
      <IconButton
        aria-label="Delete row"
        title={`Delete row (${formatShortcut("Mod+Backspace")})`}
        onClick={() => void deleteSelected()}
      >
        <span aria-hidden="true">−</span>
      </IconButton>
      <IconButton
        aria-label="Undo"
        title={`Undo (${formatShortcut("Mod+Z")})`}
        disabled={!changes?.canUndo}
        onClick={() => changes?.undo()}
      >
        <span aria-hidden="true">↶</span>
      </IconButton>
      <IconButton
        aria-label="Redo"
        title={`Redo (${formatShortcut("Mod+Shift+Z")})`}
        disabled={!changes?.canRedo}
        onClick={() => changes?.redo()}
      >
        <span aria-hidden="true">↷</span>
      </IconButton>
    </>
  ) : null;

  const chip = (
    <EditChip
      resolution={empty.resolution}
      resolving={empty.status === "resolving"}
      error={empty.error}
      locked={counts.total > 0}
      onChoose={(t) => void editor.choose(t)}
      onSwitchToReadWrite={() =>
        void confirmSwitchToReadWrite(a.connectionName).then((yes) => {
          if (yes) void runtime.setReadOnly(false);
        })
      }
    />
  );

  const selectedRow = storeSelection().rows[0];
  const shared = selectedRow !== undefined && editable ? editor.sharedNotice(selectedRow) : null;
  const manual = runtime.txMode === "manual";

  const footer = editable ? (
    <>
      {shared ? (
        <div className={styles.sharedNotice} role="status">
          {shared}
        </div>
      ) : null}
      <PendingBar
        counts={counts}
        submitting={empty.submitting}
        error={empty.submitError}
        submitShortcut={formatShortcut("Mod+Enter")}
        onPreview={() => {
          setPreview({ statements: null, error: null });
          editor.preview().then(
            (statements) => setPreview({ statements, error: null }),
            (e) => setPreview({ statements: null, error: String(e?.message ?? e) }),
          );
        }}
        onRevert={() => editor.revertAll()}
        onSubmit={() => void submit(false)}
        onReload={() => void confirmReloadAll()}
        manual={
          manual
            ? {
                sent: empty.sent && txOpen ? empty.sent : null,
                commitShortcut: formatShortcut("Mod+Alt+Shift+Enter"),
                onSubmitCommit: () => void submit(true),
                onCommit: () =>
                  void runtime
                    .endTransaction(true)
                    .then(() => editor.store.setState({ sent: null })),
                onRollback: () =>
                  void runtime
                    .endTransaction(false)
                    .then(() => editor.store.setState({ sent: null })),
              }
            : undefined
        }
      />
    </>
  ) : null;

  async function confirmReloadAll() {
    const answer = await askChoice({
      title: "Reload the result?",
      body: (
        <p>
          Reloading reads the rows again and drops all {counts.total} pending changes.{" "}
          {breakdown(counts)}
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "reload", label: "Discard and re-run", variant: "primary" },
      ],
    });
    if (answer === "reload") {
      editor?.revertAll();
      await runtime.rerun();
    }
  }

  const dialogs = (
    <>
      {editing && changes ? (
        <CellEditor
          column={a.source.columns[editing.col]}
          current={changes.get(editing.col, editing.row)}
          nullable={editor.canSetNull(editing.col)}
          allowDefault={a.driver !== "sqlite" || editing.row >= changes.loadedRows}
          onClose={() => setEditing(null)}
          onSubmit={(value) => {
            editor.stage(editing.col, editing.row, value);
            setEditing(null);
          }}
        />
      ) : null}
      {preview ? (
        <PreviewDialog
          statements={preview.statements}
          error={preview.error}
          onClose={() => setPreview(null)}
          onCopy={(text) => void navigator.clipboard.writeText(text)}
          onOpenInConsole={(text) => {
            setPreview(null);
            void runCommand("console.new", { connectionId: runtime.connectionId, sql: text });
          }}
        />
      ) : null}
      {menu ? (
        <>
          <div className={styles.menuScrim} onMouseDown={() => setMenu(null)} aria-hidden="true" />
          <div ref={menuRef} className={styles.cellMenuHost} style={{ left: menu.x, top: menu.y }}>
            <Menu
              aria-label="Cell actions"
              items={cellMenuItems(menu.col, menu.row)}
              onClose={() => setMenu(null)}
              onSelect={pickCellMenu}
            />
          </div>
        </>
      ) : null}
      {conflict ? (
        <Dialog
          title="Row changed by someone else"
          maxWidth={560}
          onClose={() => setConflict(null)}
          footer={
            <>
              <Button variant="default" onClick={() => setConflict(null)}>
                Keep editing
              </Button>
              <Button
                variant="default"
                onClick={() => {
                  const row = conflict.row;
                  setConflict(null);
                  void editor.reloadRow(row);
                }}
              >
                Reload row
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const row = conflict.row;
                  setConflict(null);
                  void editor.overwrite(row);
                }}
              >
                Overwrite
              </Button>
            </>
          }
        >
          <p>
            1 of {counts.total} {counts.total === 1 ? "change" : "changes"} didn&apos;t apply. The
            row was changed after it was loaded.
          </p>
          <p className={styles.mono}>Now in the database: {conflict.now}</p>
        </Dialog>
      ) : null}
    </>
  );

  const keyColumns = res?.kind === "editable" ? new Set(res.keyIndexes) : undefined;
  const headerDetail = editable
    ? (column: number) => {
        const meta = a.source.columns[column];
        if (!meta) return undefined;
        const edit = res.columns[column];
        if (!edit.editable)
          return `${meta.type_name} · read-only${edit.reason ? ` (${edit.reason})` : ""}`;
        return undefined;
      }
    : undefined;

  return {
    chip,
    rowOps,
    footer,
    dialogs,
    decorations,
    onActivate,
    onCellContext,
    keyColumns,
    headerDetail,
    editable,
  };
}

function shortValue(v: import("../../lib/ipc/drivers").Value | undefined): string {
  if (!v) return "NULL";
  if (v.kind === "null") return "NULL";
  const inner = (v as { value?: unknown }).value;
  return inner === undefined ? v.kind : String(inner);
}

import { createStore } from "zustand/vanilla";
const FALLBACK_STORE = createStore<EditorState>(() => ({
  status: "resolving",
  resolution: null,
  chosen: null,
  submitting: false,
  submitError: null,
  sent: null,
  stale: false,
  error: null,
}));
