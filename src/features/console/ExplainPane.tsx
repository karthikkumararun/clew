import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { ResultGrid } from "../grid/ResultGrid";
import { sourceOf } from "../grid/source";
import type { ExplainState } from "./runtime";
import { costShares, nodeFields } from "./explain";
import type { PlanNode } from "./explain";
import styles from "./Console.module.css";

const count = (n: number) => n.toLocaleString();

interface RowProps {
  node: PlanNode;
  depth: number;
  shares: Map<string, number>;
  selected: string | null;
  onSelect: (id: string) => void;
}

function NodeRow({ node, depth, shares, selected, onSelect }: RowProps) {
  const share = shares.get(node.id);
  return (
    <li role="none">
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected === node.id}
        tabIndex={0}
        className={styles.planNode}
        data-selected={selected === node.id}
        style={{ paddingLeft: 12 + depth * 18 }}
        onClick={() => onSelect(node.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node.id);
          }
        }}
      >
        <span className={styles.planType}>{node.type}</span>
        {node.relation ? <span className={styles.planRelation}>on {node.relation}</span> : null}
        {share !== undefined ? (
          <span
            className={styles.costBar}
            role="img"
            aria-label={`${Math.round(share * 100)}% of the total cost`}
            title={`${Math.round(share * 100)}% of the total cost`}
          >
            <span style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
          </span>
        ) : null}
        <span className={styles.planStats}>
          {node.estRows !== undefined ? <span>rows ≈ {count(node.estRows)}</span> : null}
          {node.cost ? <span>cost {node.cost}</span> : null}
          {node.actualRows !== undefined ? <span>actual {count(node.actualRows)} rows</span> : null}
          {node.actualMs !== undefined ? <span>{node.actualMs} ms</span> : null}
        </span>
      </div>
      {node.details.map((d) => (
        <div key={d} className={styles.planDetail} style={{ paddingLeft: 12 + (depth + 1) * 18 }}>
          {d}
        </div>
      ))}
      {node.children.length > 0 ? (
        <ul role="group" className={styles.planList}>
          {node.children.map((c) => (
            <NodeRow
              key={c.id}
              node={c}
              depth={depth + 1}
              shares={shares}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function findNode(nodes: PlanNode[], id: string | null): PlanNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = findNode(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}

/** The Explain plan tab: an indented tree with node type, relation, estimated rows and cost. */
export function ExplainPane({
  explain,
  onExplainWithAi,
}: {
  explain: ExplainState | null;
  /** Offered only when an AI provider is configured; attaches the plan to a question. */
  onExplainWithAi?: (explain: ExplainState) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shares = useMemo(() => costShares(explain?.plan?.nodes ?? []), [explain?.plan]);
  const node = findNode(explain?.plan?.nodes ?? [], selected);
  if (!explain) {
    return <p className={styles.emptyPane}>Explain a statement to see its plan.</p>;
  }
  if (explain.status === "running") {
    return <p className={styles.emptyPane}>Planning…</p>;
  }
  if (explain.status === "failed") {
    return (
      <p className={styles.emptyPane} role="alert">
        {explain.error ?? "Couldn't explain the statement."}
      </p>
    );
  }
  if (explain.plan) {
    return (
      <div className={styles.plan}>
        <div className={styles.planHead}>
          <strong>{explain.analyze ? "Explain Analyze" : "Explain"}</strong>
          {explain.plan.summary.map((s) => (
            <span key={s}>{s}</span>
          ))}
          <span className={styles.grow} />
          {explain.original ? (
            <Button
              variant="toolbar"
              onClick={() => {
                void navigator.clipboard
                  .writeText(explain.original!.text)
                  .then(() => setCopied(true));
              }}
            >
              Copy original plan
            </Button>
          ) : null}
          {copied ? (
            <span role="status" className={styles.planCopied}>
              Copied
            </span>
          ) : null}
          {onExplainWithAi ? (
            <Button variant="toolbar" onClick={() => onExplainWithAi(explain)}>
              Explain with AI
            </Button>
          ) : null}
        </div>
        <div className={styles.planBody}>
          <ul role="tree" aria-label="Execution plan" className={styles.planList}>
            {explain.plan.nodes.map((n) => (
              <NodeRow
                key={n.id}
                node={n}
                depth={0}
                shares={shares}
                selected={selected}
                onSelect={setSelected}
              />
            ))}
          </ul>
          {node ? (
            <aside className={styles.planDetails} aria-label="Node details">
              <h3>{node.type}</h3>
              <dl>
                {nodeFields(node).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          ) : null}
        </div>
      </div>
    );
  }
  if (explain.raw) {
    return <ResultGrid source={sourceOf(explain.raw.columns, explain.raw.rows)} driver="" />;
  }
  return null;
}
