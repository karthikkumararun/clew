import { quoteIdent } from "../grid/sqlLiteral";
import type { SqlFlavor } from "../grid/sqlLiteral";

export interface Completion {
  /** Start of the word being completed. */
  from: number;
  to: number;
  items: string[];
}

const WORD = /[A-Za-z_][\w$]*$/;

/** Column names that start with (else contain) the word before the caret. */
export function completeAt(
  text: string,
  caret: number,
  columns: string[],
  limit = 8,
): Completion | null {
  const before = text.slice(0, caret);
  const m = WORD.exec(before);
  if (!m) return null;
  const word = m[0].toLowerCase();
  // Not in the middle of a string literal.
  if ((before.match(/'/g) ?? []).length % 2 === 1) return null;
  const starts = columns.filter(
    (c) => c.toLowerCase().startsWith(word) && c.toLowerCase() !== word,
  );
  const contains = columns.filter(
    (c) => !c.toLowerCase().startsWith(word) && c.toLowerCase().includes(word),
  );
  const items = [...starts, ...contains].slice(0, limit);
  return items.length ? { from: caret - m[0].length, to: caret, items } : null;
}

/** Replace the word with a column name (quoted when it needs it). */
export function applyCompletion(
  text: string,
  c: Completion,
  column: string,
  flavor: SqlFlavor,
): { text: string; caret: number } {
  const insert = /^[a-z_][a-z0-9_$]*$/.test(column) ? column : quoteIdent(flavor, column);
  return { text: text.slice(0, c.from) + insert + text.slice(c.to), caret: c.from + insert.length };
}
