/**
 * Direct edits with review (spec: ai-assistant › Direct edits with review). The assistant's
 * changes are written into the console as one transaction and shown as a pending inline diff with
 * `@codemirror/merge`; each hunk can be kept or undone, or all at once. Nothing here runs SQL.
 */
import {
  acceptChunk,
  getChunks,
  getOriginalDoc,
  originalDocChangeEffect,
  rejectChunk,
  unifiedMergeView,
} from "@codemirror/merge";
import { ChangeSet, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { create } from "zustand";
import { getView } from "../console/editor/views";
import type { LineEdit } from "./api";
import { applyLineEdits, editStats, lineEditChanges } from "./lineEdits";

/** Where the review extension lives in a console's editor; start with nothing. */
export const reviewCompartment = new Compartment();
export const reviewSlot: Extension = reviewCompartment.of([]);

export interface HunkInfo {
  /** Document position of the hunk in the edited text. */
  from: number;
  /** 1-based line the hunk starts on. */
  line: number;
  added: number;
  removed: number;
}

export interface ReviewInfo {
  id: number;
  active: boolean;
  summary: string;
  /** Hunks the edit started with. */
  total: number;
  kept: number;
  undone: number;
  hunks: HunkInfo[];
  /** Which hunk the bar points at (0-based). */
  current: number;
  added: number;
  removed: number;
  /** The edits as the card lists them. */
  lines: { label: string; text: string; insert: boolean }[];
}

interface ReviewStore {
  byTab: Record<string, ReviewInfo>;
  /** Final state of every review that ended, by id, for the chat's cards. */
  results: Record<number, ReviewInfo>;
}

export const useReview = create<ReviewStore>(() => ({ byTab: {}, results: {} }));

let nextId = 1;

const patch = (tabId: string, f: (r: ReviewInfo) => Partial<ReviewInfo>) =>
  useReview.setState((s) => {
    const cur = s.byTab[tabId];
    if (!cur) return s;
    const next = { ...cur, ...f(cur) };
    return {
      byTab: { ...s.byTab, [tabId]: next },
      results: { ...s.results, [next.id]: next },
    };
  });

/** Whether a console has AI hunks waiting for a decision. */
export const hasPendingReview = (tabId: string): boolean =>
  !!useReview.getState().byTab[tabId]?.active;

function countLines(
  state: EditorState,
  doc: { lineAt(pos: number): { number: number } },
  from: number,
  to: number,
) {
  void state;
  if (from >= to) return 0;
  return doc.lineAt(to - 1).number - doc.lineAt(from).number + 1;
}

/** Read the hunks out of the editor and publish them. */
function publish(tabId: string, state: EditorState) {
  const found = getChunks(state);
  const original = getOriginalDoc(state);
  const hunks: HunkInfo[] = (found?.chunks ?? []).map((c) => ({
    from: c.fromB,
    line: state.doc.lineAt(Math.min(c.fromB, state.doc.length)).number,
    added: countLines(state, state.doc, c.fromB, c.toB),
    removed: countLines(state, original, c.fromA, c.toA),
  }));
  patch(tabId, (r) => ({
    hunks,
    current: Math.min(r.current, Math.max(0, hunks.length - 1)),
    added: hunks.reduce((n, h) => n + h.added, 0),
    removed: hunks.reduce((n, h) => n + h.removed, 0),
  }));
  // Not before the edit has landed: the first update only installs the diff view.
  if (hunks.length === 0 && (useReview.getState().byTab[tabId]?.total ?? 0) > 0) finish(tabId);
}

/** Every hunk has been decided: take the diff view away. */
function finish(tabId: string) {
  const view = getView(tabId);
  const cur = useReview.getState().byTab[tabId];
  if (!cur?.active) return;
  patch(tabId, () => ({ active: false }));
  // After the current update has finished, so the view is not reconfigured inside its own listener.
  queueMicrotask(() => view?.dispatch({ effects: reviewCompartment.reconfigure([]) }));
}

function button(type: "accept" | "reject", action: (e: MouseEvent) => void, tabId: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.name = type;
  b.textContent = type === "accept" ? "Keep" : "Undo";
  b.setAttribute("aria-label", type === "accept" ? "Keep this change" : "Undo this change");
  b.dataset.review = type;
  b.onmousedown = (e) => {
    patch(tabId, (r) => (type === "accept" ? { kept: r.kept + 1 } : { undone: r.undone + 1 }));
    action(e);
  };
  return b;
}

/** Transactions that are the review's own: the edit, Undo all, and Keep / Undo on a hunk. */
const OWN_EVENTS = /^(input\.ai|undo\.ai|accept|revert)/;

/**
 * Text the user types outside the pending hunks becomes part of the baseline, so it isn't shown
 * as a hunk and the hunks keep their meaning; their positions follow the edit. Changes that touch
 * a hunk stay part of it.
 */
const followUserEdits = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged) return null;
  const event = tr.annotation(Transaction.userEvent);
  if (event && OWN_EVENTS.test(event)) return null;
  const found = getChunks(tr.startState);
  if (!found) return null;
  const chunks = found.chunks;
  const original = getOriginalDoc(tr.startState);
  const mapped: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((from: number, to: number, _fa: number, _ta: number, inserted) => {
    let delta = 0;
    for (const c of chunks) {
      if (from <= c.toB && to >= c.fromB) return; // touches a hunk
      if (c.toB < from) delta += c.toB - c.fromB - (c.toA - c.fromA);
    }
    mapped.push({ from: from - delta, to: to - delta, insert: inserted.toString() });
  });
  if (mapped.length === 0) return null;
  const changes = ChangeSet.of(mapped, original.length);
  return { effects: originalDocChangeEffect(tr.startState, changes) };
});

const reviewTheme = EditorView.theme({
  ".cm-changedLine, .cm-inlineChangedLine, .cm-insertedLine": {
    backgroundColor: "var(--diff-added-bg)",
    boxShadow: "inset 3px 0 0 var(--success)",
  },
  ".cm-changedText": { background: "var(--diff-added-word)" },
  ".cm-deletedChunk": {
    position: "relative",
    backgroundColor: "var(--diff-removed-bg)",
    boxShadow: "inset 3px 0 0 var(--danger)",
    paddingLeft: "14px",
  },
  ".cm-deletedLine, .cm-deletedLine del": {
    textDecoration: "line-through",
    textDecorationColor: "var(--diff-removed-strike)",
    color: "var(--text-secondary)",
  },
  ".cm-deletedChunk .cm-deletedText": { background: "var(--diff-removed-strike)" },
  ".cm-deletedChunk .cm-chunkButtons": {
    position: "absolute",
    insetInlineEnd: "14px",
    top: "2px",
    display: "flex",
    gap: "4px",
    fontFamily: "var(--font-ui)",
    zIndex: "2",
  },
  ".cm-deletedChunk button": {
    height: "22px",
    padding: "0 8px",
    borderRadius: "4px",
    border: "1px solid var(--border-strong)",
    fontSize: "11px",
    cursor: "pointer",
  },
  ".cm-deletedChunk button[name=accept]": {
    background: "var(--keep-bg)",
    borderColor: "var(--keep-border)",
    color: "var(--success)",
  },
  ".cm-deletedChunk button[name=reject]": {
    background: "var(--env-prod-surface)",
    borderColor: "var(--env-prod-border)",
    color: "var(--env-prod-badge-fg)",
  },
  ".cm-changeGutter": { width: "3px" },
  ".cm-changedLineGutter": { background: "var(--success)" },
  ".cm-deletedLineGutter": { background: "var(--danger)" },
});

function cardLines(edits: LineEdit[]) {
  const first = (s: string) => {
    const l = s.split("\n").find((x) => x.trim()) ?? "";
    return (
      l.trim().slice(0, 80) + (s.includes("\n") && s.trim().split("\n").length > 1 ? " …" : "")
    );
  };
  return edits.map((e) => {
    const insert = e.endLine < e.startLine;
    const label = insert
      ? `L${e.startLine}`
      : e.startLine === e.endLine
        ? `L${e.startLine}`
        : `L${e.startLine}–${e.endLine}`;
    const removing = e.replacement === "";
    return {
      label,
      insert: insert || removing,
      text: removing ? "− removed" : insert ? `+ ${first(e.replacement)}` : first(e.replacement),
    };
  });
}

export type BeginResult = { ok: true; id: number } | { ok: false; reason: string };

/**
 * Write `edits` into the console of `tabId` and start a review. The edit is one history entry,
 * so Mod+Z right after Keep all undoes it whole.
 */
export function beginReview(tabId: string, edits: LineEdit[], summary: string): BeginResult {
  const view = getView(tabId);
  if (!view) return { ok: false, reason: "The console isn't open" };
  // A second edit while the first is pending: keep the first and review the new one.
  if (hasPendingReview(tabId)) keepAll(tabId);
  const before = view.state.doc.toString();
  const lines = view.state.doc.lines;
  for (const e of edits) {
    if (e.startLine < 1 || e.startLine > lines + 1 || e.endLine > lines) {
      return { ok: false, reason: "The edit no longer fits the console text" };
    }
  }
  const id = nextId++;
  const { added, removed } = editStats(before, edits);
  useReview.setState((s) => {
    const info: ReviewInfo = {
      id,
      active: true,
      summary,
      total: 0,
      kept: 0,
      undone: 0,
      hunks: [],
      current: 0,
      added,
      removed,
      lines: cardLines(edits),
    };
    return { byTab: { ...s.byTab, [tabId]: info }, results: { ...s.results, [id]: info } };
  });
  view.dispatch({
    effects: reviewCompartment.reconfigure([
      unifiedMergeView({
        original: before,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        mergeControls: (type, action) => button(type, action, tabId),
      }),
      reviewTheme,
      followUserEdits,
      EditorView.updateListener.of((u) => {
        if (u.docChanged || u.transactions.some((t) => t.effects.length > 0)) {
          publish(tabId, u.state);
        }
      }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => (hasPendingReview(tabId) ? (keepAll(tabId), true) : false),
          },
          {
            key: "Mod-Backspace",
            run: () => (hasPendingReview(tabId) ? (undoAll(tabId), true) : false),
          },
        ]),
      ),
    ]),
  });
  view.dispatch({
    changes: lineEditChanges(before, edits),
    annotations: Transaction.userEvent.of("input.ai"),
    scrollIntoView: true,
  });
  patch(tabId, (r) => ({ total: r.hunks.length }));
  if (getChunks(view.state)?.chunks.length === 0) {
    finish(tabId);
  }
  return { ok: true, id };
}

/** Keep every pending hunk. The text stays as it is. */
export function keepAll(tabId: string) {
  const r = useReview.getState().byTab[tabId];
  if (!r?.active) return;
  patch(tabId, (cur) => ({ kept: cur.kept + cur.hunks.length, hunks: [], active: false }));
  getView(tabId)?.dispatch({ effects: reviewCompartment.reconfigure([]) });
}

/** Put back the text from before the edit, in one step. */
export function undoAll(tabId: string) {
  const view = getView(tabId);
  const r = useReview.getState().byTab[tabId];
  if (!view || !r?.active) return;
  const original = getOriginalDoc(view.state).toString();
  patch(tabId, (cur) => ({ undone: cur.undone + cur.hunks.length, hunks: [], active: false }));
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: original },
    effects: reviewCompartment.reconfigure([]),
    annotations: Transaction.userEvent.of("undo.ai"),
  });
}

export function keepHunk(tabId: string, index: number) {
  const view = getView(tabId);
  const h = useReview.getState().byTab[tabId]?.hunks[index];
  if (!view || !h) return;
  patch(tabId, (r) => ({ kept: r.kept + 1 }));
  acceptChunk(view, h.from);
}

export function undoHunk(tabId: string, index: number) {
  const view = getView(tabId);
  const h = useReview.getState().byTab[tabId]?.hunks[index];
  if (!view || !h) return;
  patch(tabId, (r) => ({ undone: r.undone + 1 }));
  rejectChunk(view, h.from);
}

/** Move the bar (and the selection) to another hunk; wraps around. */
export function goToHunk(tabId: string, delta: 1 | -1) {
  const view = getView(tabId);
  const r = useReview.getState().byTab[tabId];
  if (!view || !r || r.hunks.length === 0) return;
  const next = (r.current + delta + r.hunks.length) % r.hunks.length;
  patch(tabId, () => ({ current: next }));
  view.dispatch({
    selection: { anchor: r.hunks[next].from },
    effects: EditorView.scrollIntoView(r.hunks[next].from, { y: "center" }),
  });
}

/** Scroll to the first hunk (the card's "Jump to changes"). */
export function jumpToChanges(tabId: string) {
  const view = getView(tabId);
  const r = useReview.getState().byTab[tabId];
  if (!view || !r?.hunks.length) return;
  patch(tabId, () => ({ current: 0 }));
  view.dispatch({
    selection: { anchor: r.hunks[0].from },
    effects: EditorView.scrollIntoView(r.hunks[0].from, { y: "center" }),
  });
  view.focus();
}

/** Forget a console's review (the console closed). */
export function dropReview(tabId: string) {
  useReview.setState((s) => {
    const rest = { ...s.byTab };
    delete rest[tabId];
    return { byTab: rest };
  });
}

/** The text the edits would produce, without touching any editor. */
export const previewEdits = applyLineEdits;
