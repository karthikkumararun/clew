import { useState } from "react";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { ChevronDown } from "../../components/icons";
import type { ColumnMeta } from "../../lib/ipc/drivers";
import { useNotices } from "../../stores/noticesStore";
import type { CopyFormat } from "./copyFormats";
import type { GridHandle } from "./ResultGrid";
import styles from "./GridMenus.module.css";

interface MenuButtonProps {
  label: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
  /** Keep the menu open after a choice (toggling several columns). */
  stayOpen?: boolean;
  disabled?: boolean;
  "aria-label": string;
}

function MenuButton({ label, items, onSelect, stayOpen, disabled, ...rest }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <ChevronDown size={12} />
      </button>
      {open ? (
        <>
          <div className={styles.scrim} onMouseDown={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.menu}>
            <Menu
              aria-label={rest["aria-label"]}
              items={items}
              onClose={() => setOpen(false)}
              onSelect={(id) => {
                if (!stayOpen) setOpen(false);
                onSelect(id);
              }}
            />
          </div>
        </>
      ) : null}
    </span>
  );
}

/** "Columns · 6 of 9": show and hide columns. */
export function ColumnsMenu(props: {
  columns: ColumnMeta[];
  hidden: ReadonlySet<number>;
  onToggle: (column: number) => void;
  onShowAll: () => void;
}) {
  const { columns, hidden } = props;
  const shown = columns.length - [...hidden].filter((c) => c < columns.length).length;
  return (
    <MenuButton
      aria-label="Columns"
      label={`Columns · ${shown} of ${columns.length}`}
      stayOpen
      items={[
        ...columns.map((c, i) => ({
          id: String(i),
          label: `${hidden.has(i) ? "☐" : "☑"} ${c.name}`,
        })),
        { id: "all", label: "Show all columns", disabled: hidden.size === 0 },
      ]}
      onSelect={(id) => (id === "all" ? props.onShowAll() : props.onToggle(Number(id)))}
    />
  );
}

const FORMATS: { id: CopyFormat; label: string }[] = [
  { id: "tsv", label: "TSV with headers" },
  { id: "csv", label: "CSV" },
  { id: "json", label: "JSON" },
  { id: "markdown", label: "Markdown table" },
  { id: "insert", label: "SQL INSERT" },
];

/** "Copy as" the selection in another format. */
export function CopyAsMenu({ grid }: { grid: { current: GridHandle | null } }) {
  const say = (m: string) => useNotices.getState().push(m);
  return (
    <MenuButton
      aria-label="Copy as"
      label="Copy as"
      items={FORMATS.map((f) => ({ id: f.id, label: f.label }))}
      onSelect={async (id) => {
        const handle = grid.current;
        if (!handle) return;
        try {
          const n = await handle.copyAs(id as CopyFormat);
          say(
            n === 0
              ? "Select some cells to copy first"
              : `Copied ${n.toLocaleString()} ${n === 1 ? "row" : "rows"} as ${FORMATS.find((f) => f.id === id)?.label}`,
          );
        } catch {
          say("Couldn't copy to the clipboard");
        }
      }}
    />
  );
}
