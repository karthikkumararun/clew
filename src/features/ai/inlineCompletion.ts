/**
 * Ghost-text completions in the SQL editor (spec: ai-inline-completion › Ghost-text completions).
 * A suggestion appears dim after the cursor once typing pauses (300 ms); Tab accepts it, Mod+Right
 * takes the next word, Alt+] / Alt+[ cycle alternatives, Esc or any other keystroke dismisses it.
 * The schema popup wins over ghost text when both are present.
 */
import { completionStatus } from "@codemirror/autocomplete";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

export const DEBOUNCE_MS = 300;
/** Documents over this size get no completions. */
export const MAX_DOC_BYTES = 1_000_000;

export interface Suggestions {
  suggestions: string[];
  /** Named in the hint: `Copilot`, `Anthropic Claude`. */
  provider: string;
}

export interface InlineConfig {
  /** Ask for suggestions at the cursor; `signal` aborts when the user moves on. */
  source: (prefix: string, suffix: string, signal: AbortSignal) => Promise<Suggestions>;
  /** Whether completions are on for this editor right now (AI on, routed, policy, not paused). */
  enabled: () => boolean;
  /** Test hook: whether the schema popup is open. */
  popupOpen?: (state: EditorState) => boolean;
}

interface Ghost {
  /** What is still to be inserted at `at`. */
  text: string;
  at: number;
  alternatives: string[];
  index: number;
  provider: string;
}

const setGhost = StateEffect.define<Ghost | null>();

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!value) return null;
    if (!tr.docChanged) return tr.selection ? null : value;
    // Typing through: characters that match the start of the suggestion consume it.
    let consumed: string | null = null;
    let only = true;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (consumed !== null || fromA !== toA || fromA !== value.at) only = false;
      else consumed = inserted.toString();
    });
    if (!only || !consumed || !value.text.startsWith(consumed)) return null;
    const rest = value.text.slice((consumed as string).length);
    return rest ? { ...value, text: rest, at: value.at + (consumed as string).length } : null;
  },
});

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly hint: string,
  ) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text && other.hint === this.hint;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-ghost";
    wrap.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "cm-ghostText";
    text.textContent = this.text;
    const hint = document.createElement("span");
    hint.className = "cm-ghostHint";
    hint.textContent = this.hint;
    wrap.append(text, hint);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const hintFor = (g: Ghost) =>
  `  Tab accept · ⌥] next · ${g.provider}${g.alternatives.length > 1 ? ` (${g.index + 1}/${g.alternatives.length})` : ""}`;

const ghostDecorations = () =>
  EditorView.decorations.compute([ghostField], (state): DecorationSet => {
    const g = state.field(ghostField);
    if (!g || !g.text) return Decoration.none;
    return Decoration.set([
      Decoration.widget({ widget: new GhostWidget(g.text, hintFor(g)), side: 1 }).range(g.at),
    ]);
  });

const theme = EditorView.baseTheme({
  ".cm-ghostText": { color: "var(--text-dim)", fontStyle: "italic", whiteSpace: "pre-wrap" },
  ".cm-ghostHint": {
    color: "var(--text-dim)",
    fontFamily: "var(--font-ui)",
    fontSize: "11px",
    opacity: "0.7",
    userSelect: "none",
  },
});

function acceptText(view: EditorView, text: string): boolean {
  const g = view.state.field(ghostField);
  if (!g) return false;
  const insert = text;
  view.dispatch({
    changes: { from: g.at, insert },
    selection: { anchor: g.at + insert.length },
    // The consumed part is gone from the ghost; the rest follows the cursor.
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

/** Accept the first word (and the whitespace before it) of the suggestion. */
export function firstWord(text: string): string {
  const m = /^\s*\S+/.exec(text);
  return m ? m[0] : text;
}

function cycle(view: EditorView, step: 1 | -1): boolean {
  const g = view.state.field(ghostField);
  if (!g || g.alternatives.length < 2) return false;
  const index = (g.index + step + g.alternatives.length) % g.alternatives.length;
  view.dispatch({ effects: setGhost.of({ ...g, index, text: g.alternatives[index] }) });
  return true;
}

export function inlineCompletion(config: InlineConfig): Extension {
  const popup = config.popupOpen ?? ((s: EditorState) => completionStatus(s) !== null);

  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      abort: AbortController | null = null;
      constructor(readonly view: EditorView) {}

      cancel() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.abort?.abort();
        this.abort = null;
      }

      update(u: ViewUpdate) {
        // Typing (not a cursor move) restarts the pause; anything else just drops the request.
        const typed = u.transactions.some(
          (t) => t.docChanged && !t.isUserEvent("input.complete") && !t.isUserEvent("undo"),
        );
        if (!u.docChanged && !u.selectionSet) return;
        this.cancel();
        if (!typed) return;
        if (u.state.field(ghostField)) return; // typed through: the suggestion is still good
        this.timer = setTimeout(() => this.request(), DEBOUNCE_MS);
      }

      async request() {
        this.timer = null;
        const { state } = this.view;
        if (!config.enabled()) return;
        if (state.doc.length > MAX_DOC_BYTES) return;
        if (!state.selection.main.empty || popup(state)) return;
        const at = state.selection.main.head;
        const prefix = state.sliceDoc(0, at);
        const suffix = state.sliceDoc(at);
        const abort = new AbortController();
        this.abort = abort;
        try {
          const r = await config.source(prefix, suffix, abort.signal);
          if (abort.signal.aborted || this.view.state.selection.main.head !== at) return;
          if (this.view.state.doc.length !== state.doc.length) return;
          const alternatives = r.suggestions.filter((s) => s.length > 0);
          if (alternatives.length === 0) return;
          this.view.dispatch({
            effects: setGhost.of({
              text: alternatives[0],
              at,
              alternatives,
              index: 0,
              provider: r.provider,
            }),
          });
        } catch {
          /* the source reports its own errors; ghost text just doesn't appear */
        } finally {
          if (this.abort === abort) this.abort = null;
        }
      }

      destroy() {
        this.cancel();
      }
    },
  );

  const keys = Prec.high(
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          const g = view.state.field(ghostField);
          // The schema popup takes Tab for its own item.
          if (!g || popup(view.state)) return false;
          return acceptText(view, g.text);
        },
      },
      {
        key: "Mod-ArrowRight",
        run: (view) => {
          const g = view.state.field(ghostField);
          if (!g || popup(view.state)) return false;
          return acceptText(view, firstWord(g.text));
        },
      },
      { key: "Alt-]", run: (view) => cycle(view, 1) },
      { key: "Alt-[", run: (view) => cycle(view, -1) },
      {
        key: "Escape",
        run: (view) => {
          if (!view.state.field(ghostField)) return false;
          view.dispatch({ effects: setGhost.of(null) });
          return true;
        },
      },
    ]),
  );

  return [ghostField, ghostDecorations(), plugin, keys, theme];
}

/** The suggestion on screen, for tests and the status bar. */
export const currentGhost = (state: EditorState): string | null =>
  state.field(ghostField, false)?.text ?? null;
