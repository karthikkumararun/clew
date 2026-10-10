import { ResultTable } from "./ResultTable";
import type { ExplainState } from "./runtime";
import type { PlanNode } from "./explain";
import styles from "./Console.module.css";

const count = (n: number) => n.toLocaleString();

function NodeRow({ node, depth }: { node: PlanNode; depth: number }) {
  return (
    <li role="none">
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={false}
        className={styles.planNode}
        style={{ paddingLeft: 12 + depth * 18 }}
      >
        <span className={styles.planType}>{node.type}</span>
        {node.relation ? <span className={styles.planRelation}>on {node.relation}</span> : null}
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
            <NodeRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The Explain plan tab: an indented tree with node type, relation, estimated rows and cost. */
export function ExplainPane({ explain }: { explain: ExplainState | null }) {
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
        </div>
        <ul role="tree" aria-label="Execution plan" className={styles.planList}>
          {explain.plan.nodes.map((n) => (
            <NodeRow key={n.id} node={n} depth={0} />
          ))}
        </ul>
      </div>
    );
  }
  if (explain.raw) {
    return (
      <ResultTable
        columns={explain.raw.columns}
        rows={explain.raw.rows}
        hasMore={false}
        fetching={false}
        onNearEnd={() => {}}
      />
    );
  }
  return null;
}
