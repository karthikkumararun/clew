/**
 * Contract: the extractor options dialog (spec: data-grid › Extractor options): format, header
 * row, delimiter and quoting for CSV, NULL text, date format, "Skip computed columns" and "Skip
 * generated columns". Edits a draft; Apply calls `onApply` with the options of the chosen format
 * (the caller stores them with `rememberOptions`). Switching format inside the dialog loads that
 * format's remembered options from `store` when given.
 */
import { useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Checkbox, Input, Select } from "../../../components/Input";
import { DISPLAY_LABELS } from "../../grid/tools/valueCodec";
import { EXTRACTOR_FORMATS, defaultExtractorOptions } from "../../grid/tools/viewAs";
import type {
  DateFormat,
  ExtractorFormat,
  ExtractorOptions,
  ExtractorStore,
} from "../../grid/tools/viewAs";
import styles from "./ResultTools.module.css";

export const FORMAT_LABELS: Record<ExtractorFormat, string> = {
  csv: "CSV",
  tsv: "TSV",
  markdown: "Markdown table",
  json: "JSON",
  jsonl: "JSON lines",
  insert: "SQL INSERT",
};

const DATE_FORMATS: DateFormat[] = ["default", "iso8601", "us", "eu", "epoch-s", "epoch-ms"];
const DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: "Comma" },
  { value: ";", label: "Semicolon" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe" },
];

export interface ExtractorOptionsDialogProps {
  options: ExtractorOptions;
  /** Remembered options per format, so changing the format shows that format's own settings. */
  store?: ExtractorStore;
  /** Hide the format row (a caller that fixes the format, such as Copy as INSERT). */
  hideFormat?: boolean;
  onApply: (options: ExtractorOptions) => void;
  onClose: () => void;
}

export function ExtractorOptionsDialog({
  options,
  store,
  hideFormat,
  onApply,
  onClose,
}: ExtractorOptionsDialogProps) {
  const [draft, setDraft] = useState(options);
  const set = <K extends keyof ExtractorOptions>(k: K, v: ExtractorOptions[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const f = draft.format;
  const hasHeader = f === "csv" || f === "tsv";
  const hasNullText = f === "csv" || f === "tsv" || f === "markdown";

  return (
    <Dialog
      title="Extractor options"
      onClose={onClose}
      maxWidth={440}
      footer={
        <div className={styles.footer}>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onApply(draft)}>
            Apply
          </Button>
        </div>
      }
    >
      <div className={styles.form}>
        {hideFormat ? null : (
          <div className={styles.field}>
            <label htmlFor="ex-format">Format</label>
            <Select
              id="ex-format"
              value={f}
              onChange={(e) => {
                const next = e.target.value as ExtractorFormat;
                setDraft(store?.[next] ?? { ...defaultExtractorOptions(next), table: draft.table });
              }}
            >
              {EXTRACTOR_FORMATS.map((x) => (
                <option key={x} value={x}>
                  {FORMAT_LABELS[x]}
                </option>
              ))}
            </Select>
          </div>
        )}
        {hasHeader ? (
          <Checkbox
            label="Header row"
            checked={draft.header}
            onChange={(e) => set("header", e.target.checked)}
          />
        ) : null}
        {f === "csv" ? (
          <>
            <div className={styles.field}>
              <label htmlFor="ex-delim">Delimiter</label>
              <Select
                id="ex-delim"
                value={DELIMITERS.some((d) => d.value === draft.delimiter) ? draft.delimiter : ","}
                onChange={(e) => set("delimiter", e.target.value)}
              >
                {DELIMITERS.map((d) => (
                  <option key={d.label} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className={styles.field}>
              <label htmlFor="ex-quote">Quote</label>
              <Select
                id="ex-quote"
                value={draft.quote}
                onChange={(e) => set("quote", e.target.value as ExtractorOptions["quote"])}
              >
                <option value="needed">Only when needed</option>
                <option value="always">Every field</option>
              </Select>
            </div>
          </>
        ) : null}
        {hasNullText ? (
          <div className={styles.field}>
            <label htmlFor="ex-null">NULL text</label>
            <Input
              id="ex-null"
              mono
              value={draft.nullText}
              placeholder="(empty)"
              onChange={(e) => set("nullText", e.target.value)}
            />
          </div>
        ) : null}
        <div className={styles.field}>
          <label htmlFor="ex-date">Date format</label>
          <Select
            id="ex-date"
            value={draft.dateFormat}
            onChange={(e) => set("dateFormat", e.target.value as DateFormat)}
          >
            {DATE_FORMATS.map((d) => (
              <option key={d} value={d}>
                {DISPLAY_LABELS[d]}
              </option>
            ))}
          </Select>
        </div>
        <Checkbox
          label="Skip computed columns"
          description="Leave out expressions such as with_tax."
          checked={draft.skipComputed}
          onChange={(e) => set("skipComputed", e.target.checked)}
        />
        <Checkbox
          label="Skip generated columns"
          description="Leave out columns the database generates."
          checked={draft.skipGenerated}
          onChange={(e) => set("skipGenerated", e.target.checked)}
        />
        <p className={styles.hintLine}>Options are remembered for each format.</p>
      </div>
    </Dialog>
  );
}
