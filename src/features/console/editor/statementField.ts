import { Facet, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { splitStatements, statementAt } from "./statements";
import type { SplitDialect, StatementRange } from "./statements";

/** Which splitting rules apply to this editor. */
export const splitDialectFacet = Facet.define<SplitDialect, SplitDialect>({
  combine: (v) => v[0] ?? null,
});

/** Called when the ▶ marker is clicked. */
export const runStatementFacet = Facet.define<
  (range: StatementRange) => void,
  (range: StatementRange) => void
>({
  combine: (v) => v[0] ?? (() => {}),
});

interface Statements {
  ranges: StatementRange[];
  current: StatementRange | null;
}

function compute(doc: string, pos: number, dialect: SplitDialect): Statements {
  const ranges = splitStatements(doc, dialect, { blankLines: true, skipLeadingComments: true });
  return { ranges, current: statementAt(ranges, pos) };
}

/** All statements of the document and the one under the cursor. */
export const statementField = StateField.define<Statements>({
  create: (state) =>
    compute(state.doc.toString(), state.selection.main.head, state.facet(splitDialectFacet)),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) return value;
    const dialect = tr.state.facet(splitDialectFacet);
    if (!tr.docChanged) {
      return {
        ranges: value.ranges,
        current: statementAt(value.ranges, tr.state.selection.main.head),
      };
    }
    return compute(tr.state.doc.toString(), tr.state.selection.main.head, dialect);
  },
});

const tint = Decoration.line({ class: "cm-current-statement" });

const tintField = StateField.define<DecorationSet>({
  create: (state) => tintFor(state),
  update: (_value, tr) => tintFor(tr.state),
  provide: (f) => EditorView.decorations.from(f),
});

function tintFor(state: EditorState): DecorationSet {
  const cur = state.field(statementField).current;
  if (!cur) return Decoration.none;
  const first = state.doc.lineAt(cur.from).number;
  const last = state.doc.lineAt(cur.to).number;
  const marks = [];
  for (let n = first; n <= last; n++) marks.push(tint.range(state.doc.line(n).from));
  return Decoration.set(marks);
}

class RunMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-runMarker";
    el.textContent = "▶";
    el.title = "Run statement";
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Run statement");
    return el;
  }
  eq(other: GutterMarker) {
    return other instanceof RunMarker;
  }
}
const runMarker = new RunMarker();

const runGutter = gutter({
  class: "cm-runGutter",
  lineMarker(view, line) {
    const cur = view.state.field(statementField).current;
    if (!cur) return null;
    return view.state.doc.lineAt(cur.from).from === line.from ? runMarker : null;
  },
  lineMarkerChange: (update) =>
    update.docChanged ||
    update.selectionSet ||
    update.startState.field(statementField) !== update.state.field(statementField),
  initialSpacer: () => runMarker,
  domEventHandlers: {
    mousedown(view, line) {
      return runStatementOnLine(view, line.from);
    },
  },
});

/** Run the statement that starts on the line beginning at `lineFrom`. False if none does. */
export function runStatementOnLine(view: EditorView, lineFrom: number): boolean {
  const hit = view.state
    .field(statementField)
    .ranges.find((r) => view.state.doc.lineAt(r.from).from === lineFrom);
  if (!hit) return false;
  view.state.facet(runStatementFacet)(hit);
  return true;
}

/** The statement under the cursor of a state that has the statement field. */
export const currentStatementOf = (state: EditorState): StatementRange | null =>
  state.field(statementField, false)?.current ?? null;

export const statementExtensions = (
  dialect: SplitDialect,
  onRun: (range: StatementRange) => void,
): Extension => [
  splitDialectFacet.of(dialect),
  runStatementFacet.of(onRun),
  statementField,
  tintField,
  runGutter,
];
