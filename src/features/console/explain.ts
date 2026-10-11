/**
 * Execution plans: the statement to send for each driver, and parsers that turn the answer into
 * a tree of nodes (node type, relation, estimated rows, cost; actuals for ANALYZE).
 */
import type { Value } from "../../lib/ipc/drivers";
import { valueText } from "./valueFormat";

export interface PlanNode {
  id: string;
  /** `Seq Scan`, `Index Scan`, `Nested Loop`, `SCAN`, … */
  type: string;
  /** Table (or alias) the node reads. */
  relation?: string;
  estRows?: number;
  /** `0.00..35.50` or a single number. */
  cost?: string;
  actualRows?: number;
  actualMs?: number;
  /** `Filter: (total > 100)`, `Index: orders_pkey`, … */
  details: string[];
  children: PlanNode[];
}

export interface Plan {
  nodes: PlanNode[];
  /** `Planning time: 0.2 ms`, `Execution time: 3.1 ms`. */
  summary: string[];
  analyze: boolean;
}

const WRITE_WORDS = /\b(insert|update|delete|merge|replace|upsert)\b/i;
const WRITE_FIRST =
  /^(insert|update|delete|merge|replace|upsert|create|alter|drop|truncate|rename|grant|revoke|call|do|copy|vacuum|reindex|cluster|refresh|comment|lock)\b/i;

/** Remove comments and leading whitespace so the first word is the statement's verb. */
function stripLeading(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--") || t.startsWith("#")) {
      const nl = t.indexOf("\n");
      s = nl < 0 ? "" : t.slice(nl + 1);
    } else if (t.startsWith("/*")) {
      const end = t.indexOf("*/");
      s = end < 0 ? "" : t.slice(end + 2);
    } else {
      return t;
    }
  }
}

/** Whether running the statement may change data or schema. */
export function isWrite(sql: string): boolean {
  const s = stripLeading(sql);
  if (/^with\b/i.test(s)) return WRITE_WORDS.test(s);
  return WRITE_FIRST.test(s);
}

export class ExplainUnsupported extends Error {}

/** The statement that asks the server for the plan. */
export function explainStatement(driver: string, sql: string, analyze: boolean): string {
  switch (driver) {
    case "postgres":
      return `EXPLAIN (${analyze ? "ANALYZE, " : ""}FORMAT JSON) ${sql}`;
    case "sqlite":
      if (analyze) throw new ExplainUnsupported("SQLite can't run EXPLAIN ANALYZE");
      return `EXPLAIN QUERY PLAN ${sql}`;
    case "mysql":
      return analyze ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN FORMAT=JSON ${sql}`;
    case "mariadb":
      return analyze ? `ANALYZE FORMAT=JSON ${sql}` : `EXPLAIN FORMAT=JSON ${sql}`;
    case "duckdb":
      return `EXPLAIN${analyze ? " ANALYZE" : ""} ${sql}`;
    case "mongodb":
    case "redis":
      throw new ExplainUnsupported(
        "Use Explain in the collection's query bar; the command console has no execution plans",
      );
    case "sqlserver":
    case "oracle":
      throw new ExplainUnsupported("Execution plans for this database aren't available yet");
    default:
      if (analyze) throw new ExplainUnsupported("This database can't run EXPLAIN ANALYZE here");
      return `EXPLAIN ${sql}`;
  }
}

let nextId = 0;
const newId = () => `p${nextId++}`;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: unknown): v is { [k: string]: Json } =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The first cell of the first row, as parsed JSON when it holds a document. */
function firstJson(rows: Value[][]): Json | undefined {
  const cell = rows[0]?.[0];
  if (!cell) return undefined;
  if (cell.kind === "json") return cell.value as Json;
  const text = valueText(cell);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

// ---- PostgreSQL ------------------------------------------------------------------------------

function pgNode(p: { [k: string]: Json }): PlanNode {
  const details: string[] = [];
  const add = (label: string, key: string) => {
    const v = str(p[key]);
    if (v) details.push(`${label}: ${v}`);
  };
  add("Index", "Index Name");
  add("Index cond", "Index Cond");
  add("Filter", "Filter");
  add("Join filter", "Join Filter");
  add("Hash cond", "Hash Cond");
  add("Merge cond", "Merge Cond");
  add("Recheck", "Recheck Cond");
  add("Sort key", "Sort Key");
  if (Array.isArray(p["Sort Key"])) {
    details.splice(
      details.findIndex((d) => d.startsWith("Sort key")),
      1,
    );
    details.push(`Sort key: ${(p["Sort Key"] as string[]).join(", ")}`);
  }
  add("Group key", "Group Key");
  const join = str(p["Join Type"]);
  const rel = str(p["Relation Name"]);
  const alias = str(p["Alias"]);
  const start = num(p["Startup Cost"]);
  const total = num(p["Total Cost"]);
  const removed = num(p["Rows Removed by Filter"]);
  if (removed !== undefined) details.push(`Rows removed by filter: ${removed.toLocaleString()}`);
  const plans = Array.isArray(p["Plans"]) ? p["Plans"] : [];
  return {
    id: newId(),
    type: `${str(p["Node Type"]) ?? "Node"}${join ? ` (${join})` : ""}`,
    relation: rel ? (alias && alias !== rel ? `${rel} ${alias}` : rel) : undefined,
    estRows: num(p["Plan Rows"]),
    cost:
      start !== undefined && total !== undefined
        ? `${start.toFixed(2)}..${total.toFixed(2)}`
        : undefined,
    actualRows: num(p["Actual Rows"]),
    actualMs: num(p["Actual Total Time"]),
    details,
    children: plans.filter(isObj).map(pgNode),
  };
}

function parsePostgres(rows: Value[][], analyze: boolean): Plan | null {
  const doc = firstJson(rows);
  const top = Array.isArray(doc) ? doc[0] : doc;
  if (!isObj(top) || !isObj(top["Plan"])) return null;
  const summary: string[] = [];
  const planning = num(top["Planning Time"]);
  const execution = num(top["Execution Time"]);
  if (planning !== undefined) summary.push(`Planning time: ${planning} ms`);
  if (execution !== undefined) summary.push(`Execution time: ${execution} ms`);
  return { nodes: [pgNode(top["Plan"])], summary, analyze };
}

// ---- SQLite ----------------------------------------------------------------------------------

function parseSqlite(rows: Value[][]): Plan | null {
  const items = rows.map((r) => ({
    id: Number(valueText(r[0])),
    parent: Number(valueText(r[1])),
    detail: valueText(r[3]) ?? "",
  }));
  if (items.length === 0 || items.some((i) => Number.isNaN(i.id) || Number.isNaN(i.parent)))
    return null;
  const byId = new Map<number, PlanNode>();
  const roots: PlanNode[] = [];
  for (const it of items) {
    const m = /^(\S+)\s+(?:TABLE\s+)?(\S+)?(?:\s+(.*))?$/.exec(it.detail);
    const verb = m?.[1] ?? it.detail;
    const scan = verb === "SCAN" || verb === "SEARCH";
    const node: PlanNode = {
      id: newId(),
      type: scan ? verb : it.detail,
      relation: scan ? m?.[2] : undefined,
      details: scan && m?.[3] ? [m[3]] : [],
      children: [],
    };
    byId.set(it.id, node);
    (byId.get(it.parent)?.children ?? roots).push(node);
  }
  return { nodes: roots, summary: [], analyze: false };
}

// ---- MySQL / MariaDB -------------------------------------------------------------------------

const KNOWN = [
  "query_block",
  "ordering_operation",
  "grouping_operation",
  "duplicates_removal",
  "nested_loop",
  "union_result",
  "materialized_from_subquery",
  "windowing",
  "buffer_result",
];

const humanize = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function myTable(t: { [k: string]: Json }): PlanNode {
  const cost = isObj(t["cost_info"])
    ? (str(t["cost_info"]["prefix_cost"]) ?? str(t["cost_info"]["read_cost"]))
    : undefined;
  const details: string[] = [];
  const key = str(t["key"]);
  if (key) details.push(`Index: ${key}`);
  const cond = str(t["attached_condition"]);
  if (cond) details.push(`Filter: ${cond}`);
  const using = Array.isArray(t["using_index"])
    ? ""
    : t["using_index"] === true
      ? "covering index"
      : "";
  if (using) details.push(`Using ${using}`);
  const inner = Object.entries(t).flatMap(([k, v]) => (KNOWN.includes(k) ? walkMy(k, v) : []));
  return {
    id: newId(),
    type: str(t["access_type"]) ?? "table",
    relation: str(t["table_name"]),
    estRows: num(t["rows_examined_per_scan"]) ?? num(t["rows"]),
    cost,
    actualRows: num(t["r_rows"]),
    actualMs: num(t["r_total_time_ms"]),
    details,
    children: inner,
  };
}

function walkMy(key: string, value: Json): PlanNode[] {
  if (Array.isArray(value)) {
    if (!KNOWN.includes(key)) return value.flatMap((v) => walkMy(key, v));
    // `nested_loop: [{table}, {table}]` is one node holding both tables.
    const kids = value.flatMap((v) =>
      isObj(v) ? Object.entries(v).flatMap(([k, x]) => walkMy(k, x)) : [],
    );
    return [{ id: newId(), type: humanize(key), details: [], children: kids }];
  }
  if (!isObj(value)) return [];
  if (key === "table") return [myTable(value)];
  const kids = Object.entries(value).flatMap(([k, v]) => walkMy(k, v));
  if (!KNOWN.includes(key)) return kids;
  const cost = isObj(value["cost_info"]) ? str(value["cost_info"]["query_cost"]) : undefined;
  return [{ id: newId(), type: humanize(key), cost, details: [], children: kids }];
}

function parseMysqlJson(rows: Value[][], analyze: boolean): Plan | null {
  const doc = firstJson(rows);
  if (!isObj(doc)) return null;
  const nodes = Object.entries(doc).flatMap(([k, v]) => walkMy(k, v));
  return nodes.length ? { nodes, summary: [], analyze } : null;
}

/** `EXPLAIN ANALYZE` in MySQL prints an indented tree: `-> Filter: (…)  (cost=… rows=…) (actual time=… rows=…)`. */
function parseMysqlTree(rows: Value[][]): Plan | null {
  const text = rows.map((r) => valueText(r[0]) ?? "").join("\n");
  const lines = text.split("\n").filter((l) => l.includes("->"));
  if (lines.length === 0) return null;
  const roots: PlanNode[] = [];
  const stack: { depth: number; node: PlanNode }[] = [];
  for (const line of lines) {
    const depth = line.indexOf("->");
    const body = line.slice(depth + 2).trim();
    const est = /\(cost=([\d.]+)[^)]*rows=([\d.]+)\)/.exec(body);
    const act = /\(actual time=[\d.]+\.\.([\d.]+) rows=([\d.]+)/.exec(body);
    const head = body.replace(/\s*\(cost=.*$/, "").replace(/\s*\(actual time=.*$/, "");
    const on = /^(.*?)\s+on\s+(\S+)/i.exec(head);
    const node: PlanNode = {
      id: newId(),
      type: on ? on[1] : head,
      relation: on?.[2],
      estRows: est ? Number(est[2]) : undefined,
      cost: est?.[1],
      actualRows: act ? Number(act[2]) : undefined,
      actualMs: act ? Number(act[1]) : undefined,
      details: [],
      children: [],
    };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ depth, node });
  }
  return { nodes: roots, summary: [], analyze: true };
}

/**
 * Turn the rows an EXPLAIN statement returned into a tree. Returns null when the shape isn't
 * recognised, in which case the caller shows the raw rows.
 */
export function parsePlan(driver: string, rows: Value[][], analyze: boolean): Plan | null {
  try {
    switch (driver) {
      case "postgres":
        return parsePostgres(rows, analyze);
      case "sqlite":
        return parseSqlite(rows);
      case "mysql":
        return analyze ? parseMysqlTree(rows) : parseMysqlJson(rows, false);
      case "mariadb":
        return parseMysqlJson(rows, analyze);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
