import type { ColumnMeta, Value, ValueKind } from "../../lib/ipc/drivers";
import { describe, summary } from "./ejson";
import type { EJson } from "./ejson";

/** The grid Value a document field shows as. */
export function toGridValue(v: EJson | undefined): Value {
  if (v === undefined || v === null) return { kind: "null" };
  const d = describe(v);
  switch (d.type) {
    case "String":
      return { kind: "text", value: d.text };
    case "Boolean":
      return { kind: "bool", value: v as boolean };
    case "Int32":
      return { kind: "int", value: Number(d.display) };
    case "Int64": {
      const n = Number(d.display);
      return Number.isSafeInteger(n)
        ? { kind: "int", value: n }
        : { kind: "bigint", value: d.display };
    }
    case "Double":
      return { kind: "float", value: Number(d.display) };
    case "Decimal128":
      return { kind: "decimal", value: d.text };
    case "Date":
      return { kind: "timestamptz", value: d.display };
    case "ObjectId":
    case "UUID":
      return { kind: "text", value: d.text };
    case "Document":
    case "Array":
      return { kind: "text", value: summary(v, 200) };
    default:
      return { kind: "text", value: d.display };
  }
}

const KIND_OF: Record<string, ValueKind> = {
  String: "text",
  Boolean: "bool",
  Int32: "int",
  Int64: "int",
  Double: "float",
  Decimal128: "decimal",
  Date: "timestamptz",
  ObjectId: "text",
  UUID: "text",
};

/** Columns (the union of top-level keys, `_id` first) and one row of grid values per document. */
export function docsToTable(docs: EJson[]): { columns: ColumnMeta[]; rows: Value[][] } {
  const order: string[] = [];
  const seen = new Set<string>();
  const types = new Map<string, Set<string>>();
  for (const doc of docs) {
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) continue;
    for (const [k, v] of Object.entries(doc)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
      const set = types.get(k) ?? new Set();
      set.add(describe(v).type);
      types.set(k, set);
    }
  }
  if (seen.has("_id")) {
    order.splice(order.indexOf("_id"), 1);
    order.unshift("_id");
  }
  const columns: ColumnMeta[] = order.map((name) => {
    const t = [...(types.get(name) ?? [])];
    const single = t.length === 1 ? t[0] : null;
    return {
      name,
      type_name: single ?? (t.length > 1 ? "mixed" : "null"),
      kind: (single && KIND_OF[single]) || "text",
      nullable: true,
    };
  });
  const rows = docs.map((doc) =>
    order.map((k) => toGridValue((doc as { [key: string]: EJson })[k])),
  );
  return { columns, rows };
}
