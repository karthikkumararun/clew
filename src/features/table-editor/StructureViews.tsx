import { useState } from "react";
import { Button } from "../../components/Button";
import { useNotices } from "../../stores/noticesStore";
import type { TableMeta } from "./api";
import styles from "./TableEditor.module.css";

const bytes = (n: number | null) =>
  n === null
    ? ""
    : n < 1024
      ? `${n} B`
      : n < 1024 ** 2
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1024 ** 2).toFixed(1)} MB`;

function Empty({ children }: { children: string }) {
  return <p className={styles.viewEmpty}>{children}</p>;
}

/** Structure: name, type, nullable, default, PK / FK markers, comment. */
export function StructureView({ meta }: { meta: TableMeta }) {
  const fkOf = (col: string) => meta.foreignKeys.find((f) => f.columns.includes(col));
  return (
    <div className={styles.viewScroll}>
      <table className={styles.viewTable} aria-label="Columns">
        <thead>
          <tr>
            <th scope="col">Column</th>
            <th scope="col">Type</th>
            <th scope="col">Nullable</th>
            <th scope="col">Default</th>
            <th scope="col">Key</th>
            <th scope="col">Comment</th>
          </tr>
        </thead>
        <tbody>
          {meta.columns.map((c) => {
            const fk = fkOf(c.name);
            return (
              <tr key={c.name}>
                <td className={styles.mono}>{c.name}</td>
                <td className={`${styles.mono} ${styles.dim}`}>{c.typeName}</td>
                <td>{c.nullable ? "yes" : "no"}</td>
                <td className={`${styles.mono} ${styles.dim}`}>{c.default ?? ""}</td>
                <td>
                  {c.primaryKey ? <span className={styles.pk}>PK</span> : null}
                  {fk ? (
                    <span className={styles.fk}>
                      {" "}
                      FK → {fk.refTable}.{fk.refColumns[fk.columns.indexOf(c.name)] ?? ""}
                    </span>
                  ) : null}
                </td>
                <td className={styles.dim}>{c.comment ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Indexes: name, columns, unique, method, size. */
export function IndexesView({ meta }: { meta: TableMeta }) {
  if (meta.indexes.length === 0) return <Empty>This table has no indexes.</Empty>;
  return (
    <div className={styles.viewScroll}>
      <table className={styles.viewTable} aria-label="Indexes">
        <thead>
          <tr>
            <th scope="col">Index</th>
            <th scope="col">Columns</th>
            <th scope="col">Unique</th>
            <th scope="col">Method</th>
            <th scope="col">Size</th>
          </tr>
        </thead>
        <tbody>
          {meta.indexes.map((i) => (
            <tr key={i.name}>
              <td className={styles.mono}>
                {i.name}
                {i.primary ? <span className={styles.pk}> PK</span> : null}
              </td>
              <td className={styles.mono}>{i.columns.join(", ")}</td>
              <td>{i.unique ? "yes" : "no"}</td>
              <td className={styles.dim}>{i.method ?? ""}</td>
              <td className={styles.dim}>{bytes(i.sizeBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Relations: foreign keys from this table, and those pointing at it. */
export function RelationsView({
  meta,
  onOpen,
}: {
  meta: TableMeta;
  onOpen: (schema: string | null, table: string) => void;
}) {
  if (meta.foreignKeys.length === 0 && meta.referencedBy.length === 0) {
    return <Empty>This table has no foreign keys and nothing references it.</Empty>;
  }
  return (
    <div className={styles.viewScroll}>
      <h3 className={styles.viewHeading}>References</h3>
      {meta.foreignKeys.length === 0 ? (
        <Empty>No foreign keys.</Empty>
      ) : (
        <table className={styles.viewTable} aria-label="Outgoing foreign keys">
          <thead>
            <tr>
              <th scope="col">Constraint</th>
              <th scope="col">Columns</th>
              <th scope="col">Table</th>
              <th scope="col">On delete</th>
              <th scope="col">On update</th>
            </tr>
          </thead>
          <tbody>
            {meta.foreignKeys.map((f) => (
              <tr key={f.name}>
                <td className={styles.mono}>{f.name}</td>
                <td className={styles.mono}>
                  {f.columns.join(", ")} → {f.refColumns.join(", ")}
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => onOpen(f.refSchema, f.refTable)}
                  >
                    {f.refTable}
                  </button>
                </td>
                <td className={styles.dim}>{f.onDelete ?? ""}</td>
                <td className={styles.dim}>{f.onUpdate ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className={styles.viewHeading}>Referenced by</h3>
      {meta.referencedBy.length === 0 ? (
        <Empty>Nothing references this table.</Empty>
      ) : (
        <table className={styles.viewTable} aria-label="Incoming foreign keys">
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col">Constraint</th>
              <th scope="col">Columns</th>
            </tr>
          </thead>
          <tbody>
            {meta.referencedBy.map((r) => (
              <tr key={`${r.table}.${r.name}`}>
                <td>
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => onOpen(r.schema, r.table)}
                  >
                    {r.table}
                  </button>
                </td>
                <td className={styles.mono}>{r.name}</td>
                <td className={styles.mono}>
                  {r.columns.join(", ")} → {r.refColumns.join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** DDL: the read-only CREATE statement with Copy and Open in console. */
export function DdlView({
  ddl,
  error,
  onOpenInConsole,
}: {
  ddl: string | null;
  error: string | null;
  onOpenInConsole: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (error)
    return (
      <p className={styles.viewEmpty} role="alert">
        {error}
      </p>
    );
  if (ddl === null) return <Empty>Loading…</Empty>;
  return (
    <div className={styles.ddl}>
      <div className={styles.ddlBar}>
        <Button
          variant="default"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await navigator.clipboard.writeText(ddl);
              useNotices.getState().push("Copied the DDL");
            } catch {
              useNotices.getState().push("Couldn't copy to the clipboard");
            } finally {
              setBusy(false);
            }
          }}
        >
          Copy
        </Button>
        <Button variant="default" onClick={onOpenInConsole}>
          Open in console
        </Button>
      </div>
      <pre className={styles.ddlText} aria-label="DDL">
        {ddl}
      </pre>
    </div>
  );
}
