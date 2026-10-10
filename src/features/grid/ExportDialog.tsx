import { useId, useMemo, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Checkbox, Input, Select } from "../../components/Input";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { exportCancel, exportQuery, exportRows } from "./exportIpc";
import type {
  ExportDateFormat,
  FileExportOptions,
  FileExportSummary,
  FileFormat,
} from "./exportIpc";
import { flavorOf } from "./sqlLiteral";
import styles from "./ExportDialog.module.css";

export const FORMATS: { id: FileFormat; label: string }[] = [
  { id: "csv", label: "CSV" },
  { id: "tsv", label: "TSV" },
  { id: "json", label: "JSON (array)" },
  { id: "jsonl", label: "JSON lines" },
  { id: "markdown", label: "Markdown table" },
  { id: "insert", label: "SQL INSERT" },
];

const DELIMITERS = [
  { id: ",", label: "Comma ( , )" },
  { id: ";", label: "Semicolon ( ; )" },
  { id: "|", label: "Pipe ( | )" },
  { id: "\t", label: "Tab" },
];

const DATE_FORMATS: { id: ExportDateFormat; label: string }[] = [
  { id: "iso", label: "ISO 8601, as stored" },
  { id: "plain", label: "2026-10-08 21:14:07" },
  { id: "epoch", label: "Seconds since 1970 (UTC)" },
];

export interface ExportSource {
  /** The rows currently held, as the grid shows them (filtered, sorted, visible columns only). */
  loaded: () => { columns: ColumnMeta[]; rows: Value[][] };
  /** How many of them there are, for the scope label. */
  loadedCount: number;
  /** Whether the server has more rows than are loaded. */
  hasMore: boolean;
  /** The statement that produces every row; without it only loaded rows can be exported. */
  sql?: string;
  connectionId: string;
  driver: string;
  /** Quoted table name used by SQL INSERT output. */
  tableName?: string;
  /** File name without extension. */
  name: string;
}

const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

let counter = 0;

/** Choose format, scope and options, then write the file, with progress and Cancel. */
export function ExportDialog({ source, onClose }: { source: ExportSource; onClose: () => void }) {
  const idBase = useId();
  const [format, setFormat] = useState<FileFormat>("csv");
  const [scope, setScope] = useState<"loaded" | "all">(
    source.sql && source.hasMore ? "all" : "loaded",
  );
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(",");
  const [nullText, setNullText] = useState("");
  const [dateFormat, setDateFormat] = useState<ExportDateFormat>("iso");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ rows: number; bytes: number } | null>(null);
  const [done, setDone] = useState<FileExportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exportId = useRef(`export-${Date.now().toString(36)}-${counter++}`);

  const delimited = format === "csv" || format === "tsv";
  const options = useMemo<FileExportOptions>(
    () => ({
      header,
      delimiter: format === "csv" ? delimiter : null,
      nullText,
      dateFormat,
      table: source.tableName ?? null,
      flavor: flavorOf(source.driver),
    }),
    [header, delimiter, format, nullText, dateFormat, source.tableName, source.driver],
  );

  const run = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const summary =
        scope === "all" && source.sql
          ? await exportQuery(
              {
                exportId: exportId.current,
                connectionId: source.connectionId,
                sql: source.sql,
                format,
                options,
                defaultName: source.name,
              },
              (e) => {
                if (e.event === "progress") setProgress({ rows: e.rows, bytes: e.bytes });
              },
            )
          : await exportRows({ ...source.loaded(), format, options, defaultName: source.name });
      if (summary === null)
        setBusy(false); // the save dialog was cancelled
      else if (summary.cancelled) onClose();
      else setDone(summary);
    } catch (e) {
      setError((e as { message?: string }).message ?? "The export failed");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Dialog
        title="Export"
        maxWidth={460}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className={styles.body}>
          <p role="status">
            Exported {done.rows.toLocaleString()} {done.rows === 1 ? "row" : "rows"} ·{" "}
            {formatBytes(done.bytes)}
          </p>
          <p className={styles.path}>{done.path}</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Export"
      maxWidth={520}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        busy ? (
          <Button
            variant="default"
            onClick={() => {
              void exportCancel(exportId.current);
            }}
          >
            Cancel export
          </Button>
        ) : (
          <>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void run()}>
              Export…
            </Button>
          </>
        )
      }
    >
      <div className={styles.body}>
        <div className={styles.field}>
          <label htmlFor={`${idBase}-format`}>Format</label>
          <Select
            id={`${idBase}-format`}
            value={format}
            disabled={busy}
            onChange={(e) => setFormat(e.target.value as FileFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>

        <fieldset className={styles.scope} disabled={busy}>
          <legend>Rows</legend>
          <label>
            <input
              type="radio"
              name={`${idBase}-scope`}
              checked={scope === "loaded"}
              onChange={() => setScope("loaded")}
            />
            Loaded rows only ({source.loadedCount.toLocaleString()}
            {source.hasMore ? "+" : ""})
          </label>
          <label>
            <input
              type="radio"
              name={`${idBase}-scope`}
              checked={scope === "all"}
              disabled={!source.sql}
              onChange={() => setScope("all")}
            />
            All rows (run the query again and stream to the file)
          </label>
        </fieldset>

        {delimited ? (
          <Checkbox
            label="Header row"
            checked={header}
            disabled={busy}
            onChange={(e) => setHeader(e.target.checked)}
          />
        ) : null}
        {format === "csv" ? (
          <div className={styles.field}>
            <label htmlFor={`${idBase}-delim`}>Delimiter</label>
            <Select
              id={`${idBase}-delim`}
              value={delimiter}
              disabled={busy}
              onChange={(e) => setDelimiter(e.target.value)}
            >
              {DELIMITERS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {delimited || format === "markdown" ? (
          <div className={styles.field}>
            <label htmlFor={`${idBase}-null`}>NULL as</label>
            <Input
              id={`${idBase}-null`}
              dialog
              mono
              value={nullText}
              disabled={busy}
              placeholder="(empty)"
              onChange={(e) => setNullText(e.target.value)}
            />
          </div>
        ) : null}
        <div className={styles.field}>
          <label htmlFor={`${idBase}-date`}>Dates and times</label>
          <Select
            id={`${idBase}-date`}
            value={dateFormat}
            disabled={busy || format === "insert"}
            onChange={(e) => setDateFormat(e.target.value as ExportDateFormat)}
          >
            {DATE_FORMATS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </Select>
        </div>

        {busy ? (
          <p role="status" className={styles.progress}>
            {progress
              ? `${progress.rows.toLocaleString()} rows · ${formatBytes(progress.bytes)}`
              : "Waiting for the first rows…"}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
