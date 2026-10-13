import type { CSSProperties } from "react";
import type { Value } from "../../lib/ipc/drivers";
import { valueColor, valueText } from "../console/valueFormat";

/** A property value as the inspector shows it: strings quoted, everything else as its text. */
export function propertyText(v: Value): string {
  if (v.kind === "text") return JSON.stringify(v.value);
  return valueText(v) ?? "null";
}

/** Colour of a typed value (spec: graph-browser › Inspector); strings use `--syn-string`. */
export function propertyStyle(v: Value): CSSProperties {
  if (v.kind === "text") return { color: "var(--syn-string)" };
  const color = valueColor(v);
  return {
    ...(color ? { color } : {}),
    ...(v.kind === "null" ? { fontStyle: "italic" } : {}),
  };
}

/** The text an edit field starts with: JSON for strings, the plain text otherwise. */
export function editText(v: Value): string {
  return propertyText(v);
}

/** What an edit field holds as a JavaScript value: JSON when it parses, else a plain string. */
export function parseEdit(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}
