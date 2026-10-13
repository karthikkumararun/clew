/**
 * Contract: "Go to row…" (spec: data-grid › Go to row and related rows). One box that takes a row
 * number ("150", counted from 1 and clamped to the loaded rows) or a key (`key: 42`, `=42`, comma
 * separated for composite keys), parsed with `parseGoTo`. `onGo` receives the parsed target and
 * does the scroll and select (use `findRowByKey` for keys); return an error string (for example
 * "No loaded row has that key") to keep the dialog open and show it. Mod+G opens it: the caller
 * registers the shortcut and renders this dialog, or uses `GridOptionsMenu`'s controlled mode.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Input } from "../../../components/Input";
import { parseGoTo } from "../../grid/tools/gridOptions";
import type { GoToTarget } from "../../grid/tools/gridOptions";
import styles from "./ResultTools.module.css";

export interface GoToRowDialogProps {
  /** Rows currently displayed (after filters). */
  rowCount: number;
  /** How many columns make up the key (0 or unset: row numbers only). */
  keyColumns?: number;
  /** Names of the key columns, shown in the hint. */
  keyNames?: string[];
  onGo: (target: GoToTarget) => string | void;
  onClose: () => void;
}

export function GoToRowDialog({
  rowCount,
  keyColumns,
  keyNames,
  onGo,
  onClose,
}: GoToRowDialogProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = parseGoTo(text, { rowCount, keyColumns });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const problem = onGo(r.target);
    if (typeof problem === "string") {
      setError(problem);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      title="Go to row"
      onClose={onClose}
      maxWidth={400}
      footer={
        <div className={styles.footer}>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="go-to-row-form">
            Go
          </Button>
        </div>
      }
    >
      <form id="go-to-row-form" className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="go-to-row-input">Row or key</label>
          <Input
            id="go-to-row-input"
            dialog
            mono
            autoFocus
            value={text}
            placeholder={keyColumns ? "150 or key: 42" : "150"}
            aria-invalid={error ? true : undefined}
            aria-describedby="go-to-row-hint"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </div>
        <p id="go-to-row-hint" className={styles.hintLine}>
          {rowCount} {rowCount === 1 ? "row" : "rows"} loaded.
          {keyColumns
            ? ` A key is written key: <value>${keyNames?.length ? ` (${keyNames.join(", ")})` : ""}.`
            : ""}
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
