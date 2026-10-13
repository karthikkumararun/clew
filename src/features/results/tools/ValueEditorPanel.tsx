/**
 * Contract: the value editor panel at the right of the grid (spec: data-grid › Value editor
 * panel). Shows the selected cell's full value in a CodeMirror editor with:
 *  - Display as (`displayModesFor(kind)`: bytes as hex, text, base64, UUID; numbers grouped or
 *    scientific; timestamps in several formats). It only changes how the stored value is READ.
 *    It is disabled while there are unstaged edits so an edit is never silently re-read.
 *  - Highlight as (Plain, JSON, XML, SQL) for text and JSON cells.
 *  - Load file… / Save to file… for text, JSON and binary cells. File access is injected, so
 *    the panel needs no dialog plugin: `loadFile` returns the picked file's bytes (null when
 *    cancelled) and `saveFile` writes bytes to a path the user picks (the caller shows the Save
 *    dialog; `suggestion` carries the file name and filters). Save writes the stored value's own
 *    bytes (raw bytes for a binary cell, whatever Display as is), fetching the full value first
 *    when the grid only holds a truncated copy (`fetchFull`).
 *  - Edits are staged through `onStage` after `editThroughDisplay`, which refuses ambiguous round
 *    trips with the reason shown under the editor. Nothing is written until the result is
 *    submitted (the same staged change as a cell edit). Read-only when `editable` is false.
 * Mount with `cell === null` to show the empty state. Give each cell a distinct `cell.key` so
 * the panel resets its own state when the selection moves.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, IconButton } from "../../../components/Button";
import { Select } from "../../../components/Input";
import { Close } from "../../../components/icons";
import type { ColumnMeta, Value } from "../../../lib/ipc/drivers";
import type { NewValue } from "../../table-editor/api";
import {
  DISPLAY_LABELS,
  HIGHLIGHT_LANGUAGES,
  decode,
  defaultDisplay,
  defaultHighlight,
  displayModesFor,
  editThroughDisplay,
  formatSize,
  needsFullFetch,
  suggestFileName,
  valueFromFileBytes,
  valueToFileBytes,
} from "../../grid/tools/valueCodec";
import type { DisplayAs, FileSuggestion, HighlightAs } from "../../grid/tools/valueCodec";
import { ValueCodeEditor } from "./ValueCodeEditor";
import styles from "./ResultTools.module.css";

export interface ValueEditorCell {
  /** Changes when the selection moves to another cell (for example `${row}:${column}`). */
  key: string;
  column: ColumnMeta;
  /** 1-based row number shown in the header. */
  row: number;
  value: Value;
}

export interface ValueEditorPanelProps {
  cell: ValueEditorCell | null;
  editable: boolean;
  /** Why editing is off, shown as a tooltip on the disabled actions. */
  readOnlyReason?: string;
  /** Fetch the untruncated value of the cell (`value_fetch_full`). */
  fetchFull?: () => Promise<Value>;
  /** Stage the edit, as the cell editor would. */
  onStage: (value: NewValue) => void;
  /** Let the user pick a file; its bytes, or null if they cancel. */
  loadFile: () => Promise<Uint8Array | null>;
  /** Let the user pick a path and write the bytes there. */
  saveFile: (name: string, bytes: Uint8Array, suggestion: FileSuggestion) => Promise<void>;
  onClose?: () => void;
  fontSize?: number;
}

const EDITABLE_KINDS = new Set([
  "text",
  "json",
  "bytes",
  "int",
  "bigint",
  "decimal",
  "float",
  "date",
  "timestamp",
  "timestamptz",
]);
const FILE_KINDS = new Set(["text", "json", "bytes"]);
const HIGHLIGHT_KINDS = new Set(["text", "json"]);

export function ValueEditorPanel(props: ValueEditorPanelProps) {
  const { cell, onClose } = props;
  return (
    <aside className={styles.panel} aria-label="Value editor">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Value editor</h2>
        {cell ? (
          <span className={styles.panelSub}>
            {cell.column.name} · row {cell.row}
          </span>
        ) : null}
        <span className={styles.grow} />
        {onClose ? (
          <IconButton aria-label="Close value editor" onClick={onClose}>
            <Close />
          </IconButton>
        ) : null}
      </div>
      {cell ? (
        <CellEditor key={cell.key} {...props} cell={cell} />
      ) : (
        <p className={styles.panelEmpty}>Select a cell to see its value.</p>
      )}
    </aside>
  );
}

function CellEditor({
  cell,
  editable,
  readOnlyReason,
  fetchFull,
  onStage,
  loadFile,
  saveFile,
  fontSize,
}: ValueEditorPanelProps & { cell: ValueEditorCell }) {
  const { column } = cell;
  const kind = column.kind;
  const [full, setFull] = useState<Value | null>(null);
  const value = full ?? cell.value;
  const modes = displayModesFor(kind);
  const [display, setDisplay] = useState<DisplayAs>(defaultDisplay(kind));
  const decoded = useMemo(() => decode(value, display), [value, display]);
  const shownText = decoded.ok ? decoded.text : "";
  const truncated = decoded.ok && decoded.truncated === true;
  const [highlight, setHighlight] = useState<HighlightAs>(() =>
    defaultHighlight(kind, shownTextOf(cell.value, kind)),
  );
  const [draft, setDraft] = useState(shownText);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A new value or display mode re-reads the text.
  useEffect(() => {
    setDraft(shownText);
    setError(null);
  }, [shownText]);

  const dirty = draft !== shownText;
  const kindEditable = EDITABLE_KINDS.has(kind);
  const canEdit = editable && kindEditable && decoded.ok && !truncated;
  const offReason = !editable
    ? (readOnlyReason ?? "This result is read-only")
    : !kindEditable
      ? "This type is edited in the cell"
      : null;
  const isNull = value.kind === "null";

  const stage = () => {
    setNote(null);
    if (isNull && draft === "") {
      setNote("No change");
      return;
    }
    const r = editThroughDisplay(value, draft, display, kind);
    if (!r.ok) {
      setError(r.reason);
      return;
    }
    setError(null);
    if (!r.changed) {
      setNote("No change");
      return;
    }
    onStage({ kind: "value", value: r.value });
    setNote("Staged. Nothing is written until you submit.");
  };

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fetchWhole = () =>
    guard(async () => {
      if (!fetchFull) throw new Error("The full value is not available");
      setFull(await fetchFull());
    });

  const load = () =>
    guard(async () => {
      const bytes = await loadFile();
      if (!bytes) return;
      const r = valueFromFileBytes(bytes, kind);
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      onStage({ kind: "value", value: r.value });
      setNote(
        `Staged ${formatSize(bytes.length)} from the file. Nothing is written until you submit.`,
      );
    });

  const save = () =>
    guard(async () => {
      let v = value;
      if (needsFullFetch(v)) {
        if (!fetchFull) throw new Error("The value is truncated and cannot be fetched in full");
        v = await fetchFull();
        setFull(v);
      }
      const bytes = valueToFileBytes(v);
      if (!bytes) {
        setError("The value is NULL; there is nothing to save");
        return;
      }
      // Binary cells are written as their raw bytes, whatever Display as shows.
      const suggestion = suggestFileName({
        column: column.name,
        kind,
        display: kind === "bytes" ? "default" : display,
        highlight,
      });
      await saveFile(suggestion.name, bytes, suggestion);
      setNote(`Saved ${formatSize(bytes.length)} to the chosen file.`);
    });

  const count =
    value.kind === "bytes"
      ? formatSize(value.len)
      : value.kind === "null"
        ? "NULL"
        : `${shownText.length} characters`;

  return (
    <>
      <div className={styles.panelOptions}>
        <label className={styles.panelOption}>
          Display as
          <Select
            value={display}
            disabled={dirty}
            title={dirty ? "Stage or revert your changes first" : undefined}
            onChange={(e) => setDisplay(e.target.value as DisplayAs)}
          >
            {modes.map((m) => (
              <option key={m} value={m}>
                {DISPLAY_LABELS[m]}
              </option>
            ))}
          </Select>
        </label>
        {HIGHLIGHT_KINDS.has(kind) ? (
          <label className={styles.panelOption}>
            Highlight as
            <Select value={highlight} onChange={(e) => setHighlight(e.target.value as HighlightAs)}>
              {HIGHLIGHT_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
      {isNull ? <p className={styles.panelNote}>The value is NULL.</p> : null}
      {truncated ? (
        <p className={styles.panelNote} role="status">
          The grid holds a cut-off copy of this value.{" "}
          {fetchFull ? (
            <Button
              className={styles.footBtn}
              data-metric="button-compact"
              disabled={busy}
              onClick={() => void fetchWhole()}
            >
              Fetch full value
            </Button>
          ) : null}
        </p>
      ) : null}
      {decoded.ok ? (
        <div className={styles.editorHost}>
          <ValueCodeEditor
            value={shownText}
            language={highlight}
            readOnly={!canEdit}
            fontSize={fontSize}
            aria-label="Value"
            onChange={setDraft}
          />
        </div>
      ) : (
        <p className={styles.panelNote} role="status">
          {decoded.reason}
        </p>
      )}
      {error ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className={styles.hintLine} role="status" style={{ margin: "0 12px 8px" }}>
          {note}
        </p>
      ) : null}
      <div className={styles.panelFoot}>
        <span className={styles.count}>{count}</span>
        <span className={styles.grow} />
        {dirty ? (
          <Button
            className={styles.footBtn}
            data-metric="button-compact"
            onClick={() => setDraft(shownText)}
          >
            Revert
          </Button>
        ) : null}
        <Button
          variant="primary"
          className={styles.footBtn}
          data-metric="button-compact"
          disabled={!canEdit || !dirty}
          title={offReason ?? undefined}
          onClick={stage}
        >
          Stage change
        </Button>
        {kindEditable && column.nullable !== false && !isNull ? (
          <Button
            className={styles.footBtn}
            data-metric="button-compact"
            disabled={!editable}
            title={offReason ?? undefined}
            onClick={() => onStage({ kind: "value", value: { kind: "null" } })}
          >
            Set to NULL
          </Button>
        ) : null}
        {FILE_KINDS.has(kind) ? (
          <>
            <Button
              className={styles.footBtn}
              data-metric="button-compact"
              disabled={!editable || busy}
              title={offReason ?? undefined}
              onClick={() => void load()}
            >
              Load file…
            </Button>
            <Button
              className={styles.footBtn}
              data-metric="button-compact"
              disabled={busy}
              onClick={() => void save()}
            >
              Save to file…
            </Button>
          </>
        ) : null}
      </div>
    </>
  );
}

function shownTextOf(value: Value, kind: ColumnMeta["kind"]): string {
  const d = decode(value, defaultDisplay(kind));
  return d.ok ? d.text : "";
}
