/**
 * Contract: the Tree view of a result (spec: data-grid › View as › JSON in tree view). One root per
 * row (or per column when transposed); JSON, arrays and structured values expand in place with
 * type colours, built by `toTree` and rendered by the document browser's tree (`flattenDocs`).
 * Read-only. Roots and their first level start open. Honours "Skip computed / generated columns".
 */
import { useEffect, useMemo, useState } from "react";
import { TreeView as DocTree } from "../../documents/TreeView";
import { flattenDocs } from "../../documents/treeModel";
import type { TreeRow } from "../../documents/treeModel";
import { toTree } from "../../grid/tools/viewAs";
import { useResultData } from "./resultViewData";
import type { ResultViewProps } from "./resultViewData";
import styles from "./ResultTools.module.css";

const NO_EDITS = new Set<string>();
const noop = () => {};

export function ResultTreeView(props: ResultViewProps) {
  const { data, options, shown, total } = useResultData(props);
  const tree = useMemo(
    () =>
      toTree(data.rows, data.columns, {
        extractor: options,
        transpose: props.transpose,
        firstRow: props.firstRow,
      }),
    [data, options, props.transpose, props.firstRow],
  );
  const initial = useMemo(() => {
    const open = new Set<string>();
    for (let pass = 0; pass < 2; pass++) {
      for (const r of flattenDocs(tree.docs, open, tree.keyOf)) if (r.expandable) open.add(r.key);
    }
    return open;
  }, [tree]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setExpanded(initial), [initial]);

  const rows = useMemo(
    () =>
      flattenDocs(tree.docs, expanded, tree.keyOf).map((r) =>
        r.isDoc ? { ...r, label: tree.titles[r.docIndex] ?? r.label } : r,
      ),
    [tree, expanded],
  );

  const toggle = (row: TreeRow) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(row.key)) next.add(row.key);
      return next;
    });

  if (tree.docs.length === 0) return <div className={styles.empty}>No rows to show.</div>;
  return (
    <div className={styles.view} role="region" aria-label="Result as tree">
      {shown < total ? (
        <div className={styles.viewBar} role="status">
          Showing the first {shown} of {total} rows.
        </div>
      ) : null}
      <div className={styles.viewBody}>
        <DocTree
          rows={rows}
          editedPaths={() => NO_EDITS}
          selectedKey={selected}
          onSelect={(r) => setSelected(r.key)}
          onToggle={toggle}
          onEdit={noop}
          onContext={noop}
        />
      </div>
    </div>
  );
}
