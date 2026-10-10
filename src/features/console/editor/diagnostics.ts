import { linter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";

/** An execution error pinned to a place in the document. */
export interface ErrorMark {
  from: number;
  to: number;
  message: string;
}

/** Enables the lint state; marks come from execution errors, never from a background linter. */
export const diagnosticsExtension = linter(null);

/** Convert a 1-based Unicode-scalar offset (as servers report it) into a UTF-16 index. */
export function charOffsetToIndex(text: string, charOffset: number): number {
  let index = 0;
  let seen = 0;
  while (seen < charOffset && index < text.length) {
    index += text.codePointAt(index)! > 0xffff ? 2 : 1;
    seen += 1;
  }
  return index;
}

/**
 * The range to underline for a server-reported position: the identifier (with dots and quotes)
 * that starts at the position, else one character.
 */
export function errorRange(
  doc: string,
  statementFrom: number,
  statementText: string,
  position: number,
): { from: number; to: number } {
  const at = statementFrom + charOffsetToIndex(statementText, Math.max(0, position - 1));
  const from = Math.min(at, doc.length);
  const word = /^[\w$."`[\]]+/.exec(doc.slice(from));
  const to = from + (word ? word[0].length : 1);
  return { from, to: Math.min(Math.max(to, from + 1), Math.max(doc.length, from + 1)) };
}

/** Show (or with an empty list, clear) the error underlines. */
export function showErrorMarks(view: EditorView, marks: ErrorMark[]): void {
  const len = view.state.doc.length;
  const diagnostics: Diagnostic[] = marks
    .filter((m) => m.from < len || len === 0)
    .map((m) => ({
      from: Math.min(m.from, len),
      to: Math.min(Math.max(m.to, m.from), len),
      severity: "error",
      message: m.message,
    }));
  view.dispatch(setDiagnostics(view.state, diagnostics));
}
