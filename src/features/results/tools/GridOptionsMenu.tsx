/**
 * Contract: the "More options" (⋯) menu of the result toolbar (spec: data-grid › Grid options
 * menu, Go to row and related rows). Every action is a callback; an action whose callback or
 * data is missing is shown disabled with the reason (tooltip, accessible description and a
 * visible dim hint) instead of being hidden.
 *
 * Items, in order: Value editor and Aggregate view (toggles, shown when their handler is given),
 * Reset view, View query (opens a dialog with the statement), Copy query to console, Copy query to
 * clipboard, Go to row (opens `GoToRowDialog`), Related rows (one entry per foreign key of the
 * table and per table referencing it, built with `referencedRows` / `referencingRows`), Show DDL,
 * Reveal in explorer, Result settings (when given). "Paste format" belongs to the paste tools and
 * is not part of this component.
 *
 * Related rows: `foreignKeys` are this table's FKs (rows to the parent) and `referencedBy` the FKs of
 * other tables pointing here (rows in the children). `rowValue(column)` reads the selected row's
 * value by column name (undefined: not in the result). With `column` set only the keys that
 * involve that column are offered (the cell menu). `onOpenRelated` receives the SELECT and the
 * table: open it in a new console of the same connection.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import type { Value } from "../../../lib/ipc/drivers";
import type { SqlFlavor } from "../../grid/sqlLiteral";
import {
  copyQueryText,
  referencedRows,
  referencingRows,
  viewQueryText,
} from "../../grid/tools/gridOptions";
import type {
  ForeignKeyInput,
  GoToTarget,
  ReferencedByInput,
  TableRef,
} from "../../grid/tools/gridOptions";
import { GoToRowDialog } from "./GoToRowDialog";
import styles from "./ResultTools.module.css";

export interface GridOptionsMenuProps {
  flavor: SqlFlavor;

  /** Toggles; the item appears when `onToggle…` is given. */
  valueEditorOpen?: boolean;
  onToggleValueEditor?: () => void;
  aggregateOpen?: boolean;
  onToggleAggregate?: () => void;

  /** Column order, widths, hidden columns, sort and local filters back to the original. */
  onResetView: () => void;

  /** The statement behind the result (null or empty: no query to show or copy). */
  query: string | null;
  /** Open the statement in a new console of the same connection. */
  onCopyQueryToConsole: (statement: string) => void;
  onCopyQueryToClipboard: (statement: string) => void;

  /** Go to row. Omit to disable it. */
  goTo?: {
    rowCount: number;
    keyColumns?: number;
    keyNames?: string[];
    onGo: (target: GoToTarget) => string | void;
    /** Shortcut text for the hint, from the shortcut registry (for example "⌘G"). */
    shortcutHint?: string;
  };
  /** Controlled open state of the Go to row dialog (so Mod+G can open it). */
  goToOpen?: boolean;
  onGoToOpenChange?: (open: boolean) => void;

  /** Related rows. Omit to disable it ("No foreign key information"). */
  related?: {
    foreignKeys: readonly ForeignKeyInput[];
    referencedBy: readonly ReferencedByInput[];
    rowValue: (column: string) => Value | undefined;
    column?: string;
    onOpenRelated: (statement: string, table: TableRef) => void;
  };

  /** Omit when the result has no source table. */
  onShowDdl?: () => void;
  onRevealInExplorer?: () => void;
  onResultSettings?: () => void;
}

type Entry =
  | { kind: "sep"; id: string }
  | { kind: "group"; id: string; label: string }
  | {
      kind: "item";
      id: string;
      label: string;
      mark?: boolean;
      hint?: string;
      /** Why the item is disabled. */
      disabled?: string;
      run: () => void;
    };

const colList = (c: readonly string[]) => c.join(", ");

export function GridOptionsMenu(props: GridOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [queryOpen, setQueryOpen] = useState(false);
  const [goLocal, setGoLocal] = useState(false);
  const goOpen = props.goToOpen ?? goLocal;
  const setGoOpen = (v: boolean) => (props.onGoToOpenChange ?? setGoLocal)(v);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const entries = useMemo<Entry[]>(() => {
    const p = props;
    const out: Entry[] = [];
    const sep = (id: string) => out.push({ kind: "sep", id });
    const hasQuery = !!p.query && viewQueryText(p.query) !== "";
    const noQuery = hasQuery ? undefined : "There is no query behind this result";
    const noTable = "This result has no source table";

    if (p.onToggleValueEditor) {
      out.push({
        kind: "item",
        id: "value-editor",
        label: "Value editor",
        mark: p.valueEditorOpen,
        run: p.onToggleValueEditor,
      });
    }
    if (p.onToggleAggregate) {
      out.push({
        kind: "item",
        id: "aggregate",
        label: "Aggregate view",
        mark: p.aggregateOpen,
        run: p.onToggleAggregate,
      });
    }
    if (out.length) sep("s1");
    out.push({ kind: "item", id: "reset", label: "Reset view", run: p.onResetView });
    sep("s2");
    out.push(
      {
        kind: "item",
        id: "view-query",
        label: "View query",
        disabled: noQuery,
        run: () => setQueryOpen(true),
      },
      {
        kind: "item",
        id: "query-console",
        label: "Copy query to console",
        disabled: noQuery,
        run: () => p.onCopyQueryToConsole(copyQueryText(p.query ?? "")),
      },
      {
        kind: "item",
        id: "query-clipboard",
        label: "Copy query to clipboard",
        disabled: noQuery,
        run: () => p.onCopyQueryToClipboard(copyQueryText(p.query ?? "")),
      },
    );
    sep("s3");
    out.push({
      kind: "item",
      id: "go-to-row",
      label: "Go to row…",
      hint: p.goTo?.shortcutHint,
      disabled: !p.goTo
        ? "Not available for this result"
        : p.goTo.rowCount <= 0
          ? "There are no rows"
          : undefined,
      run: () => setGoOpen(true),
    });

    const r = p.related;
    const fks = (r?.foreignKeys ?? []).filter((f) => !r?.column || f.columns.includes(r.column));
    const kids = (r?.referencedBy ?? []).filter(
      (b) => !r?.column || b.refColumns.includes(r.column),
    );
    if (!r || fks.length + kids.length === 0) {
      out.push({
        kind: "item",
        id: "related",
        label: "Related rows",
        disabled: !r ? "No foreign key information for this result" : "No foreign keys here",
        run: () => {},
      });
    } else {
      out.push({ kind: "group", id: "related-group", label: "Related rows" });
      fks.forEach((fk, i) => {
        const res = referencedRows(p.flavor, fk, r.rowValue);
        out.push({
          kind: "item",
          id: `ref-${i}`,
          label: `References ${fk.refTable} (${colList(fk.columns)})`,
          disabled: res.ok ? undefined : res.reason,
          run: () => res.ok && r.onOpenRelated(res.sql, res.table),
        });
      });
      kids.forEach((by, i) => {
        const res = referencingRows(p.flavor, by, r.rowValue);
        out.push({
          kind: "item",
          id: `by-${i}`,
          label: `Referenced by ${by.table} (${colList(by.columns)})`,
          disabled: res.ok ? undefined : res.reason,
          run: () => res.ok && r.onOpenRelated(res.sql, res.table),
        });
      });
    }
    sep("s4");
    out.push(
      {
        kind: "item",
        id: "ddl",
        label: "Show DDL",
        disabled: p.onShowDdl ? undefined : noTable,
        run: () => p.onShowDdl?.(),
      },
      {
        kind: "item",
        id: "reveal",
        label: "Reveal in explorer",
        disabled: p.onRevealInExplorer ? undefined : noTable,
        run: () => p.onRevealInExplorer?.(),
      },
    );
    if (p.onResultSettings) {
      sep("s5");
      out.push({
        kind: "item",
        id: "settings",
        label: "Result settings…",
        run: p.onResultSettings,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props]);

  const buttons = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (open)
      buttons()
        .find((b) => !b.disabled)
        ?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = buttons().filter((b) => !b.disabled);
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      enabled[(i + enabled.length) % enabled.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") setOpen(false);
  };

  return (
    <span className={styles.menuWrap}>
      <button
        ref={trigger}
        type="button"
        className={styles.iconBtn}
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="3.5" cy="8" r="1" />
          <circle cx="8" cy="8" r="1" />
          <circle cx="12.5" cy="8" r="1" />
        </svg>
      </button>
      {open ? (
        <>
          <div className={styles.scrim} onMouseDown={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={list}
            role="menu"
            aria-label="More options"
            className={styles.menu}
            onKeyDown={onKeyDown}
          >
            {entries.map((en) => {
              if (en.kind === "sep")
                return <div key={en.id} role="separator" className={styles.menuSep} />;
              if (en.kind === "group") {
                return (
                  <div key={en.id} role="presentation" className={styles.menuGroup}>
                    {en.label}
                  </div>
                );
              }
              return (
                <button
                  key={en.id}
                  type="button"
                  role={en.mark !== undefined ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={en.mark !== undefined ? en.mark : undefined}
                  aria-label={en.label}
                  aria-disabled={en.disabled ? true : undefined}
                  aria-description={en.disabled}
                  title={en.disabled}
                  disabled={!!en.disabled}
                  className={styles.menuItem}
                  onClick={() => {
                    setOpen(false);
                    en.run();
                  }}
                >
                  <span className={styles.menuMark} aria-hidden="true">
                    {en.mark ? "✓" : ""}
                  </span>
                  <span className={styles.menuLabel}>{en.label}</span>
                  {en.hint ? <span className={styles.menuHint}>{en.hint}</span> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      {queryOpen ? (
        <Dialog
          title="Query"
          maxWidth={720}
          onClose={() => setQueryOpen(false)}
          footer={
            <div className={styles.footer}>
              <Button
                onClick={() => props.onCopyQueryToClipboard(copyQueryText(props.query ?? ""))}
              >
                Copy query to clipboard
              </Button>
              <Button
                onClick={() => {
                  setQueryOpen(false);
                  props.onCopyQueryToConsole(copyQueryText(props.query ?? ""));
                }}
              >
                Copy query to console
              </Button>
              <Button variant="primary" onClick={() => setQueryOpen(false)}>
                Close
              </Button>
            </div>
          }
        >
          <pre className={styles.text} aria-label="Query text" tabIndex={0}>
            {viewQueryText(props.query ?? "")}
          </pre>
        </Dialog>
      ) : null}
      {goOpen && props.goTo ? (
        <GoToRowDialog
          rowCount={props.goTo.rowCount}
          keyColumns={props.goTo.keyColumns}
          keyNames={props.goTo.keyNames}
          onGo={props.goTo.onGo}
          onClose={() => setGoOpen(false)}
        />
      ) : null}
    </span>
  );
}
