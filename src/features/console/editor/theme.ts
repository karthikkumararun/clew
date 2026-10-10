import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** Line height for a font size: 13px text sits on 20px lines in the canvas. */
export const lineHeightFor = (fontSize: number) => Math.round((fontSize * 20) / 13);

/** Font size and line height; reconfigured when the Settings value changes. */
export const sizeTheme = (fontSize: number) =>
  EditorView.theme({
    "&": { fontSize: `${fontSize}px` },
    ".cm-scroller": { lineHeight: `${lineHeightFor(fontSize)}px` },
  });

export const baseTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg-app)",
      color: "var(--text)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      overflow: "auto",
    },
    ".cm-content": { padding: "10px 0", caretColor: "var(--text)" },
    ".cm-line": { padding: "0 14px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)", borderLeftWidth: "2px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-matchingBracket": {
      backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
      outline: "none",
    },
    ".cm-nonmatchingBracket": { color: "var(--danger)" },

    // 56px gutter: the ▶ run marker and the line numbers.
    ".cm-gutters": {
      backgroundColor: "var(--bg-app)",
      color: "var(--text-gutter)",
      border: "none",
      borderRight: "1px solid var(--border-subtle)",
      width: "56px",
      flex: "none",
    },
    ".cm-gutter": { minHeight: "100%" },
    ".cm-gutterElement": { padding: "0" },
    ".cm-lineNumbers": { width: "38px" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 0", textAlign: "right" },
    ".cm-runGutter": { width: "18px" },
    ".cm-runGutter .cm-gutterElement": { textAlign: "center", cursor: "pointer" },
    ".cm-runMarker": { color: "var(--accent)", lineHeight: "inherit" },
    ".cm-runMarker:hover": { color: "var(--accent-hover)" },

    ".cm-current-statement": { backgroundColor: "var(--bg-current-statement)" },

    // Search panel.
    ".cm-panels": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--text-secondary)",
      borderColor: "var(--border)",
    },
    ".cm-panels input, .cm-panels button": {
      font: "inherit",
      fontSize: "12px",
      color: "var(--text)",
      backgroundColor: "var(--bg-app)",
      border: "1px solid var(--border-strong)",
      borderRadius: "var(--radius)",
    },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)",
    },

    // Completion popup, as in the canvas: icon, name, dim signature, right-aligned kind/type.
    ".cm-tooltip.cm-tooltip-autocomplete": {
      width: "340px",
      overflow: "hidden",
      boxShadow: "var(--shadow-popover)",
      borderColor: "var(--border-strong)",
      borderRadius: "8px",
      fontSize: "12px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete::after": {
      display: "block",
      padding: "6px 10px",
      borderTop: "1px solid var(--border)",
      color: "var(--text-dim)",
      fontFamily: "var(--font-ui)",
      fontSize: "11px",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono)",
      maxHeight: "208px",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      height: "26px",
      padding: "0 10px",
      color: "var(--text)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--bg-segment-active)",
      color: "var(--text)",
    },
    ".cm-completionLabel": { whiteSpace: "nowrap" },
    ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)" },
    ".cm-completionDetail": {
      marginLeft: "0",
      color: "var(--text-muted)",
      fontStyle: "normal",
    },
    ".cm-sqlIcon": { width: "14px", textAlign: "center", flex: "none" },
    ".cm-sqlKind": { marginLeft: "auto", color: "var(--text-dim)", paddingLeft: "8px" },

    // Diagnostics (execution errors).
    ".cm-lintRange-error": {
      backgroundImage: "none",
      textDecoration: "underline wavy var(--danger)",
      textUnderlineOffset: "3px",
    },
    ".cm-tooltip": {
      border: "1px solid var(--border-strong)",
      backgroundColor: "var(--bg-raised)",
      color: "var(--text)",
      borderRadius: "var(--radius-md)",
    },
    ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
  },
  { dark: true },
);

export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  {
    tag: [t.function(t.variableName), t.standard(t.name), t.special(t.name)],
    color: "var(--syn-function)",
  },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.integer, t.float], color: "var(--syn-number)" },
  { tag: [t.bool, t.null], color: "var(--syn-boolean)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)" },
  { tag: [t.typeName, t.className], color: "var(--syn-function)" },
  { tag: [t.operator, t.punctuation], color: "var(--text-secondary)" },
]);

export const editorTheme = [baseTheme, syntaxHighlighting(highlightStyle)];
