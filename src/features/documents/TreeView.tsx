import type { MouseEvent } from "react";
import { describe } from "./ejson";
import type { EJson } from "./ejson";
import type { TreeRow } from "./treeModel";
import { tokenOf } from "./ejson";
import styles from "./Documents.module.css";

const TOKEN_CLASS: Record<string, string> = {
  string: styles.string,
  number: styles.number,
  objectid: styles.objectid,
  date: styles.date,
  boolean: styles.boolean,
  container: styles.container,
  other: styles.other,
};

export function ValueText({ value }: { value: EJson }) {
  const d = describe(value);
  if (d.type === "Null") return <span className={styles.nullValue}>null</span>;
  return <span className={TOKEN_CLASS[tokenOf(d.type)]}>{d.display}</span>;
}

export function TreeView({
  rows,
  editedPaths,
  selectedKey,
  onSelect,
  onToggle,
  onEdit,
  onContext,
}: {
  rows: TreeRow[];
  /** Per document index: the stringified paths with staged edits. */
  editedPaths: (docIndex: number) => Set<string>;
  selectedKey: string | null;
  onSelect: (row: TreeRow) => void;
  onToggle: (row: TreeRow) => void;
  onEdit: (row: TreeRow) => void;
  onContext: (row: TreeRow, e: MouseEvent) => void;
}) {
  return (
    <table className={styles.tree} aria-label="Documents">
      <thead>
        <tr>
          <th scope="col" style={{ width: "40%" }}>
            Key
          </th>
          <th scope="col">Value</th>
          <th scope="col" style={{ width: 140 }}>
            Type
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const edited = !row.isDoc && editedPaths(row.docIndex).has(JSON.stringify(row.path));
          return (
            <tr
              key={row.key}
              data-doc={row.isDoc}
              data-selected={selectedKey === row.key}
              data-edited={edited}
              aria-level={row.depth + 1}
              aria-expanded={row.expandable ? row.expanded : undefined}
              tabIndex={0}
              onClick={() => onSelect(row)}
              onDoubleClick={() => (row.described.container ? onToggle(row) : onEdit(row))}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(row);
                onContext(row, e);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "F2") {
                  e.preventDefault();
                  if (row.described.container) onToggle(row);
                  else onEdit(row);
                } else if (e.key === "ArrowRight" && row.expandable && !row.expanded) {
                  onToggle(row);
                } else if (e.key === "ArrowLeft" && row.expanded) {
                  onToggle(row);
                }
              }}
            >
              <td
                className={row.isDoc ? styles.docKey : styles.keyCell}
                style={{ paddingLeft: 12 + row.depth * 20 }}
              >
                {row.expandable ? (
                  <button
                    type="button"
                    className={styles.caret}
                    aria-label={row.expanded ? `Collapse ${row.label}` : `Expand ${row.label}`}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(row);
                    }}
                  >
                    {row.expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className={styles.caret} />
                )}
                {row.label}
              </td>
              <td>
                {row.isDoc || row.described.container ? (
                  <span className={styles.container}>{row.described.display}</span>
                ) : (
                  <ValueText value={row.value} />
                )}
              </td>
              <td className={styles.typeCell}>{row.isDoc ? "Document" : row.described.type}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
