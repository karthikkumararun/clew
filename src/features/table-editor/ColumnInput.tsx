import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { applyCompletion, completeAt } from "./complete";
import type { SqlFlavor } from "../grid/sqlLiteral";
import styles from "./TableEditor.module.css";

export interface ColumnInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter (with no suggestion highlighted). */
  onSubmit: () => void;
  columns: string[];
  flavor: SqlFlavor;
  error?: string | null;
  invalid?: boolean;
  /** Lets the parent focus the input (Filter table by this column). */
  inputRef?: React.Ref<HTMLInputElement>;
}

/** A raw-SQL input that suggests column names as you type. */
export function ColumnInput({
  id,
  label,
  value,
  onChange,
  onSubmit,
  columns,
  flavor,
  error,
  invalid,
  inputRef,
}: ColumnInputProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const completion = open ? completeAt(value, caret, columns) : null;

  const accept = (column: string) => {
    if (!completion) return;
    const next = applyCompletion(value, completion, column, flavor);
    onChange(next.text);
    setOpen(false);
    requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (completion) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = completion.items.length;
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        accept(completion.items[Math.min(active, completion.items.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={styles.inputWrap}>
      <input
        ref={(el) => {
          input.current = el;
          if (typeof inputRef === "function") inputRef(el);
          else if (inputRef)
            (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
        }}
        id={id}
        className={styles.sqlInput}
        data-invalid={invalid || undefined}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={completion ? listId : undefined}
        aria-expanded={completion !== null}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
          setOpen(true);
        }}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") && !completion)
            setCaret(e.currentTarget.selectionStart ?? 0);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {completion ? (
        <ul id={listId} role="listbox" aria-label={`${label} columns`} className={styles.suggest}>
          {completion.items.map((c, i) => (
            <li
              key={c}
              role="option"
              aria-selected={i === active}
              className={styles.suggestItem}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(c);
              }}
            >
              {c}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className={styles.inputError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
