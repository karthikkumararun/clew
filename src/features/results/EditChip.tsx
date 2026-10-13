import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { ChevronDown } from "../../components/icons";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import type { Candidate, EditResolution, TableRef } from "./api";
import styles from "./Results.module.css";

const qualified = (t: { schema: string | null; table: string }) =>
  t.schema ? `${t.schema}.${t.table}` : t.table;

const sameTable = (a: TableRef, b: TableRef) => a.schema === b.schema && a.table === b.table;

/** The chooser's rows: available tables, and unavailable ones with the key they miss. */
export function chooserItems(candidates: Candidate[], current: TableRef | null): MenuItem[] {
  return candidates.map((c) => ({
    id: qualified(c),
    label: (
      <span>
        {qualified(c)}
        {current && sameTable(c, current) ? " ✓" : ""}
      </span>
    ),
    hint: c.available
      ? undefined
      : c.isView
        ? "a view"
        : c.noKey
          ? "no key"
          : `key missing (add ${c.table}.${c.missingKeys.join(", ")})`,
    disabled: !c.available,
  }));
}

export interface EditChipProps {
  resolution: EditResolution | null;
  resolving: boolean;
  error: string | null;
  /** Choosing another table of a joined result. */
  onChoose: (table: TableRef) => void;
  /** The session is read-only: offer the way to read-write. */
  onSwitchToReadWrite: () => void;
  /** The chooser is locked while changes are pending. */
  locked: boolean;
}

/** The chip next to the result tabs: what the result edits, or why it can't be edited. */
export function EditChip(p: EditChipProps) {
  const [menu, setMenu] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setMenu(false);
    opener.current?.focus();
  };
  const res = p.resolution;

  if (p.resolving && !res) return <span className={styles.chipMuted}>Checking editability…</span>;
  if (p.error) return <span className={styles.chipMuted}>Can't check editability</span>;
  if (!res) return null;

  const candidates = res.candidates;
  const choose = candidates.length > 1;
  const chosen = res.kind === "editable" ? res.target : null;

  const chooser = menu ? (
    <>
      <div className={styles.menuScrim} onMouseDown={closeMenu} aria-hidden="true" />
      <AnchoredMenu anchor={opener}>
        <Menu
          aria-label="Choose table"
          items={chooserItems(candidates, chosen)}
          onClose={closeMenu}
          onSelect={(id) => {
            closeMenu();
            const c = candidates.find((x) => qualified(x) === id);
            if (c) p.onChoose({ schema: c.schema, table: c.table });
          }}
        />
      </AnchoredMenu>
    </>
  ) : null;

  if (res.kind === "editable") {
    const keys = res.keyColumns.join(", ");
    return (
      <span className={styles.chipWrap}>
        <button
          ref={opener}
          type="button"
          className={styles.editChip}
          aria-label={`Editing ${qualified(res.target)} · key ${keys}${choose ? ". Change table" : ""}`}
          aria-haspopup={choose ? "menu" : undefined}
          aria-expanded={choose ? menu : undefined}
          title={choose && p.locked ? "Submit or revert the changes to switch table" : undefined}
          disabled={!choose || p.locked}
          onClick={() => choose && setMenu((m) => !m)}
        >
          Editing <span className={styles.mono}>{qualified(res.target)}</span>{" "}
          <span className={styles.chipKey}>· key {keys}</span>
          {choose ? <ChevronDown size={10} /> : null}
        </button>
        {chooser}
      </span>
    );
  }

  const reason = res.reason;
  return (
    <span className={styles.chipWrap}>
      <span className={styles.readOnlyChip} role="status" title={reason.message}>
        <span className={styles.chipLabel}>Read-only</span>
        <span className={styles.chipReason}>{reason.message}</span>
      </span>
      {reason.code === "sessionReadOnly" ? (
        <Button variant="toolbar" onClick={p.onSwitchToReadWrite}>
          Switch to read-write
        </Button>
      ) : null}
      {reason.code === "multipleTables" && choose ? (
        <Button
          ref={opener}
          variant="toolbar"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          Choose table
        </Button>
      ) : null}
      {chooser}
    </span>
  );
}
