import { useMemo, useState } from "react";
import { FoldableJson } from "./FoldableJson";
import { idOf } from "./ejson";
import type { EJson } from "./ejson";
import { flattenDocs } from "./treeModel";
import { TreeView } from "./TreeView";
import styles from "./Documents.module.css";

export type DocResultView = "tree" | "table" | "json";

const VIEWS: { id: DocResultView; label: string }[] = [
  { id: "tree", label: "Tree" },
  { id: "table", label: "Table" },
  { id: "json", label: "JSON" },
];

const docKey = (doc: EJson) => JSON.stringify(idOf(doc) ?? null);

/** Tree / Table / JSON switch for a document result. */
export function DocViewSwitch({
  value,
  onChange,
  omitTable,
}: {
  value: DocResultView;
  onChange: (v: DocResultView) => void;
  omitTable?: boolean;
}) {
  return (
    <div role="tablist" aria-label="Document view mode" className={styles.segmented}>
      {VIEWS.filter((v) => !(omitTable && v.id === "table")).map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          className={styles.segmentSmall}
          aria-selected={value === v.id}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

/** A document result read-only, as a tree or as shell-syntax JSON. */
export function DocumentsResult({
  docs,
  view,
  version,
}: {
  docs: EJson[];
  view: "tree" | "json";
  /** Changes when `docs` grew in place (more pages arrived). */
  version: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => flattenDocs(docs, expanded, docKey), [docs, version, expanded]);
  if (view === "json") {
    return (
      <div>
        {docs.map((d, i) => (
          <div key={`${docKey(d)}-${i}`} className={styles.jsonDoc}>
            <FoldableJson doc={d} docId={`${docKey(d)}-${i}`} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <TreeView
      rows={rows}
      editedPaths={() => new Set()}
      selectedKey={selected}
      onSelect={(r) => setSelected(r.key)}
      onToggle={(row) =>
        setExpanded((cur) => {
          const next = new Set(cur);
          if (next.has(row.key)) next.delete(row.key);
          else next.add(row.key);
          return next;
        })
      }
      onEdit={() => {}}
      onContext={() => {}}
    />
  );
}
