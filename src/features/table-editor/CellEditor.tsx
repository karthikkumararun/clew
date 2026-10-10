import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import type { NewValue } from "./api";
import { editText, parseEdit, placeholderFor } from "./editValue";
import styles from "./TableEditor.module.css";

export interface CellEditorProps {
  column: ColumnMeta;
  current: Value;
  /** False for NOT NULL columns. */
  nullable: boolean;
  /** UPDATE ... = DEFAULT isn't available everywhere (SQLite). */
  allowDefault: boolean;
  onSubmit: (value: NewValue) => void;
  onClose: () => void;
}

/** Edit one cell: a control that fits the column's type, plus Set NULL / Set DEFAULT. */
export function CellEditor({
  column,
  current,
  nullable,
  allowDefault,
  onSubmit,
  onClose,
}: CellEditorProps) {
  const [text, setText] = useState(editText(current));
  const [error, setError] = useState<string | null>(null);
  const multiline = column.kind === "json" || (column.kind === "text" && text.includes("\n"));

  const apply = () => {
    const parsed = parseEdit(column, text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    onSubmit({ kind: "value", value: parsed.value });
  };

  const common = {
    id: "cell-editor-input",
    "aria-label": `Value of ${column.name}`,
    "aria-invalid": error ? true : undefined,
    className: styles.cellInput,
    value: text,
    placeholder: placeholderFor(column.kind),
    autoFocus: true,
    spellCheck: false,
  } as const;

  return (
    <Dialog
      title={`Edit ${column.name}`}
      maxWidth={460}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="default"
            disabled={!nullable}
            title={nullable ? undefined : "This column doesn't allow NULL"}
            onClick={() => onSubmit({ kind: "value", value: { kind: "null" } })}
          >
            Set NULL
          </Button>
          <Button
            variant="default"
            disabled={!allowDefault}
            title={allowDefault ? undefined : "This database can't set a column to DEFAULT"}
            onClick={() => onSubmit({ kind: "default" })}
          >
            Set DEFAULT
          </Button>
          <div className={styles.grow} />
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <p className={styles.cellMeta}>
        <span className={styles.mono}>{column.type_name}</span>
        {nullable ? " · nullable" : " · not null"}
      </p>
      {column.kind === "bool" ? (
        <select
          {...common}
          value={text.toLowerCase() === "false" ? "false" : "true"}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : multiline ? (
        <textarea
          {...common}
          rows={9}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              apply();
            }
          }}
        />
      ) : (
        <input
          {...common}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
        />
      )}
      {error ? (
        <p className={styles.inputError} role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
