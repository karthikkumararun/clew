import type { LineEdit } from "./api";

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Offsets of the start of every line of `text` (an extra entry marks the end). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/**
 * The document changes that apply `edits` (1-based lines; an insertion before line N has
 * `endLine = N - 1`; an empty replacement deletes the lines), exactly as the Rust side's
 * `tools::apply` reads them. The edits have already been validated and sorted by Rust.
 */
export function lineEditChanges(text: string, edits: LineEdit[]): TextChange[] {
  const starts = lineStarts(text);
  const lines = starts.length;
  const lineFrom = (n: number) => starts[n - 1];
  const lineTo = (n: number) => (n < lines ? starts[n] - 1 : text.length);
  return edits.map((e) => {
    const insertion = e.endLine < e.startLine;
    if (insertion) {
      if (e.startLine > lines)
        return { from: text.length, to: text.length, insert: `\n${e.replacement}` };
      return {
        from: lineFrom(e.startLine),
        to: lineFrom(e.startLine),
        insert: `${e.replacement}\n`,
      };
    }
    if (e.replacement === "") {
      // Delete the lines with one line break: the one after them, or before them at the end.
      if (e.endLine < lines)
        return { from: lineFrom(e.startLine), to: lineFrom(e.endLine + 1), insert: "" };
      const from = e.startLine > 1 ? lineFrom(e.startLine) - 1 : 0;
      return { from, to: text.length, insert: "" };
    }
    return { from: lineFrom(e.startLine), to: lineTo(e.endLine), insert: e.replacement };
  });
}

/** `text` with the edits applied. */
export function applyLineEdits(text: string, edits: LineEdit[]): string {
  const changes = lineEditChanges(text, edits).sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  for (const c of changes) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/** Added and removed line counts of a set of edits, for the card and the bar. */
export function editStats(text: string, edits: LineEdit[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const insertion = e.endLine < e.startLine;
    removed += insertion ? 0 : e.endLine - e.startLine + 1;
    added += e.replacement === "" ? 0 : e.replacement.split("\n").length;
  }
  void text;
  return { added, removed };
}
