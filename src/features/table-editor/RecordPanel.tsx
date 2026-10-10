import { IconButton } from "../../components/Button";
import { Close } from "../../components/icons";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { lookOf } from "../grid/cellStyle";
import type { ReferenceLink, ReferencedLink } from "./recordData";
import styles from "./TableEditor.module.css";

export interface RecordPanelProps {
  columns: ColumnMeta[];
  /** Current values (edits applied) and the loaded ones, for "was <old>". */
  values: Value[];
  originals: Value[];
  /** `Record #88213` */
  title: string;
  references: ReferenceLink[] | null;
  referencedBy: ReferencedLink[] | null;
  onCopyJson: () => void;
  onFollow: (link: ReferenceLink) => void;
  onOpenReferencing: (link: ReferencedLink) => void;
  onClose: () => void;
}

const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

/** The selected row as a key/value list, with the rows it points to and the ones pointing at it. */
export function RecordPanel(p: RecordPanelProps) {
  return (
    <aside className={styles.record} aria-label="Record">
      <header className={styles.recordHeader}>
        <strong className={styles.recordTitle}>{p.title}</strong>
        <button type="button" className={styles.link} onClick={p.onCopyJson}>
          Copy as JSON
        </button>
        <IconButton aria-label="Close record panel" onClick={p.onClose}>
          <Close size={12} />
        </IconButton>
      </header>
      <div className={styles.recordBody}>
        <dl className={styles.recordList}>
          {p.columns.map((c, i) => {
            const changed = !same(p.values[i], p.originals[i]);
            return (
              <div key={c.name} className={styles.recordRow} data-changed={changed || undefined}>
                <dt>{c.name}</dt>
                <dd>
                  {lookOf(p.values[i]).text}
                  {changed ? (
                    <span className={styles.was}> was {lookOf(p.originals[i]).text}</span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
        {p.references && p.references.length > 0 ? (
          <section aria-label="References">
            <h3 className={styles.viewHeading}>References</h3>
            <ul className={styles.recordLinks}>
              {p.references.map((l) => (
                <li key={l.fk.name ?? l.label}>
                  <button type="button" className={styles.link} onClick={() => p.onFollow(l)}>
                    {l.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {p.referencedBy && p.referencedBy.length > 0 ? (
          <section aria-label="Referenced by">
            <h3 className={styles.viewHeading}>Referenced by</h3>
            <ul className={styles.recordLinks}>
              {p.referencedBy.map((l) => (
                <li key={`${l.ref.schema}.${l.ref.table}.${l.ref.name}`}>
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => p.onOpenReferencing(l)}
                  >
                    {l.ref.table}
                    {l.rows === null
                      ? ""
                      : ` · ${l.rows.toLocaleString()} ${l.rows === 1 ? "row" : "rows"}`}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
