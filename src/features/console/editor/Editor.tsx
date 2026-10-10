import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { editorDialect, splitDialect } from "./dialects";
import { statementExtensions } from "./statementField";
import type { StatementRange } from "./statements";
import { editorTheme, sizeTheme } from "./theme";
import { registerView } from "./views";

export interface EditorProps {
  tabId: string;
  /** The driver id (`postgres`, `mysql`, …): picks highlighting and splitting rules. */
  driver: string;
  value: string;
  fontSize: number;
  /** Extra extensions (completion, diagnostics). Reconfigured when the identity changes. */
  extensions?: Extension;
  onChange: (text: string) => void;
  onCursor?: (line: number, col: number) => void;
  onRunStatement: (range: StatementRange) => void;
  onReady?: (view: EditorView) => void;
}

// The default keymap minus the keys the shell owns: Mod+Enter runs, Escape cancels.
const editingKeys = defaultKeymap.filter((b) => b.key !== "Mod-Enter" && b.key !== "Escape");

/** CodeMirror 6 wrapped for React. The document is owned by the tab state. */
export function Editor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const size = useRef(new Compartment());
  const lang = useRef(new Compartment());
  const extra = useRef(new Compartment());
  const dialect = useRef(new Compartment());

  useEffect(() => {
    const p = latest.current;
    const state = EditorState.create({
      doc: p.value,
      extensions: [
        // The gutter order is: run marker, then line numbers.
        dialect.current.of(
          statementExtensions(splitDialect(p.driver), (r) => latest.current.onRunStatement(r)),
        ),
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        rectangularSelection(),
        EditorState.allowMultipleSelections.of(true),
        EditorView.clickAddsSelectionRange.of((e) => e.altKey || e.metaKey),
        search({ top: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...editingKeys,
        ]),
        lang.current.of(sql({ dialect: editorDialect(p.driver), upperCaseKeywords: false })),
        editorTheme,
        size.current.of(sizeTheme(p.fontSize)),
        extra.current.of(p.extensions ?? []),
        EditorView.contentAttributes.of({ "aria-label": "SQL editor", spellcheck: "false" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            latest.current.onCursor?.(line.number, head - line.from + 1);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current as HTMLElement });
    viewRef.current = view;
    const off = registerView(p.tabId, view);
    p.onReady?.(view);
    return () => {
      off();
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once per mounted console; later changes are reconfigured below.
  }, [props.tabId]);

  // External text changes (file reload, "Insert into editor", format).
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: size.current.reconfigure(sizeTheme(props.fontSize)) });
  }, [props.fontSize]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        lang.current.reconfigure(sql({ dialect: editorDialect(props.driver) })),
        dialect.current.reconfigure(
          statementExtensions(splitDialect(props.driver), (r) => latest.current.onRunStatement(r)),
        ),
      ],
    });
  }, [props.driver]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: extra.current.reconfigure(props.extensions ?? []) });
  }, [props.extensions]);

  return (
    <div
      ref={host}
      style={{ height: "100%", minHeight: 0, minWidth: 0 }}
      data-testid="sql-editor"
    />
  );
}
