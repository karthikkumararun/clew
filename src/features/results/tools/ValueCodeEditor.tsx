/**
 * Contract: the CodeMirror editor inside the value editor panel. `value` is the baseline: when it
 * changes the document is replaced (and `onChange` reports it); typing reports the new text
 * through `onChange`. `language` picks highlighting. Only `@codemirror/lang-sql` is installed, so
 * JSON and XML use small stream tokenizers defined here, and Plain has none; if a real language
 * package is added later, swap `languageFor`. Read-only mode keeps selection and copy working.
 */
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { baseTheme, highlightStyle, sizeTheme } from "../../console/editor/theme";
import type { HighlightAs } from "../../grid/tools/valueCodec";

const jsonParser: StreamParser<null> = {
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
      return stream.match(/^\s*:/, false) ? "propertyName" : "string";
    }
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:true|false|null)\b/)) return "bool";
    stream.next();
    return null;
  },
};

const xmlParser: StreamParser<null> = {
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^<!--.*?(?:-->|$)/)) return "comment";
    if (stream.match(/^<\/?[\w:.-]+/) || stream.match(/^<[?!][\w:.-]*/)) return "tagName";
    if (stream.match(/^\/?>|^\?>/)) return "tagName";
    if (stream.match(/^"[^"]*"|^'[^']*'/)) return "string";
    if (stream.match(/^[\w:.-]+(?==)/)) return "attributeName";
    stream.next();
    return null;
  },
};

const languages = {
  json: StreamLanguage.define(jsonParser),
  xml: StreamLanguage.define(xmlParser),
};

const valueHighlight = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--syn-function)" },
  { tag: t.tagName, color: "var(--syn-keyword)" },
  { tag: t.attributeName, color: "var(--syn-function)" },
  { tag: t.string, color: "var(--syn-string)" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: t.bool, color: "var(--syn-boolean)" },
  { tag: t.comment, color: "var(--syn-comment)" },
]);

export function languageFor(language: HighlightAs): Extension {
  switch (language) {
    case "json":
      return languages.json;
    case "xml":
      return languages.xml;
    case "sql":
      return sql({ upperCaseKeywords: false });
    default:
      return [];
  }
}

const panelTheme = EditorView.theme({
  ".cm-content": { padding: "8px 0" },
  ".cm-line": { padding: "0 10px" },
  "&": { height: "100%" },
});

export interface ValueCodeEditorProps {
  value: string;
  language: HighlightAs;
  readOnly: boolean;
  fontSize?: number;
  "aria-label": string;
  onChange: (text: string) => void;
}

export function ValueCodeEditor(props: ValueCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const lang = useRef(new Compartment());
  const ro = useRef(new Compartment());
  const size = useRef(new Compartment());

  useEffect(() => {
    const p = latest.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          history(),
          drawSelection(),
          search({ top: true }),
          keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.lineWrapping,
          baseTheme,
          panelTheme,
          syntaxHighlighting(highlightStyle),
          syntaxHighlighting(valueHighlight),
          lang.current.of(languageFor(p.language)),
          ro.current.of([EditorState.readOnly.of(p.readOnly), EditorView.editable.of(true)]),
          size.current.of(sizeTheme(p.fontSize ?? 12)),
          EditorView.contentAttributes.of({
            "aria-label": p["aria-label"],
            "aria-readonly": String(p.readOnly),
            spellcheck: "false",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(languageFor(props.language)) });
  }, [props.language]);

  useEffect(() => {
    view.current?.dispatch({
      effects: ro.current.reconfigure([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(true),
      ]),
    });
  }, [props.readOnly]);

  return <div ref={host} style={{ height: "100%" }} />;
}
