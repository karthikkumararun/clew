/** Contract: tiny builders shared by the tools tests. Not part of the shipped API. */
import type { ColumnMeta, Value, ValueKind } from "../../../lib/ipc/drivers";

export const col = (
  name: string,
  kind: ValueKind = "text",
  type_name: string = kind,
): ColumnMeta => ({
  name,
  type_name,
  kind,
  nullable: true,
});
export const int = (value: number): Value => ({ kind: "int", value });
export const dec = (value: string): Value => ({ kind: "decimal", value });
export const flt = (value: number): Value => ({ kind: "float", value });
export const text = (value: string): Value => ({ kind: "text", value });
export const NULL: Value = { kind: "null" };
