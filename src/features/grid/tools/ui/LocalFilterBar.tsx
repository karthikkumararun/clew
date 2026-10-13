/**
 * Contract: the local filter bar (spec: data-grid › Local filter), shown when the toolbar's
 * filter toggle is on; the lead unmounts it (and clears the filters) when it is turned off.
 *
 * Props:
 *  - `columns`: the result's columns; the filter's `column` is the index in this array.
 *  - `filters`: the active filters (controlled); an empty array means nothing is filtered.
 *  - `onChange(filters)`: fired on each valid edit (no debounce; the parent should defer the
 *    row computation, e.g. `useDeferredValue`). Invalid input is shown but never emitted, the
 *    column keeps its previous filter until the text parses.
 *  - `summary`: shown / total rows for "Showing n of m rows"; `hiddenPending`: pending changes
 *    in hidden rows, shown as a note (see `hiddenPending` in localFilter.ts).
 * One input per column accepting `contains ship`, `> 200`, `100..200`, `null`, `not null`, ...
 */
import { useId, useState } from "react";
import type { ColumnMeta } from "../../../../lib/ipc/drivers";
import { filterSummary, hiddenPendingNote, parseFilterInput } from "../localFilter";
import type { ColumnFilter } from "../localFilter";
import styles from "./tools.module.css";

export interface LocalFilterBarProps {
  columns: ColumnMeta[];
  filters: ColumnFilter[];
  onChange: (filters: ColumnFilter[]) => void;
  summary: { shown: number; total: number };
  hiddenPending: number;
}

/** The text that parses back to `f` (for showing filters set elsewhere). */
export function filterText(f: ColumnFilter): string {
  const v = f.value ?? "";
  switch (f.op) {
    case "isNull":
      return "null";
    case "notNull":
      return "not null";
    case "contains":
      return `contains ${v}`;
    case "equals":
      return `equals ${v}`;
    case "startsWith":
      return `starts with ${v}`;
    case "endsWith":
      return `ends with ${v}`;
    case "eq":
      return `= ${v}`;
    case "ne":
      return `<> ${v}`;
    case "lt":
      return `< ${v}`;
    case "gt":
      return `> ${v}`;
    case "le":
      return `<= ${v}`;
    case "ge":
      return `>= ${v}`;
    default:
      return `${v}..${f.value2 ?? ""}`;
  }
}

export function LocalFilterBar({
  columns,
  filters,
  onChange,
  summary,
  hiddenPending,
}: LocalFilterBarProps) {
  const id = useId();
  // Drafts hold what is typed, which may not parse yet.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});

  const textOf = (c: number) => {
    if (c in drafts) {
      // A draft that parsed but whose filter is gone (reset elsewhere) is stale.
      if (!errors[c] && drafts[c].trim() && !filters.some((f) => f.column === c)) return "";
      return drafts[c];
    }
    const f = filters.find((x) => x.column === c);
    return f ? filterText(f) : "";
  };

  const edit = (c: number, text: string) => {
    setDrafts((d) => ({ ...d, [c]: text }));
    const parsed = parseFilterInput(text, columns[c].kind);
    if (!parsed.ok) {
      setErrors((e) => ({ ...e, [c]: parsed.error }));
      return;
    }
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => Number(k) !== c)));
    const rest = filters.filter((f) => f.column !== c);
    onChange(parsed.filter ? [...rest, { column: c, ...parsed.filter }] : rest);
  };

  const clearAll = () => {
    setDrafts({});
    setErrors({});
    onChange([]);
  };
  const note = hiddenPendingNote(hiddenPending);
  const any = filters.length > 0 || Object.values(drafts).some((t) => t.trim() !== "");

  return (
    <div className={styles.filterBar} role="group" aria-label="Local filter">
      <div className={styles.filterFields}>
        {columns.map((col, c) => {
          const text = textOf(c);
          const err = errors[c];
          return (
            <div key={c} className={styles.filterField}>
              <label className={styles.filterLabel} htmlFor={`${id}-${c}`}>
                {col.name}
              </label>
              <span className={styles.filterInputWrap}>
                <input
                  id={`${id}-${c}`}
                  className={styles.filterInput}
                  aria-label={`Filter ${col.name}`}
                  aria-invalid={err !== undefined}
                  aria-describedby={err ? `${id}-${c}-err` : undefined}
                  placeholder={
                    col.kind === "int" || col.kind === "decimal" || col.kind === "float"
                      ? "> 200"
                      : "contains…"
                  }
                  spellCheck={false}
                  value={text}
                  onChange={(e) => edit(c, e.target.value)}
                />
                {text !== "" && (
                  <button
                    type="button"
                    className={styles.inputClear}
                    aria-label={`Clear filter on ${col.name}`}
                    onClick={() => edit(c, "")}
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                )}
              </span>
              {err && (
                <span id={`${id}-${c}-err`} className={styles.fieldError}>
                  {err}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.filterFooter}>
        <span role="status" aria-label="Filter summary" className={styles.filterSummary}>
          {filterSummary(summary.shown, summary.total)}
        </span>
        {note && <span className={styles.pendingNote}>{note}</span>}
        <button type="button" className={styles.link} disabled={!any} onClick={clearAll}>
          Clear filters
        </button>
      </div>
    </div>
  );
}
