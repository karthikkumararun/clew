import { useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { Select } from "../../components/Input";
import { Close } from "../../components/icons";
import { primaryLabel } from "./graphModel";
import type { CaptionChoices } from "./graphModel";
import { editText, parseEdit, propertyStyle, propertyText } from "./format";
import { cssOfLabel } from "./palette";
import type { Neighbours } from "./runtime";
import type { GraphNode, GraphRel } from "./types";
import styles from "./Graph.module.css";

export type InspectedElement =
  { kind: "node"; node: GraphNode } | { kind: "relationship"; rel: GraphRel };

export interface InspectorProps {
  element: InspectedElement | null;
  neighbours: Neighbours[] | undefined;
  writable: boolean;
  captions: CaptionChoices;
  expanding: boolean;
  error: string | null;
  onClose: () => void;
  onExpand: (id: string) => void;
  onHide: (id: string) => void;
  onCopy: (element: GraphNode | GraphRel) => void;
  /** Resolves true when the properties were saved. */
  onSave: (
    kind: "node" | "relationship",
    id: string,
    changes: Record<string, unknown>,
  ) => Promise<boolean>;
  onCaption: (label: string, key: string | undefined) => void;
}

/** What the inspector announces to a screen reader when the selection changes. */
export function announcement(element: InspectedElement | null, captionText: string): string {
  if (!element) return "";
  return element.kind === "node"
    ? `Selected node ${element.node.labels.join(", ") || "without label"}: ${captionText}`
    : `Selected relationship ${element.rel.relType}`;
}

/** Spec: graph-browser › Inspector. */
export function Inspector(props: InspectorProps) {
  const { element } = props;
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);

  if (!element) {
    return (
      <aside className={styles.inspector} aria-label="Selected element">
        <div className={styles.inspectorHead}>
          <span className={styles.elementId}>Nothing selected</span>
          <div className={styles.grow} />
          <IconButton aria-label="Close inspector" onClick={props.onClose}>
            <Close size={14} />
          </IconButton>
        </div>
        <div className={styles.empty}>Select a node or relationship to see its properties.</div>
      </aside>
    );
  }

  const item = element.kind === "node" ? element.node : element.rel;
  const properties = item.properties;
  const startEdit = () =>
    setEditing(Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, editText(v)])));

  const save = async () => {
    if (!editing) return;
    const changes: Record<string, unknown> = {};
    for (const [key, text] of Object.entries(editing)) {
      if (text !== editText(properties[key])) changes[key] = parseEdit(text);
    }
    if (Object.keys(changes).length === 0) {
      setEditing(null);
      return;
    }
    setSaving(true);
    const ok = await props.onSave(element.kind, item.elementId, changes);
    setSaving(false);
    if (ok) setEditing(null);
  };

  const label = element.kind === "node" ? primaryLabel(element.node) : "";
  const stringKeys = Object.keys(properties);

  return (
    <aside className={styles.inspector} aria-label="Selected element">
      <div className={styles.inspectorHead}>
        {element.kind === "node" ? (
          element.node.labels.length === 0 ? (
            <span
              className={`${styles.label} ${styles.labelSmall}`}
              style={{ background: cssOfLabel("") }}
            >
              No label
            </span>
          ) : (
            element.node.labels.slice(0, 2).map((l) => (
              <span
                key={l}
                className={`${styles.label} ${styles.labelSmall}`}
                style={{ background: cssOfLabel(l) }}
              >
                {l}
              </span>
            ))
          )
        ) : (
          <span className={styles.type}>{element.rel.relType}</span>
        )}
        <span className={styles.elementId} title={item.elementId}>
          {`<id> ${item.elementId}`}
        </span>
        <div className={styles.grow} />
        <IconButton aria-label="Close inspector" onClick={props.onClose}>
          <Close size={14} />
        </IconButton>
      </div>
      <div className={styles.inspectorBody}>
        <dl className={styles.props} aria-label="Properties">
          {element.kind === "relationship" ? (
            <>
              <dt>from</dt>
              <dd title={element.rel.startId}>{element.rel.startId}</dd>
              <dt>to</dt>
              <dd title={element.rel.endId}>{element.rel.endId}</dd>
            </>
          ) : null}
          {stringKeys.length === 0 ? <dd className={styles.sideNote}>No properties</dd> : null}
          {stringKeys.map((key) => (
            <PropertyRow
              key={key}
              name={key}
              value={properties[key]}
              draft={editing ? editing[key] : undefined}
              onDraft={(text) => setEditing((cur) => (cur ? { ...cur, [key]: text } : cur))}
              onEnter={() => void save()}
              onEscape={() => setEditing(null)}
            />
          ))}
        </dl>

        {element.kind === "node" ? (
          <div>
            <div className={styles.sectionHead} style={{ padding: "0 0 8px" }}>
              Relationships
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {props.neighbours === undefined ? (
                <span className={styles.sideNote}>Counting…</span>
              ) : props.neighbours.length === 0 ? (
                <span className={styles.sideNote}>None</span>
              ) : (
                props.neighbours.map((n) => (
                  <div key={`${n.outgoing}:${n.type}`} className={styles.relRow}>
                    <span className={styles.type}>{`${n.outgoing ? "→" : "←"} ${n.type}`}</span>
                    <span>{n.count.toLocaleString()}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        {element.kind === "node" && stringKeys.length > 0 && label ? (
          <label className={styles.captionPick}>
            Caption
            <Select
              aria-label={`Caption of ${label} nodes`}
              value={props.captions[label] ?? ""}
              onChange={(e) => props.onCaption(label, e.target.value || undefined)}
            >
              <option value="">Automatic</option>
              {stringKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        {props.error ? (
          <div role="alert" className={styles.actionError}>
            {props.error}
          </div>
        ) : null}

        <div className={styles.actions}>
          {editing ? (
            <>
              <Button variant="primary" disabled={saving} onClick={() => void save()}>
                Save properties
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {element.kind === "node" ? (
                <>
                  <Button
                    variant="toolbar"
                    disabled={props.expanding}
                    onClick={() => props.onExpand(item.elementId)}
                  >
                    Expand neighbours
                  </Button>
                  <Button variant="ghost" onClick={() => props.onHide(item.elementId)}>
                    Hide node
                  </Button>
                </>
              ) : null}
              <Button variant="ghost" onClick={() => props.onCopy(item)}>
                Copy as Cypher MATCH
              </Button>
              {props.writable ? (
                <Button variant="ghost" onClick={startEdit}>
                  Edit properties
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function PropertyRow(p: {
  name: string;
  value: GraphNode["properties"][string];
  draft: string | undefined;
  onDraft: (text: string) => void;
  onEnter: () => void;
  onEscape: () => void;
}) {
  return (
    <>
      <dt>{p.name}</dt>
      <dd
        style={p.draft === undefined ? propertyStyle(p.value) : undefined}
        title={propertyText(p.value)}
      >
        {p.draft === undefined ? (
          propertyText(p.value)
        ) : (
          <input
            aria-label={`Value of ${p.name}`}
            value={p.draft}
            spellCheck={false}
            onChange={(e) => p.onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                p.onEnter();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                p.onEscape();
              }
            }}
          />
        )}
      </dd>
    </>
  );
}
