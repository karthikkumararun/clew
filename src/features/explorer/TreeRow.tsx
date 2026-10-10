import type { CSSProperties, DragEvent, MouseEvent, ReactNode } from "react";
import { DriverBadge, EnvDot } from "../../components/Badge";
import { Button } from "../../components/Button";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  Key,
  Link,
  Table,
} from "../../components/icons";
import { BADGE_ENV, badgeDriver, shortAddress } from "../../connections/display";
import { formatCount } from "./names";
import type { Match, Row } from "./tree";
import styles from "./ExplorerPanel.module.css";

/** Left padding by depth: group headers at 8px, connections at 20px, then 18px per level. */
export function indentFor(depth: number): number {
  return depth <= 0 ? 8 : 20 + (depth - 1) * 18;
}

export function depthOf(row: Row, shift: number): number {
  switch (row.type) {
    case "group":
      return 0;
    case "connection":
      return 1 - shift;
    case "node":
    case "error":
    case "more":
      return row.level + 1 - shift;
  }
}

/** Wrap the matched part of `text` in a highlight. */
function Highlight({ text, match }: { text: string; match: Match | null }) {
  if (!match) return <>{text}</>;
  return (
    <>
      {text.slice(0, match[0])}
      <mark className={styles.mark}>{text.slice(match[0], match[1])}</mark>
      {text.slice(match[1])}
    </>
  );
}

function Chevron({ show, open }: { show: boolean; open: boolean }) {
  return (
    <span className={styles.chev} aria-hidden="true">
      {show ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
    </span>
  );
}

function Spinner() {
  return <span className={styles.spinner} role="img" aria-label="Loading" />;
}

function ColumnIcon({ pk, fk }: { pk: boolean; fk: boolean }) {
  if (pk) return <Key size={12} className={styles.keyIcon} />;
  if (fk) return <Link size={12} className={styles.fkIcon} />;
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
      className={styles.plainIcon}
    >
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </svg>
  );
}

function hostHint(row: Extract<Row, { type: "connection" }>): string {
  if (!row.connected) return "disconnected";
  const s = row.conn.settings;
  return s.kind === "network" || s.kind === "oracle" || s.kind === "keyvalue" || s.kind === "neo4j"
    ? s.host
    : shortAddress(row.conn);
}

export interface TreeRowProps {
  row: Row;
  index: number;
  depth: number;
  selected: boolean;
  style: CSSProperties;
  /** Exact count that replaces a table's estimate. */
  exactCount?: number;
  dropTarget?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onActivate: () => void;
  onMenu: (x: number, y: number) => void;
  onRetry?: () => void;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}

export function TreeRow(p: TreeRowProps) {
  const { row } = p;
  const pad = indentFor(p.depth);
  const common = {
    id: `ex-row-${p.index}`,
    className: styles.row,
    style: { ...p.style, paddingLeft: pad },
    "aria-level": p.depth + 1,
    "aria-selected": p.selected,
    "data-index": p.index,
    "data-drop": p.dropTarget || undefined,
    onClick: p.onSelect,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      p.onSelect();
      p.onMenu(e.clientX, e.clientY);
    },
    onDragOver: p.onDragOver,
    onDragLeave: p.onDragLeave,
    onDrop: p.onDrop,
  } as const;

  if (row.type === "group") {
    return (
      <div
        {...common}
        role="treeitem"
        aria-expanded={!row.collapsed}
        className={`${styles.row} ${styles.groupRow}`}
        onClick={p.onToggle}
      >
        <Chevron show open={!row.collapsed} />
        <span className={styles.label}>{row.label}</span>
      </div>
    );
  }

  if (row.type === "more") {
    return (
      <div
        {...common}
        role="none"
        aria-selected={undefined}
        className={`${styles.row} ${styles.moreRow}`}
        onClick={undefined}
      >
        <span className={styles.chev} />
        <span>{row.hidden.toLocaleString()} more not shown — type in the filter to narrow</span>
      </div>
    );
  }

  if (row.type === "error") {
    return (
      <div
        {...common}
        role="treeitem"
        aria-selected={false}
        className={`${styles.row} ${styles.errorRow}`}
        onClick={undefined}
      >
        <span className={styles.chev} />
        <span className={styles.errorText} role="alert" title={row.message}>
          {row.message}
        </span>
        <Button variant="default" onClick={p.onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  let content: ReactNode;
  let detail: ReactNode;
  let expandable: boolean;
  let expanded: boolean;
  let loading: boolean;
  let strong = false;

  if (row.type === "connection") {
    expandable = true;
    expanded = row.expanded;
    loading = row.loading;
    strong = true;
    content = (
      <>
        <DriverBadge driver={badgeDriver(row.conn.driver)} />
        <span className={styles.label}>
          <Highlight text={row.conn.name} match={row.match} />
        </span>
        <EnvDot env={BADGE_ENV[row.conn.environment]} />
        {row.connected ? <span className={styles.live} role="img" aria-label="Connected" /> : null}
      </>
    );
    detail = hostHint(row);
  } else {
    const e = row.entry;
    expanded = row.expanded;
    loading = row.loading;
    expandable = e.hasChildren;
    const isTable = e.kind === "table" || e.kind === "view" || e.kind === "materialized_view";
    const icon =
      e.kind === "database" ? (
        <Database size={13} className={styles.plainIcon} />
      ) : e.kind === "schema" ? (
        <Folder size={13} className={styles.plainIcon} />
      ) : isTable ? (
        <Table size={13} className={styles.tableIcon} />
      ) : e.kind === "column" ? (
        <ColumnIcon pk={!!e.column?.primary_key} fk={!!e.column?.foreign_key} />
      ) : null;
    content = (
      <>
        {icon}
        <span className={styles.label}>
          <Highlight text={e.name} match={row.match} />
        </span>
      </>
    );
    const count = isTable && p.exactCount !== undefined ? p.exactCount : undefined;
    detail =
      count !== undefined ? (
        <span title={`${count.toLocaleString()} rows · exact`}>{formatCount(count)}</span>
      ) : isTable && e.detail ? (
        <span title={`≈${e.detail} rows · from statistics`}>{e.detail}</span>
      ) : e.kind === "column" ? (
        (e.detail ?? e.column?.type_name)
      ) : (
        (e.detail ?? null)
      );
  }

  return (
    <div
      {...common}
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      aria-busy={loading || undefined}
      draggable={row.type === "connection"}
      onDragStart={p.onDragStart}
      onDoubleClick={p.onActivate}
      data-strong={strong || undefined}
    >
      <span
        onClick={(e) => {
          e.stopPropagation();
          p.onSelect();
          if (expandable) p.onToggle();
        }}
      >
        <Chevron show={expandable} open={expanded} />
      </span>
      {content}
      {loading ? <Spinner /> : null}
      {detail ? <span className={styles.detail}>{detail}</span> : null}
    </div>
  );
}
