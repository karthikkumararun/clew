import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { ExecSummary, ResultEvent, Value } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { stubLayout } from "../explorer/testing";
import { ConsolePromptHost, clearPrompts } from "./prompts";
import { clearSnapshots, loadSnapshot } from "./completion/snapshots";
import { ConsoleToolbar } from "./ConsoleToolbar";
import { ConsoleView } from "./ConsoleView";
import { registerConsoleTab } from "./ConsoleTab";
import { openConsole, registerConsoleCommands } from "./commands";
import { getView } from "./editor/views";
import { clearRuntimes, getRuntime } from "./runtime";
import type { ConsoleState } from "./state";

const api = vi.hoisted(() => ({
  execute: vi.fn(),
  cancel: vi.fn(),
  fetchMore: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: (...a: unknown[]) => api.execute(...a),
  queryCancel: (...a: unknown[]) => api.cancel(...a),
  queryFetchMore: (...a: unknown[]) => api.fetchMore(...a),
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  completionSnapshot: (...a: unknown[]) => api.snapshot(...a),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("../grid/ResultGrid", async () => {
  const { FakeResultGrid } = await import("../grid/testing");
  return { ResultGrid: FakeResultGrid, autoWidth: () => 100 };
});
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));

const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s });
const summary = (over: Partial<ExecSummary> = {}): ExecSummary => ({
  rows_affected: null,
  elapsed_ms: 5,
  has_more: false,
  ...over,
});

type Send = (e: ResultEvent) => void;
/** A result set as the driver streams it. */
function rowsResult(send: Send, id: number, statement: number, rows: Value[][], more = false) {
  send({
    event: "columns",
    result_id: id,
    statement,
    columns: [
      { name: "id", type_name: "int8", kind: "int", nullable: false },
      { name: "name", type_name: "text", kind: "text", nullable: true },
    ],
  });
  send({ event: "rows", result_id: id, rows });
  send({ event: "done", result_id: id, summary: summary({ has_more: more }) });
}

const conn = toConnection({ ...newDraft("postgres"), id: "c1", name: "pg", host: "h" });
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

let restoreLayout: () => void = () => {};
let offTab: () => void = () => {};
let offCommands: () => void = () => {};

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

async function mountConsole(sql: string, cursorAt?: number) {
  const id = (await openConsole({ connectionId: "c1", sql }))!;
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
  render(
    <>
      <ConsoleToolbar />
      <ConsoleView tab={tab as never} />
      <ConsolePromptHost />
    </>,
  );
  const view = getView(id)!;
  if (cursorAt !== undefined) act(() => view.dispatch({ selection: { anchor: cursorAt } }));
  return { id, view, runtime: getRuntime(id, "c1") };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearRuntimes();
  clearSnapshots();
  clearPrompts();
  setPlatformForTests("mac");
  restoreLayout = stubLayout();
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "PostgreSQL", version: "16" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue(undefined);
  api.snapshot.mockResolvedValue({ schemas: [] });
  api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
    rowsResult(send, 1, 0, [[int(1), text("Ada")]]);
    return null;
  });
  useConnections.setState({
    file: { version: 1, groups: [], connections: [conn] },
    connected: {},
    busy: {},
    connect: vi.fn(async (id: string) => {
      useConnections.setState((s) => ({ connected: { ...s.connected, [id]: {} as never } }));
      return true;
    }),
  });
  offTab = registerConsoleTab();
  offCommands = registerConsoleCommands();
});
afterEach(() => {
  offTab();
  offCommands();
  restoreLayout();
});

const SQL = "select 1;\n\nselect id, name\nfrom users;\n\nselect 3";

describe("run modes", () => {
  it("runs only the statement under the cursor and shows its rows", async () => {
    const { runtime } = await mountConsole(SQL, SQL.indexOf("from users"));
    await act(async () => void (await runCommand("console.run")));
    expect(api.execute).toHaveBeenCalledTimes(1);
    const [sessionId, request] = api.execute.mock.calls[0];
    expect(sessionId).toBe("s1");
    expect(request).toMatchObject({ sql: "select id, name\nfrom users", script: false });
    await screen.findByRole("grid");
    expect(screen.getByRole("tab", { name: /^Result/ })).toHaveTextContent("Result · 1 row · 5 ms");
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("1–1 of 1")).toBeInTheDocument();
    expect(runtime.store.getState().tab).toBe("result");
  });

  it("runs the selection when text is selected", async () => {
    const { view } = await mountConsole(SQL);
    act(() => view.dispatch({ selection: { anchor: 0, head: 8 } }));
    await act(async () => void (await runCommand("console.run")));
    expect(api.execute.mock.calls[0][1]).toMatchObject({ sql: "select 1", script: false });
  });

  it("runs a multi-statement selection as a script", async () => {
    const { view } = await mountConsole(SQL);
    act(() => view.dispatch({ selection: { anchor: 0, head: 9 + 2 + 11 } }));
    await act(async () => void (await runCommand("console.run")));
    expect(api.execute.mock.calls[0][1].script).toBe(true);
  });

  it("runs the whole script and shows every result set as a sub-tab", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      rowsResult(send, 1, 0, [[int(1), text("a")]]);
      rowsResult(send, 2, 1, [[int(2), text("b")]]);
      rowsResult(send, 3, 2, [[int(3), text("c")]]);
      return null;
    });
    const { runtime } = await mountConsole(SQL, 0);
    await act(async () => void (await runCommand("console.runScript")));
    expect(api.execute.mock.calls[0][1]).toMatchObject({ sql: SQL, script: true });
    const subTabs = await screen.findAllByRole("tab", { name: /^Result \d$/ });
    expect(subTabs.map((t) => t.textContent)).toEqual(["Result 1", "Result 2", "Result 3"]);
    fireEvent.click(subTabs[1]);
    expect(await screen.findByText("b")).toBeInTheDocument();

    // The Output log lists every statement with its timing.
    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    const log = within(screen.getByRole("log", { name: "Output" }));
    expect(log.getByText("select 1;".replace(";", ""))).toBeInTheDocument();
    expect(log.getAllByText(/1 row · 5 ms/)).toHaveLength(3);
    expect(runtime.store.getState().output).toHaveLength(3);
  });

  it("shows Output for a statement without rows", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      send({ event: "done", result_id: 1, summary: summary({ rows_affected: 3, elapsed_ms: 4 }) });
      return null;
    });
    await mountConsole("update t set a = 1", 3);
    await act(async () => void (await runCommand("console.run")));
    expect(await screen.findByText("3 rows affected · 4 ms")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
  });

  it("says so when there is nothing at the cursor", async () => {
    await mountConsole("select 1;\n\nselect 2", 10);
    await act(async () => void (await runCommand("console.run")));
    expect(api.execute).not.toHaveBeenCalled();
    expect(useNotices.getState().notices[0].message).toBe("Nothing to run at the cursor");
  });

  it("clicking the Run button runs the current statement", async () => {
    await mountConsole("select 1", 3);
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
  });
});

describe("cancel and a busy session", () => {
  function hang() {
    let finish: (e?: ResultEvent) => void = () => {};
    api.execute.mockImplementationOnce(
      (_s: string, _r: unknown, send: Send) =>
        new Promise((resolve) => {
          finish = (e) => {
            if (e) send(e);
            resolve(null);
          };
        }),
    );
    return { finish: (e?: ResultEvent) => finish(e) };
  }

  it("turns Run into Cancel with an elapsed timer while running", async () => {
    const run = hang();
    await mountConsole("select pg_sleep(60)", 3);
    act(() => void runCommand("console.run"));
    const cancel = await screen.findByRole("button", { name: /^Cancel/ });
    expect(cancel).toHaveTextContent(/\d\.\d s/);
    expect(screen.getByRole("tab", { name: /Running · \d\.\d s/ })).toBeInTheDocument();
    run.finish({ event: "cancelled", result_id: null });
    expect(await screen.findByRole("button", { name: /^Run/ })).toBeInTheDocument();
  });

  it("cancels on the Cancel button and logs how long it ran", async () => {
    const run = hang();
    await mountConsole("select pg_sleep(60)", 3);
    act(() => void runCommand("console.run"));
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel/ }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("s1"));
    run.finish({ event: "cancelled", result_id: null });
    expect(await screen.findByText(/^Cancelled after \d+(\.\d)? s$/)).toBeInTheDocument();
  });

  it("cancels through the command (Mod+. / Esc bind to it)", async () => {
    const run = hang();
    await mountConsole("select pg_sleep(60)", 3);
    act(() => void runCommand("console.run"));
    await screen.findByRole("button", { name: /^Cancel/ });
    await act(async () => void (await runCommand("console.cancel")));
    expect(api.cancel).toHaveBeenCalledTimes(1);
    run.finish({ event: "cancelled", result_id: null });
    await flush();
  });

  it("asks before running while another query runs, and runs after cancelling", async () => {
    const first = hang();
    await mountConsole("select 1;\n\nselect 2", 3);
    act(() => void runCommand("console.run"));
    await screen.findByRole("button", { name: /^Cancel/ });

    api.cancel.mockImplementationOnce(async () => {
      first.finish({ event: "cancelled", result_id: null });
    });
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      second = runCommand("console.run");
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("A query is still running")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel it and run" }));
    await act(async () => void (await second));
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(2));
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting (and runs nothing) when the user declines", async () => {
    const first = hang();
    await mountConsole("select 1", 3);
    act(() => void runCommand("console.run"));
    await screen.findByRole("button", { name: /^Cancel/ });
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      second = runCommand("console.run");
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep waiting" }));
    await act(async () => void (await second));
    expect(api.cancel).not.toHaveBeenCalled();
    expect(api.execute).toHaveBeenCalledTimes(1);
    first.finish();
    await flush();
  });

  it("keeps running while its tab isn't on screen", async () => {
    const run = hang();
    const { id, runtime } = await mountConsole("select 1", 3);
    act(() => void runCommand("console.run"));
    await waitFor(() => expect(runtime.busy).toBe(true));
    cleanup();
    run.finish();
    await waitFor(() => expect(runtime.busy).toBe(false));
    expect(runtime.results.getSnapshot().status).toBe("done");
    expect(getRuntime(id, "c1")).toBe(runtime);
  });
});

describe("results", () => {
  it("fetches the next page when the end of the loaded rows is in view", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      rowsResult(
        send,
        1,
        0,
        [
          [int(1), text("a")],
          [int(2), text("b")],
        ],
        true,
      );
      return null;
    });
    api.fetchMore.mockImplementation(async (_s: string, _id: number, _n: number, send: Send) => {
      send({ event: "rows", result_id: 1, rows: [[int(3), text("c")]] });
      send({ event: "done", result_id: 1, summary: summary() });
    });
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.run")));
    // The few loaded rows already reach the end of the viewport, so the next page is requested.
    await waitFor(() =>
      expect(api.fetchMore).toHaveBeenCalledWith("s1", 1, 500, expect.any(Function)),
    );
    expect(await screen.findByText("1–3 of 3")).toBeInTheDocument();
    expect(api.fetchMore).toHaveBeenCalledTimes(1);
    expect(screen.getByText("c")).toBeInTheDocument();
  });

  it("shows a growing result as 1–n of n+ while the server has more", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      rowsResult(
        send,
        1,
        0,
        Array.from({ length: 40 }, (_, i) => [int(i), text(`r${i}`)]),
        true,
      );
      return null;
    });
    // Nothing near the end of a 40-row page in a 600px viewport is not true, so hold the fetch.
    api.fetchMore.mockImplementation(() => new Promise(() => {}));
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.run")));
    expect(await screen.findByText("1–40 of 40+")).toBeInTheDocument();
  });

  it("filters loaded rows and transposes", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      rowsResult(send, 1, 0, [
        [int(1), text("Ada")],
        [int(2), text("Grace")],
      ]);
      return null;
    });
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.run")));
    await screen.findByText("Grace");
    fireEvent.click(screen.getByRole("button", { name: "Filter results" }));
    fireEvent.change(screen.getByLabelText("Filter rows"), { target: { value: "gra" } });
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.getByText("1 of 2 match")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter rows"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Transpose" }));
    expect(screen.getByRole("columnheader", { name: /column/ })).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "name" })).toBeInTheDocument();
  });

  it("copies the results as CSV", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      rowsResult(send, 1, 0, [[int(1), text('say "hi", ok')]]);
      return null;
    });
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.run")));
    await screen.findByRole("grid");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Copy as CSV" })));
    expect(writeText).toHaveBeenCalledWith('id,name\r\n1,"say ""hi"", ok"\r\n');
  });

  it("re-runs the last query", async () => {
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.run")));
    await screen.findByRole("grid");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Re-run query" })));
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(2));
    expect(api.execute.mock.calls[1][1]).toMatchObject({ sql: "select 1" });
  });

  it("remembers the splitter position on the tab", async () => {
    const { id } = await mountConsole("select 1");
    const sep = screen.getByRole("separator", { name: "Resize results" });
    expect(sep).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    const s = useWorkspace.getState().tabs.find((t) => t.id === id)!.state as ConsoleState;
    expect(s.resultsHeight).toBe(344);
  });
});

describe("schema changes", () => {
  it("refreshes the completion snapshot after a successful DDL statement", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      send({ event: "done", result_id: 1, summary: summary({ rows_affected: 0 }) });
      return null;
    });
    await loadSnapshot("c1", "");
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    await mountConsole("create table t (id int)", 5);
    await act(async () => void (await runCommand("console.run")));
    await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
  });

  it("leaves the snapshot alone for a SELECT or a failed DDL", async () => {
    await loadSnapshot("c1", "");
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.run")));
    await flush();
    expect(api.snapshot).toHaveBeenCalledTimes(1);

    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      send({
        event: "error",
        result_id: null,
        statement: 0,
        error: { code: "query_failed", message: "no" },
      });
      return null;
    });
    act(() =>
      getView(useWorkspace.getState().tabs[0].id)!.dispatch({
        changes: { from: 0, to: 8, insert: "drop table t" },
      }),
    );
    await act(async () => void (await runCommand("console.run")));
    await flush();
    expect(api.snapshot).toHaveBeenCalledTimes(1);
  });
});
