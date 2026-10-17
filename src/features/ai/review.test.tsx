import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPlatformForTests } from "../../lib/platform";
import { registerView } from "../console/editor/views";
import type { LineEdit } from "./api";
import { ReviewBar } from "./ReviewBar";
import {
  beginReview,
  hasPendingReview,
  keepAll,
  keepHunk,
  reviewSlot,
  undoAll,
  undoHunk,
  useReview,
} from "./review";

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
});

const TAB = "t1";
const SQL = [
  "-- late orders",
  "SELECT o.id, o.carrier,",
  "       o.shipped_at - o.created_at AS delay",
  "FROM orders o",
  "WHERE o.shipped_at > o.created_at",
].join("\n");

const FIX: LineEdit[] = [
  {
    startLine: 2,
    endLine: 3,
    replacement: "SELECT o.id, s.carrier,\n       s.shipped_at - o.created_at AS delay",
  },
  {
    startLine: 5,
    endLine: 5,
    replacement: "JOIN shipments s ON s.order_id = o.id\nWHERE s.shipped_at > o.created_at",
  },
];

let view: EditorView;
let host: HTMLDivElement;
let off: () => void;

beforeEach(() => {
  setPlatformForTests("mac");
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({ doc: SQL, extensions: [history(), reviewSlot] }),
    parent: host,
  });
  off = registerView(TAB, view);
  useReview.setState({ byTab: {}, results: {} });
});
afterEach(() => {
  off();
  view.destroy();
  host.remove();
});

const text = () => view.state.doc.toString();
const info = () => useReview.getState().byTab[TAB];

describe("direct edits with review (spec: ai-assistant › Direct edits with review)", () => {
  /** (spec: ai-assistant › Fix applied as a diff) */
  it("writes the edit into the editor as pending hunks and runs nothing", () => {
    const r = beginReview(TAB, FIX, "joined shipments");
    expect(r.ok).toBe(true);
    expect(text()).toContain("s.carrier");
    expect(text()).toContain("JOIN shipments s ON s.order_id = o.id");
    expect(hasPendingReview(TAB)).toBe(true);
    expect(info().hunks.length).toBe(2);
    expect(info().total).toBe(2);
    expect(info().summary).toBe("joined shipments");
    expect(info().added).toBeGreaterThan(0);
    expect(info().removed).toBeGreaterThan(0);
    // The diff is drawn: deleted lines as widgets, inserted ones with a line class.
    expect(host.querySelector(".cm-deletedChunk")).not.toBeNull();
    expect(host.querySelectorAll(".cm-changedLine, .cm-inlineChangedLine").length).toBeGreaterThan(
      0,
    );
  });

  it("shows Keep and Undo on every hunk", () => {
    beginReview(TAB, FIX, "");
    const keep = host.querySelectorAll<HTMLButtonElement>('button[name="accept"]');
    const undo = host.querySelectorAll<HTMLButtonElement>('button[name="reject"]');
    expect(keep.length).toBe(2);
    expect([...keep].map((b) => b.textContent)).toEqual(["Keep", "Keep"]);
    expect([...undo].map((b) => b.textContent)).toEqual(["Undo", "Undo"]);
  });

  /** (spec: ai-assistant › Keep one, undo another) */
  it("keeps one hunk and undoes another, counting both", () => {
    beginReview(TAB, FIX, "");
    keepHunk(TAB, 0);
    expect(info().hunks.length).toBe(1);
    undoHunk(TAB, 0);
    expect(text()).toContain("s.carrier"); // hunk 1 kept
    expect(text()).not.toContain("JOIN shipments"); // hunk 2 undone
    expect(text()).toContain("WHERE o.shipped_at > o.created_at");
    const done =
      useReview.getState().results[info()?.id ?? 0] ??
      Object.values(useReview.getState().results)[0];
    expect([done.kept, done.undone]).toEqual([1, 1]);
    expect(done.active).toBe(false);
  });

  it("Keep all leaves the new text and ends the review", () => {
    beginReview(TAB, FIX, "");
    const edited = text();
    keepAll(TAB);
    expect(text()).toBe(edited);
    expect(hasPendingReview(TAB)).toBe(false);
    expect(host.querySelector(".cm-deletedChunk")).toBeNull();
  });

  it("Undo all restores the original text in one step", () => {
    beginReview(TAB, FIX, "");
    undoAll(TAB);
    expect(text()).toBe(SQL);
    expect(hasPendingReview(TAB)).toBe(false);
  });

  /** (spec: ai-assistant › Undo after keep) */
  it("Mod+Z after Keep all undoes the whole edit at once", () => {
    beginReview(TAB, FIX, "");
    keepAll(TAB);
    expect(text()).not.toBe(SQL);
    undo(view);
    expect(text()).toBe(SQL);
  });

  /** (spec: ai-assistant › User types during review) */
  it("keeps the hunks pending when the user edits elsewhere", () => {
    beginReview(TAB, FIX, "");
    view.dispatch({ changes: { from: 0, to: 0, insert: "-- note\n" } });
    expect(hasPendingReview(TAB)).toBe(true);
    expect(info().hunks.length).toBe(2);
    expect(text().startsWith("-- note\n-- late orders")).toBe(true);
  });

  it("refuses an edit that no longer fits the text", () => {
    const r = beginReview(TAB, [{ startLine: 9, endLine: 9, replacement: "x" }], "");
    expect(r).toEqual({ ok: false, reason: "The edit no longer fits the console text" });
    expect(text()).toBe(SQL);
  });

  it("a second edit keeps the first and reviews the new one", () => {
    beginReview(TAB, [FIX[0]], "");
    const first = text();
    beginReview(TAB, [{ startLine: 1, endLine: 1, replacement: "-- late shipments" }], "");
    expect(text().startsWith("-- late shipments")).toBe(true);
    expect(text()).toContain("s.carrier");
    expect(first).toContain("s.carrier");
    expect(info().hunks.length).toBe(1);
  });
});

describe("review bar", () => {
  it("shows the hunk count, +/− and the actions, and Keep all ends the review", () => {
    render(<ReviewBar tabId={TAB} />);
    expect(screen.queryByRole("toolbar", { name: "Review AI edits" })).toBeNull();
    act(() => void beginReview(TAB, FIX, ""));
    const bar = screen.getByRole("toolbar", { name: "Review AI edits" });
    expect(bar.textContent).toContain("AI edited 2 hunks");
    expect(bar.textContent).toMatch(/\+\d/);
    expect(bar.textContent).toMatch(/−\d/);
    expect(bar.textContent).toContain("1 / 2");
    expect(bar.textContent).toContain("⌘⌫");
    expect(bar.textContent).toContain("⌘↵");
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(bar.textContent).toContain("2 / 2");
    fireEvent.click(screen.getByRole("button", { name: /Keep all/ }));
    expect(screen.queryByRole("toolbar", { name: "Review AI edits" })).toBeNull();
    expect(hasPendingReview(TAB)).toBe(false);
  });

  it("Undo all puts the text back", () => {
    render(<ReviewBar tabId={TAB} />);
    act(() => void beginReview(TAB, FIX, ""));
    fireEvent.click(screen.getByRole("button", { name: /Undo all/ }));
    expect(text()).toBe(SQL);
  });
});
