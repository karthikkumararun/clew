import { useMemo, useState } from "react";
import { jsonLines } from "./foldModel";
import type { EJson } from "./ejson";
import styles from "./Documents.module.css";

/** A document as shell-syntax JSON, read-only, with every object and array foldable. */
export function FoldableJson({ doc, docId }: { doc: EJson; docId: string }) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const lines = useMemo(() => jsonLines(doc, docId, folded), [doc, docId, folded]);
  const toggle = (id: string) =>
    setFolded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className={styles.json} role="group" aria-label="Document JSON">
      {lines.map((l, i) => (
        <div key={i} className={styles.jsonLine} style={{ paddingLeft: l.depth * 20 }}>
          {l.fold ? (
            <button
              type="button"
              className={styles.fold}
              aria-label={l.folded ? "Unfold" : "Fold"}
              aria-expanded={!l.folded}
              onClick={() => toggle(l.fold!)}
            >
              {l.folded ? "▸" : "▾"}
            </button>
          ) : (
            <span className={styles.fold} />
          )}
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
