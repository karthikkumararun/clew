/**
 * Schema-aware completion, independent of CodeMirror: given the text around the cursor and the
 * connection's schema snapshot, work out what to offer. Aliases are found by scanning the current
 * statement's FROM / JOIN / UPDATE / INTO clauses.
 */
import type { SchemaSnapshot, SnapshotSchema, SnapshotTable } from "../../../lib/ipc/drivers";
import { BUILTINS, BUILTINS_BY_DRIVER } from "./builtins";

export type SuggestionKind =
  "keyword" | "schema" | "table" | "view" | "column" | "function" | "aggregate";

export interface Suggestion {
  label: string;
  /** What gets inserted when it differs from the label (quoting). */
  insert?: string;
  kind: SuggestionKind;
  /** Dim text right after the label, e.g. a function signature. */
  signature?: string;
  /** Right-aligned text: a column type or the kind. */
  right?: string;
  /** Higher sorts first. */
  boost: number;
}

export interface TableRef {
  alias: string;
  schema?: string;
  table: string;
}

export interface CompletionInput {
  /** The text of the current statement up to the cursor. */
  before: string;
  /** The rest of the current statement after the cursor. */
  after: string;
  snapshot: SchemaSnapshot | null;
  driver: string;
  /** Schema searched first for unqualified table names (`public`, `main`, the database name). */
  defaultSchema?: string;
  keywords: string[];
}

const NOT_ALIASES = new Set(
  [
    "where",
    "on",
    "join",
    "inner",
    "left",
    "right",
    "full",
    "cross",
    "natural",
    "outer",
    "group",
    "order",
    "limit",
    "offset",
    "having",
    "union",
    "intersect",
    "except",
    "using",
    "set",
    "values",
    "select",
    "from",
    "returning",
    "window",
    "fetch",
    "for",
    "lateral",
    "straight_join",
  ].map((k) => k.toLowerCase()),
);

const IDENT = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2}`;

const unquote = (s: string) => s.replace(/^["`[]|["`\]]$/g, "");

/** Tables referenced in FROM / JOIN / UPDATE / INTO clauses, with their aliases. */
export function tableRefs(statement: string): TableRef[] {
  const refs: TableRef[] = [];
  const clause = new RegExp(
    String.raw`\b(from|join|update|into)\s+((?:${QUALIFIED})(?:\s+(?:as\s+)?${IDENT})?(?:\s*,\s*(?:${QUALIFIED})(?:\s+(?:as\s+)?${IDENT})?)*)`,
    "gi",
  );
  const one = new RegExp(String.raw`^(${QUALIFIED})(?:\s+(?:as\s+)?(${IDENT}))?$`, "i");
  for (const m of statement.matchAll(clause)) {
    // A FROM clause may list several tables: split on commas outside parentheses.
    for (const part of m[2].split(/\s*,\s*/)) {
      const t = one.exec(part.trim());
      if (!t) continue;
      const path = t[1].split(/\s*\.\s*/).map(unquote);
      let alias = t[2] ? unquote(t[2]) : undefined;
      if (alias && NOT_ALIASES.has(alias.toLowerCase())) alias = undefined;
      const table = path[path.length - 1];
      refs.push({
        alias: alias ?? table,
        table,
        schema: path.length > 1 ? path[path.length - 2] : undefined,
      });
    }
  }
  return refs;
}

const lc = (s: string) => s.toLowerCase();

function findTable(
  snapshot: SchemaSnapshot,
  ref: { schema?: string; table: string },
  defaultSchema?: string,
): { schema: SnapshotSchema; table: SnapshotTable } | null {
  const schemas = ref.schema
    ? snapshot.schemas.filter((s) => lc(s.name) === lc(ref.schema as string))
    : [
        ...snapshot.schemas.filter((s) => lc(s.name) === lc(defaultSchema ?? "")),
        ...snapshot.schemas.filter((s) => lc(s.name) !== lc(defaultSchema ?? "")),
      ];
  for (const schema of schemas) {
    const table = schema.tables.find((t) => lc(t.name) === lc(ref.table));
    if (table) return { schema, table };
  }
  return null;
}

/** Quote an identifier when it isn't a plain word. */
export function quoteIfNeeded(name: string, driver: string): string | undefined {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return undefined;
  if (driver === "mysql" || driver === "mariadb" || driver === "clickhouse") {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  if (driver === "sqlserver") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

const KEYWORD_AFTER_TABLES = /\b(from|join|update|into|table)\s+[\w."`$[\]]*$/i;
const KEYWORD_AFTER_COLUMNS =
  /\b(select|where|on|by|having|and|or|set|distinct|when|then|else)\s+[\w."`$[\]]*$|[(,=<>+\-*/]\s*[\w."`$[\]]*$/i;

/** Suggestions for the cursor position. The editor filters them by the typed prefix. */
export function suggest(input: CompletionInput): Suggestion[] {
  const { before, snapshot, driver } = input;
  const out: Suggestion[] = [];
  const add = (s: Suggestion) => out.push(s);
  const refs = tableRefs(before + input.after);

  // `qualifier.` — columns of an alias or table, or the tables of a schema.
  const q = new RegExp(`(${IDENT})\\s*\\.\\s*[\\w$]*$`).exec(before);
  if (q) {
    const name = unquote(q[1]);
    if (!snapshot) return [];
    const ref = refs.find((r) => lc(r.alias) === lc(name));
    const hit = findTable(snapshot, ref ?? { table: name }, input.defaultSchema);
    if (hit) {
      for (const c of hit.table.columns) {
        add({
          label: c.name,
          insert: quoteIfNeeded(c.name, driver),
          kind: "column",
          right: c.type_name,
          boost: 10,
        });
      }
      return out;
    }
    const schema = snapshot.schemas.find((s) => lc(s.name) === lc(name));
    if (schema) {
      for (const t of schema.tables) {
        add({
          label: t.name,
          insert: quoteIfNeeded(t.name, driver),
          kind: t.kind === "view" || t.kind === "materialized_view" ? "view" : "table",
          right: t.kind === "table" ? "table" : "view",
          boost: 10,
        });
      }
      for (const f of schema.functions) {
        add({ label: f, kind: "function", signature: "(…)", right: "function", boost: 5 });
      }
    }
    return out;
  }

  const wantTables = KEYWORD_AFTER_TABLES.test(before);
  const wantColumns = !wantTables && KEYWORD_AFTER_COLUMNS.test(before);
  const tableBoost = wantTables ? 30 : 8;
  const columnBoost = wantColumns ? 30 : 12;

  if (snapshot) {
    // Columns of the tables the statement mentions; qualified when several tables are in scope.
    const seen = new Set<string>();
    const scoped = refs.filter((r) => {
      const key = `${lc(r.alias)}|${lc(r.table)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const r of scoped) {
      const hit = findTable(snapshot, r, input.defaultSchema);
      if (!hit) continue;
      for (const c of hit.table.columns) {
        const col = quoteIfNeeded(c.name, driver) ?? c.name;
        const qualified = scoped.length > 1;
        add({
          label: qualified ? `${r.alias}.${c.name}` : c.name,
          insert: qualified ? `${r.alias}.${col}` : quoteIfNeeded(c.name, driver),
          kind: "column",
          right: c.type_name,
          boost: columnBoost,
        });
      }
    }

    const def = lc(input.defaultSchema ?? "");
    for (const schema of snapshot.schemas) {
      const inDefault = lc(schema.name) === def || snapshot.schemas.length === 1;
      add({
        label: schema.name,
        insert: quoteIfNeeded(schema.name, driver),
        kind: "schema",
        right: "schema",
        boost: tableBoost - 4,
      });
      for (const t of schema.tables) {
        add({
          label: t.name,
          insert: quoteIfNeeded(t.name, driver),
          kind: t.kind === "view" || t.kind === "materialized_view" ? "view" : "table",
          right: t.kind === "table" ? "table" : "view",
          boost: inDefault ? tableBoost : tableBoost - 6,
        });
      }
      for (const f of schema.functions) {
        add({
          label: f,
          kind: "function",
          signature: "(…)",
          right: "function",
          boost: inDefault ? 6 : 2,
        });
      }
    }
  }

  if (!wantTables) {
    for (const b of [...BUILTINS, ...(BUILTINS_BY_DRIVER[driver] ?? [])]) {
      add({
        label: b.name,
        kind: b.kind === "aggregate" ? "aggregate" : "function",
        signature: b.signature,
        right: b.kind,
        boost: wantColumns ? 9 : 4,
      });
    }
  }
  for (const k of input.keywords) {
    add({ label: k, kind: "keyword", right: "keyword", boost: wantTables ? -10 : 0 });
  }
  return out;
}
