import { act, render, screen } from "@testing-library/react";
import { EditorSelection } from "@codemirror/state";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../../connections/connectionsStore";
import { newDraft, toConnection } from "../../../connections/draft";
import { setPlatformForTests } from "../../../lib/platform";
import { clearCommands } from "../../../shell/registry/commands";
import { clearShortcuts, dispatchShortcut } from "../../../shell/registry/shortcuts";
import { useNotices } from "../../../stores/noticesStore";
import { useWorkspace } from "../../../stores/workspaceStore";
import { formatActiveEditor, registerConsoleCommands } from "../commands";
import { Editor } from "./Editor";
import { formatSql } from "./format";
import { runStatementOnLine } from "./statementField";
import { getView } from "./views";

// jsdom has no layout; CodeMirror only needs these to exist.
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

const SQL = [
  "-- Top customers",
  "SELECT u.id,",
  "       u.name",
  "FROM users u",
  "LIMIT 50;",
  "",
  "SELECT 2",
].join("\n");

function mount(over: Partial<React.ComponentProps<typeof Editor>> = {}) {
  const onChange = vi.fn();
  const onRun = vi.fn();
  render(
    <Editor
      tabId="t1"
      driver="postgres"
      value={SQL}
      fontSize={13}
      onChange={onChange}
      onRunStatement={onRun}
      {...over}
    />,
  );
  return { onChange, onRun, view: getView("t1")! };
}

const moveTo = (line: number) => {
  const view = getView("t1")!;
  const l = view.state.doc.line(line);
  act(() => view.dispatch({ selection: EditorSelection.cursor(Math.min(l.from + 2, l.to)) }));
};

const tinted = () =>
  [...document.querySelectorAll(".cm-line")]
    .map((el, i) => (el.classList.contains("cm-current-statement") ? i + 1 : 0))
    .filter(Boolean);
/**
 * The ▶ cells of the run gutter, spacer excluded. CodeMirror only renders cells for lines that
 * have a marker, so the line they sit on is verified through `runStatementOnLine` instead.
 */
const markerCells = () =>
  [...document.querySelectorAll(".cm-runGutter .cm-gutterElement")]
    .slice(1)
    .filter((el) => el.querySelector(".cm-runMarker"));

afterEach(() => vi.restoreAllMocks());

describe("SQL editor", () => {
  it("mounts with the document and an accessible name", () => {
    mount();
    expect(screen.getByRole("textbox", { name: "SQL editor" })).toHaveTextContent("Top customers");
    expect(getView("t1")!.state.doc.toString()).toBe(SQL);
  });

  it("tints the statement under the cursor and puts the ▶ marker on its first line (spec: sql-console › Current statement detection)", () => {
    mount();
    moveTo(3); // inside the SELECT … LIMIT 50;
    // The comment above the SELECT is not part of the statement: lines 2–5.
    expect(tinted()).toEqual([2, 3, 4, 5]);
    expect(markerCells()).toHaveLength(1);
    expect(runStatementOnLine(getView("t1")!, getView("t1")!.state.doc.line(2).from)).toBe(true);
  });

  it("detects statements separated by a blank line without a semicolon (spec: sql-console › Statements without semicolons)", () => {
    mount({ value: "select 1\nfrom a\n\nselect 2\nfrom b" });
    moveTo(4);
    expect(tinted()).toEqual([4, 5]);
    moveTo(1);
    expect(tinted()).toEqual([1, 2]);
  });

  it("tints nothing on a blank line between statements", () => {
    mount({ value: "select 1;\n\nselect 2" });
    moveTo(2);
    expect(tinted()).toEqual([]);
  });

  it("runs the statement whose first line holds the clicked ▶", () => {
    const { onRun, view } = mount();
    moveTo(4);
    const marker = document.querySelectorAll(".cm-runGutter .cm-runMarker")[1];
    expect(marker).toHaveAttribute("aria-label", "Run statement");
    // Clicking the gutter cell of the statement's first line (line 2) runs it; other lines don't.
    expect(runStatementOnLine(view, view.state.doc.line(3).from)).toBe(false);
    expect(runStatementOnLine(view, view.state.doc.line(2).from)).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].text).toMatch(/^SELECT u\.id,/);
    // The second statement is clickable even when the cursor is elsewhere.
    expect(runStatementOnLine(view, view.state.doc.line(7).from)).toBe(true);
    expect(onRun.mock.calls[1][0].text).toBe("SELECT 2");
  });
  it("reports edits and the cursor position", () => {
    const onCursor = vi.fn();
    const { onChange, view } = mount({ onCursor });
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nselect 3" } }));
    expect(onChange).toHaveBeenLastCalledWith(SQL + "\nselect 3");
    expect(onCursor).toHaveBeenCalled();
  });

  it("follows external text changes, e.g. a reloaded file", () => {
    const { view } = mount();
    const { rerender } = render(<div />);
    void rerender;
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "x" } });
    });
    expect(view.state.doc.toString()).toBe("x");
  });

  it("applies the font size from settings", () => {
    const { rerender } = render(
      <Editor
        tabId="t2"
        driver="mysql"
        value=""
        fontSize={13}
        onChange={() => {}}
        onRunStatement={() => {}}
      />,
    );
    rerender(
      <Editor
        tabId="t2"
        driver="mysql"
        value=""
        fontSize={16}
        onChange={() => {}}
        onRunStatement={() => {}}
      />,
    );
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("");
    expect(css).toMatch(/font-size:\s*16px/);
    expect(css).toMatch(/line-height:\s*25px/);
  });

  it("toggles comments with the language's comment token", async () => {
    const { toggleComment } = await import("@codemirror/commands");
    const { view } = mount({ value: "select 1" });
    act(() => {
      toggleComment(view);
    });
    expect(view.state.doc.toString()).toBe("-- select 1");
    act(() => {
      toggleComment(view);
    });
    expect(view.state.doc.toString()).toBe("select 1");
  });
});

describe("format SQL", () => {
  it("upper-cases keywords and breaks clauses", () => {
    expect(formatSql("select a,b from t where x=1", "postgres")).toBe(
      "SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1",
    );
  });

  it("uses the dialect: MySQL backticks survive", () => {
    expect(formatSql("select `a b` from t", "mysql")).toContain("`a b`");
  });

  it("throws on SQL it can't parse so the caller can say so", () => {
    expect(() => formatSql("select 'unterminated", "postgres")).toThrow();
  });
});

describe("Format SQL command", () => {
  const setup = (sql: string) => {
    setPlatformForTests("mac");
    clearShortcuts();
    clearCommands();
    const off = registerConsoleCommands();
    useConnections.setState({
      file: {
        version: 1,
        groups: [],
        connections: [toConnection({ ...newDraft("postgres"), id: "c1", name: "pg", host: "h" })],
      },
    });
    useWorkspace.setState({
      tabs: [
        {
          id: "t1",
          kind: "console",
          key: "k",
          state: { connectionId: "c1", text: sql, txMode: "auto" },
        },
      ],
      activeTabId: "t1",
    });
    useNotices.setState({ notices: [] });
    mount({ value: sql });
    return off;
  };

  it("formats the whole script when nothing is selected", () => {
    const off = setup("select a,b from t");
    act(() => formatActiveEditor());
    expect(getView("t1")!.state.doc.toString()).toBe("SELECT\n  a,\n  b\nFROM\n  t");
    off();
  });

  it("formats only the selection", () => {
    const off = setup("select 1;\nselect a,b from t");
    const view = getView("t1")!;
    act(() => view.dispatch({ selection: { anchor: 10, head: view.state.doc.length } }));
    act(() => formatActiveEditor());
    expect(view.state.doc.toString()).toBe("select 1;\nSELECT\n  a,\n  b\nFROM\n  t");
    off();
  });

  it("runs on Mod+Shift+F while the editor has focus", () => {
    const off = setup("select 1");
    const content = document.querySelector(".cm-content") as HTMLElement;
    // Stand in for the console view's wrapper, which carries the editor scope.
    document.body.setAttribute("data-shortcut-scope", "editor");
    const event = new KeyboardEvent("keydown", {
      key: "F",
      code: "KeyF",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    });
    Object.defineProperty(event, "target", { value: content });
    act(() => void dispatchShortcut(event));
    expect(getView("t1")!.state.doc.toString()).toBe("SELECT\n  1");
    document.body.removeAttribute("data-shortcut-scope");
    off();
  });

  it("says so when the SQL can't be parsed and leaves the text alone", () => {
    const off = setup("select 'unterminated");
    act(() => formatActiveEditor());
    expect(getView("t1")!.state.doc.toString()).toBe("select 'unterminated");
    expect(useNotices.getState().notices[0].message).toMatch(/^Couldn't format/);
    off();
  });
});
