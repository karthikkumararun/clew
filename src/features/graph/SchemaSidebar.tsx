import { formatCount } from "../explorer/names";
import { cssOfLabel } from "./palette";
import type { GraphSchema, GraphSchemaItem } from "./types";
import styles from "./Graph.module.css";

const KIND_WORDS: Record<string, string> = {
  UNIQUENESS: "UNIQUE",
  NODE_KEY: "NODE KEY",
  RELATIONSHIP_KEY: "KEY",
  NODE_PROPERTY_EXISTENCE: "EXISTS",
  RELATIONSHIP_PROPERTY_EXISTENCE: "EXISTS",
  PROPERTY_TYPE: "TYPE",
};

/** `:User(email) UNIQUE`, as the canvas shows indexes and constraints. */
export function schemaItemText(item: GraphSchemaItem): string {
  const target = item.labels.map((l) => `:${l}`).join("");
  const kind = KIND_WORDS[item.kind] ?? item.kind.replace(/_/g, " ");
  return `${target}(${item.properties.join(", ")}) ${kind}`;
}

export interface SchemaSidebarProps {
  schema: GraphSchema | null;
  loading: boolean;
  error: string | null;
  onLabel: (label: string) => void;
  onType: (type: string) => void;
}

/** Indexes that back a constraint are listed once, as the constraint. */
export function listedSchemaItems(schema: GraphSchema): GraphSchemaItem[] {
  const target = (i: GraphSchemaItem) => `${i.labels.join(":")}|${i.properties.join(",")}`;
  const owned = new Set(schema.constraints.map(target));
  return [...schema.constraints, ...schema.indexes.filter((i) => !owned.has(target(i)))];
}

/** Spec: graph-browser › Graph schema sidebar. */
export function SchemaSidebar({ schema, loading, error, onLabel, onType }: SchemaSidebarProps) {
  return (
    <aside className={styles.schema} aria-label="Graph schema">
      {error ? (
        <div role="alert" className={styles.sideError}>
          {error}
        </div>
      ) : null}
      {!schema && !error ? (
        <div className={styles.sideNote}>{loading ? "Loading schema…" : "No schema yet."}</div>
      ) : null}
      {schema ? (
        <>
          <section aria-labelledby="graph-labels">
            <h2 id="graph-labels" className={styles.sectionHead}>
              Node labels
            </h2>
            <div className={styles.chips}>
              {schema.labels.length === 0 ? <span className={styles.sideNote}>None</span> : null}
              {schema.labels.map((l) => (
                <button
                  key={l.name}
                  type="button"
                  className={styles.label}
                  style={{ background: cssOfLabel(l.name) }}
                  title={`MATCH (n:${l.name}) RETURN n LIMIT 25`}
                  onClick={() => onLabel(l.name)}
                >
                  {l.name} <small>{formatCount(l.count)}</small>
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby="graph-types">
            <h2 id="graph-types" className={styles.sectionHead}>
              Relationship types
            </h2>
            <div className={styles.chips}>
              {schema.relationshipTypes.length === 0 ? (
                <span className={styles.sideNote}>None</span>
              ) : null}
              {schema.relationshipTypes.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  className={styles.type}
                  title={`MATCH p=()-[:${r.name}]->() RETURN p LIMIT 25`}
                  onClick={() => onType(r.name)}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby="graph-keys">
            <h2 id="graph-keys" className={styles.sectionHead}>
              Property keys
            </h2>
            <div className={styles.monoList}>
              {schema.propertyKeys.map((k) => (
                <span key={k}>{k}</span>
              ))}
            </div>
          </section>
          <section aria-labelledby="graph-indexes">
            <h2 id="graph-indexes" className={styles.sectionHead}>
              Indexes &amp; constraints
            </h2>
            <div className={`${styles.monoList} ${styles.dim}`}>
              {listedSchemaItems(schema).map((i) => (
                <span key={`${i.name}:${i.kind}`} title={i.name}>
                  {schemaItemText(i)}
                </span>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </aside>
  );
}
