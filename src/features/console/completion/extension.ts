import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { isMac } from "../../../lib/platform";
import { editorDialect, isNoSql } from "../editor/dialects";
import { currentStatementOf } from "../editor/statementField";
import { suggest } from "./engine";
import type { Suggestion, SuggestionKind } from "./engine";
import { nosqlSource } from "./nosql";
import { loadSnapshot, onSnapshotChange, peekSnapshot } from "./snapshots";

/** What the completion source needs to know about the console, read on every request. */
export interface CompletionTarget {
  connectionId: string;
  driver: string;
  /** Database whose snapshot to use (empty: the connection's own). */
  database: string;
  defaultSchema?: string;
  /** Snapshots exist only for connected connections. */
  connected: boolean;
}

const ICONS: Record<SuggestionKind, { glyph: string; token: string }> = {
  keyword: { glyph: "◇", token: "--syn-keyword" },
  schema: { glyph: "▤", token: "--text-muted" },
  table: { glyph: "▦", token: "--drv-postgres" },
  view: { glyph: "▦", token: "--syn-function" },
  column: { glyph: "▪", token: "--drv-postgres" },
  function: { glyph: "ƒ", token: "--accent" },
  aggregate: { glyph: "ƒ", token: "--accent" },
};

/** The suggestion behind each completion, for the custom option rendering. */
const behind = new WeakMap<Completion, Suggestion>();

function toCompletion(s: Suggestion): Completion {
  const completion: Completion = {
    label: s.label,
    apply: s.insert,
    type: s.kind,
    detail: s.signature,
    boost: s.boost,
  };
  behind.set(completion, s);
  return completion;
}

export function createSource(getTarget: () => CompletionTarget) {
  const keywords = new Map<string, string[]>();
  const keywordsFor = (driver: string): string[] => {
    let list = keywords.get(driver);
    if (!list) {
      // The dialect's own keyword list.
      const words = (editorDialect(driver).spec.keywords ?? "").split(" ").filter(Boolean);
      list = words.map((w) => w.toUpperCase());
      keywords.set(driver, list);
    }
    return list;
  };

  return (context: CompletionContext): CompletionResult | null => {
    const target = getTarget();
    const { state, pos } = context;
    const line = state.doc.lineAt(pos);
    const typed = /[\w$]*$/.exec(line.text.slice(0, pos - line.from))?.[0] ?? "";
    const dotted = /\.\s*[\w$]*$/.test(line.text.slice(0, pos - line.from));
    if (!context.explicit && typed.length === 0 && !dotted) return null;

    const current = currentStatementOf(state);
    const start = current ? Math.min(current.from, pos) : 0;
    const end = current ? Math.max(current.to, pos) : state.doc.length;

    let snapshot = target.connected ? peekSnapshot(target.connectionId, target.database) : null;
    if (!snapshot && target.connected) {
      // Keywords now; schema items once the snapshot is here, without retyping.
      const view = context.view;
      void loadSnapshot(target.connectionId, target.database)
        .then(() => {
          if (view && completionStatus(view.state) !== null) startCompletion(view);
        })
        .catch(() => {});
      snapshot = null;
    }

    const options = suggest({
      before: state.sliceDoc(start, pos),
      after: state.sliceDoc(pos, end),
      snapshot,
      driver: target.driver,
      defaultSchema: target.defaultSchema,
      keywords: keywordsFor(target.driver),
    }).map(toCompletion);
    return { from: pos - typed.length, options, filter: true };
  };
}

function optionIcon(completion: Completion): Node {
  const s = behind.get(completion);
  const el = document.createElement("span");
  el.className = "cm-sqlIcon";
  const icon = ICONS[s?.kind ?? "keyword"];
  el.textContent = icon.glyph;
  el.style.color = `var(${icon.token})`;
  el.setAttribute("aria-hidden", "true");
  return el;
}

function optionKind(completion: Completion): Node | null {
  const right = behind.get(completion)?.right;
  if (!right) return null;
  const el = document.createElement("span");
  el.className = "cm-sqlKind";
  el.textContent = right;
  return el;
}

const hint = () => `↵ insert · ⇥ replace · ${isMac() ? "⌃Space" : "Ctrl+Space"} more`;

/** Completion for a console: keywords, schemas, tables, columns, aliases and functions. */
export function sqlCompletion(getTarget: () => CompletionTarget): Extension {
  const sqlSource = createSource(getTarget);
  const commands = nosqlSource(getTarget);
  // Which language the console speaks is decided per request, from its connection.
  const route = (context: CompletionContext) =>
    isNoSql(getTarget().driver) ? commands(context) : sqlSource(context);
  return [
    autocompletion({
      override: [route],
      icons: false,
      defaultKeymap: false,
      maxRenderedOptions: 200,
      addToOptions: [
        { render: optionIcon, position: 10 },
        { render: optionKind, position: 90 },
      ],
    }),
    keymap.of([{ key: "Tab", run: acceptCompletion }]),
    EditorView.theme({
      ".cm-tooltip-autocomplete::after": { content: JSON.stringify(hint()) },
    }),
  ];
}

/** When a snapshot arrives or goes stale, re-offer completions that are open. */
export function watchSnapshots(view: EditorView, connectionId: string): () => void {
  return onSnapshotChange((id) => {
    if (id === connectionId && completionStatus(view.state) !== null) startCompletion(view);
  });
}
