import { useMemo } from "react";
import { Button } from "../../components/Button";
import { cellSummary, recordsAsJson } from "./graphModel";
import type { CaptionChoices } from "./graphModel";
import { maxDbHits } from "./planModel";
import type { GraphResult, GraphValue, PlanNode } from "./types";
import styles from "./Graph.module.css";

export interface TableViewProps {
  result: GraphResult;
  captions: CaptionChoices;
  loadingMore: boolean;
  /** A node or relationship cell was activated: open it in the inspector. */
  onInspect: (kind: "node" | "relationship", id: string) => void;
  onLoadMore: () => void;
}

/** One row per record, one column per returned variable (spec: graph-browser › Table view). */
export function TableView({
  result,
  captions,
  loadingMore,
  onInspect,
  onLoadMore,
}: TableViewProps) {
  if (result.columns.length === 0) {
    return <div className={styles.empty}>The query returned no columns.</div>;
  }
  return (
    <div className={styles.scroll}>
      <table className={styles.table} aria-label="Result table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.records.map((row, r) => (
            <tr key={r}>
              {result.columns.map((c, i) => (
                <td key={c} title={cellSummary(row[i] ?? { kind: "null" }, captions)}>
                  <Cell value={row[i]} captions={captions} onInspect={onInspect} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.records.length === 0 ? <div className={styles.empty}>No records.</div> : null}
      {result.hasMore ? (
        <div className={styles.more}>
          <Button variant="toolbar" disabled={loadingMore} onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Cell({
  value,
  captions,
  onInspect,
}: {
  value: GraphValue | undefined;
  captions: CaptionChoices;
  onInspect: (kind: "node" | "relationship", id: string) => void;
}) {
  if (!value) return <span style={{ color: "var(--syn-null)", fontStyle: "italic" }}>null</span>;
  const text = cellSummary(value, captions);
  if (value.kind === "node" || value.kind === "relationship") {
    return (
      <button
        type="button"
        className={styles.cellLink}
        onClick={() => onInspect(value.kind as "node" | "relationship", value.elementId)}
      >
        {text}
      </button>
    );
  }
  if (value.kind === "null") {
    return <span style={{ color: "var(--syn-null)", fontStyle: "italic" }}>NULL</span>;
  }
  return <>{text}</>;
}

/** The records as JSON. */
export function JsonView({ result }: { result: GraphResult }) {
  const text = useMemo(() => JSON.stringify(recordsAsJson(result), null, 2), [result]);
  return (
    <div className={styles.scroll}>
      <pre className={styles.json} aria-label="Result JSON">
        {text}
      </pre>
    </div>
  );
}

/** The EXPLAIN / PROFILE operator tree (spec: graph-browser › Table, JSON and Plan views). */
export function PlanView({ plan, profiled }: { plan: PlanNode | undefined; profiled: boolean }) {
  if (!plan) {
    return (
      <div className={styles.empty}>
        No plan yet. Use Profile to run the query and see db hits per operator.
      </div>
    );
  }
  const hot = maxDbHits(plan);
  return (
    <div className={styles.scroll}>
      <ul className={styles.plan} role="tree" aria-label="Query plan">
        <PlanItem node={plan} hot={profiled ? hot : 0} profiled={profiled} />
      </ul>
    </div>
  );
}

function PlanItem({ node, hot, profiled }: { node: PlanNode; hot: number; profiled: boolean }) {
  const isHot = hot > 0 && node.dbHits === hot;
  return (
    <li role="treeitem" aria-expanded={node.children.length > 0 ? true : undefined}>
      <div className={styles.planNode} data-hot={isHot} data-testid="plan-operator">
        <span className={styles.planOp}>{node.operator}</span>
        {node.details ? <span className={styles.planDetails}>{node.details}</span> : null}
        <span className={styles.planStat}>
          {node.estimatedRows !== undefined ? (
            <span>est. rows {formatRows(node.estimatedRows)}</span>
          ) : null}
          {profiled && node.rows !== undefined ? (
            <span>rows {node.rows.toLocaleString()}</span>
          ) : null}
          {profiled && node.dbHits !== undefined ? (
            <span>db hits {node.dbHits.toLocaleString()}</span>
          ) : null}
        </span>
      </div>
      {node.children.length > 0 ? (
        <ul role="group">
          {node.children.map((c, i) => (
            <PlanItem key={i} node={c} hot={hot} profiled={profiled} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const formatRows = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));
