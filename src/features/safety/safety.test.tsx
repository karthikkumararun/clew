import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { ResultEvent } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { clearSnapshots } from "../console/completion/snapshots";
import { ConsoleToolbar } from "../console/ConsoleToolbar";
import { ConsoleView } from "../console/ConsoleView";
import { registerConsoleTab } from "../console/ConsoleTab";
import { openConsole, registerConsoleCommands, runActive } from "../console/commands";
import { getView } from "../console/editor/views";
import { ConsolePromptHost, clearPrompts } from "../console/prompts";
import { clearRuntimes, getRuntime } from "../console/runtime";
import { TabStrip } from "../../shell/TabStrip";
import { StatusBar } from "../../shell/StatusBar";
import { registerTabStatusItems } from "../../shell/tabStatus";
import { stubLayout } from "../explorer/testing";
import { settleTransactionsBeforeQuit } from "../console/quit";
import { SafetyPromptHost, clearConfirms } from "./confirm";
import type { GuardReport } from "./ipc";
import * as ipc from "./ipc";

const api = vi.hoisted(() => ({
  execute: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("./ipc", () => import("./ipcMock"));
vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: (...a: unknown[]) => api.execute(...a),
  queryCancel: vi.fn(),
  queryFetchMore: vi.fn(),
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

const check = vi.mocked(ipc.safetyCheck);
const readOnlyOf = vi.mocked(ipc.sessionReadOnly);
const setReadOnly = vi.mocked(ipc.setSessionReadOnly);

const prod = {
  ...toConnection({ ...newDraft("postgres"), id: "c1", name: "prod-postgres", host: "h" }),
  environment: "production" as const,
  safeguards: { readOnlyByDefault: true, confirmWrites: true, manualCommit: false },
};

const report = (over: Partial<GuardReport>): GuardReport => ({
  decision: "confirm",
  connection: "prod-postgres",
  environment: "production",
  statements: [],
  token: "tok-1",
  ...over,
});
const UPDATE = "UPDATE orders SET status = 'shipped' WHERE id = 88213";

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

async function mountConsole(sql: string) {
  const id = (await openConsole({ connectionId: "c1", sql }))!;
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
  const runtime = getRuntime(id, "c1");
  render(
    <>
      <ConsoleToolbar />
      <ConsoleView tab={tab as never} />
      <ConsolePromptHost />
      <SafetyPromptHost />
    </>,
  );
  const view = getView(id)!;
  act(() => view.dispatch({ selection: { anchor: 0 } }));
  return { id, runtime };
}
/** Start the run without waiting for it: a confirmation dialog holds it open. */
const run = async () => {
  act(() => void runActive("current"));
  await flushOpen();
};

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearRuntimes();
  clearSnapshots();
  clearPrompts();
  clearConfirms();
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
  api.snapshot.mockResolvedValue({ schemas: [] });
  api.execute.mockImplementation(
    async (_s: string, _r: unknown, send: (e: ResultEvent) => void) => {
      send({
        event: "done",
        result_id: 1,
        summary: { rows_affected: 1, elapsed_ms: 2, has_more: false },
      });
      return null;
    },
  );
  check.mockImplementation(async (_s, sql) =>
    report({ decision: "allow", statements: [{ text: sql, class: "read" }], token: undefined }),
  );
  readOnlyOf.mockResolvedValue(true);
  useConnections.setState({
    file: { version: 1, groups: [], connections: [prod] },
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
  cleanup();
  offTab();
  offCommands();
  restoreLayout();
});

describe("read-only sessions", () => {
  it("blocks a write: nothing is sent and Output offers to switch (spec: production-safeguards › Write in a read-only console)", async () => {
    check.mockResolvedValue(
      report({
        decision: "block",
        token: undefined,
        reason: "This session is read-only",
        statements: [{ text: UPDATE, class: "write" }],
      }),
    );
    const { runtime } = await mountConsole(UPDATE);
    await run();
    expect(api.execute).not.toHaveBeenCalled();
    expect(runtime.store.getState().tab).toBe("output");
    const log = await screen.findByRole("log", { name: "Output" });
    expect(log).toHaveTextContent("Blocked: this session is read-only");
    expect(within(log).getByRole("button", { name: "Switch to read-write" })).toBeInTheDocument();
  });

  it("shows PRODUCTION · READ-ONLY on the toolbar", async () => {
    await mountConsole("select 1");
    await flushOpen();
    expect(
      await screen.findByRole("button", { name: "PRODUCTION · READ-ONLY" }),
    ).toBeInTheDocument();
  });

  it("switches only this session to read-write after confirmation (spec: production-safeguards › Toggle)", async () => {
    const { runtime } = await mountConsole("select 1");
    await run();
    fireEvent.click(await screen.findByRole("button", { name: "PRODUCTION · READ-ONLY" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Switch this session to read-write" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Other tabs stay read-only");
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch to read-write" }));
    await waitFor(() => expect(setReadOnly).toHaveBeenCalledWith("s1", false));
    expect(
      await screen.findByRole("button", { name: "PRODUCTION · READ-WRITE" }),
    ).toBeInTheDocument();
    expect(runtime.store.getState().readOnly).toBe(false);
  });

  it("stays read-only when the switch is cancelled", async () => {
    await mountConsole("select 1");
    await run();
    fireEvent.click(await screen.findByRole("button", { name: "PRODUCTION · READ-ONLY" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Switch this session to read-write" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(setReadOnly).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "PRODUCTION · READ-ONLY" })).toBeInTheDocument();
  });

  it("the Output action switches the session too", async () => {
    check.mockResolvedValue(
      report({
        decision: "block",
        token: undefined,
        statements: [{ text: UPDATE, class: "write" }],
      }),
    );
    const { runtime } = await mountConsole(UPDATE);
    await run();
    const log = await screen.findByRole("log", { name: "Output" });
    fireEvent.click(within(log).getByRole("button", { name: "Switch to read-write" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Switch to read-write",
      }),
    );
    await waitFor(() => expect(runtime.store.getState().readOnly).toBe(false));
    expect(setReadOnly).toHaveBeenCalledWith("s1", false);
  });
});

async function flushOpen() {
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}

describe("confirm writes", () => {
  const confirm = () =>
    report({
      statements: [{ text: UPDATE, class: "write", estimate: 1 }],
    });

  it("lists the connection, the statement and the estimate; Cancel is the default (spec: production-safeguards › Confirm a write)", async () => {
    readOnlyOf.mockResolvedValue(false);
    check.mockResolvedValue(confirm());
    await mountConsole(UPDATE);
    await run();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("prod-postgres · Production");
    expect(within(dialog).getByRole("list", { name: "Statements" })).toHaveTextContent(UPDATE);
    expect(dialog).toHaveTextContent("≈1 row");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("runs the statement with the token only after Confirm (spec: production-safeguards › Confirm a write)", async () => {
    readOnlyOf.mockResolvedValue(false);
    check.mockResolvedValue(confirm());
    await mountConsole(UPDATE);
    await run();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }),
    );
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
    const call = api.execute.mock.calls[0];
    expect(call[1].sql).toBe(UPDATE);
    expect(call[3]).toBe("tok-1");
  });

  it("does not run when cancelled and says so in Output", async () => {
    readOnlyOf.mockResolvedValue(false);
    check.mockResolvedValue(confirm());
    const { runtime } = await mountConsole(UPDATE);
    await run();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(runtime.store.getState().output.slice(-1)[0]?.kind).toBe("cancelled"),
    );
    expect(api.execute).not.toHaveBeenCalled();
    expect(runtime.store.getState().busy).toBe(false);
  });

  it("sends reads straight through", async () => {
    readOnlyOf.mockResolvedValue(false);
    await mountConsole("select 1");
    await run();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.execute.mock.calls[0]).toHaveLength(3);
  });
});

describe("dangerous statements", () => {
  const danger = (decision: "typed_confirm" | "confirm") =>
    report({
      decision,
      typed: decision === "typed_confirm" ? "prod-postgres" : undefined,
      statements: [
        { text: "DELETE FROM orders", class: "write", danger: "Delete every row in orders?" },
      ],
    });

  it("requires typing the connection name on production (spec: production-safeguards › DELETE without WHERE on production)", async () => {
    readOnlyOf.mockResolvedValue(false);
    check.mockResolvedValue(danger("typed_confirm"));
    await mountConsole("DELETE FROM orders");
    await run();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete every row in orders?");
    const go = within(dialog).getByRole("button", { name: "Run" });
    expect(go).toBeDisabled();
    const input = within(dialog).getByLabelText("Connection name");
    fireEvent.change(input, { target: { value: "prod-postgre" } });
    expect(go).toBeDisabled();
    fireEvent.change(input, { target: { value: "prod-postgres" } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
    expect(api.execute.mock.calls[0][3]).toBe("tok-1");
  });

  it("only warns elsewhere, with Cancel as the default (spec: production-safeguards › Same statement on local)", async () => {
    readOnlyOf.mockResolvedValue(false);
    check.mockResolvedValue({ ...danger("confirm"), environment: "local", connection: "local-db" });
    await mountConsole("DELETE FROM orders");
    await run();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete every row in orders?");
    expect(within(dialog).queryByLabelText("Connection name")).toBeNull();
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
  });
});

describe("explain analyze", () => {
  it("goes through the guard and passes its token", async () => {
    readOnlyOf.mockResolvedValue(false);
    check.mockResolvedValue(report({ statements: [{ text: UPDATE, class: "write" }] }));
    api.execute.mockImplementation(
      async (_s: string, _r: unknown, send: (e: ResultEvent) => void) => {
        send({
          event: "done",
          result_id: 1,
          summary: { rows_affected: null, elapsed_ms: 1, has_more: false },
        });
        return null;
      },
    );
    const { runtime } = await mountConsole(UPDATE);
    act(() => void runtime.explain({ sql: UPDATE, offset: 0, analyze: true }));
    // The guard's dialog is up; answering it lets the plan run.
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", { name: "Confirm" }),
    );
    await waitFor(() => expect(api.execute.mock.calls.some((c) => c[3] === "tok-1")).toBe(true));
  });
});

describe("manual commit", () => {
  it("starts consoles of a manual-commit connection in Manual mode", async () => {
    useConnections.setState({
      file: {
        version: 1,
        groups: [],
        connections: [{ ...prod, safeguards: { ...prod.safeguards, manualCommit: true } }],
      },
    });
    await mountConsole("select 1");
    const tab = useWorkspace.getState().tabs[0];
    expect((tab.state as { txMode: string }).txMode).toBe("manual");
  });

  it("starts consoles of other connections in Auto-commit", async () => {
    await mountConsole("select 1");
    expect((useWorkspace.getState().tabs[0].state as { txMode: string }).txMode).toBe("auto");
  });
});

describe("quitting with an open transaction (spec: production-safeguards › Quit with open transaction)", () => {
  async function withOpenTransaction() {
    const { runtime } = await mountConsole("select 1");
    runtime.store.setState({ sessionId: "s1", txOpen: true, txPending: 2 });
    return runtime;
  }

  it("quits straight away when nothing is open", async () => {
    await mountConsole("select 1");
    expect(await settleTransactionsBeforeQuit()).toBe(true);
  });

  it("asks, and Commit commits before quitting", async () => {
    const runtime = await withOpenTransaction();
    const done = settleTransactionsBeforeQuit();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("prod-postgres");
    expect(dialog).toHaveTextContent("2 statements");
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));
    expect(await done).toBe(true);
    expect(api.execute.mock.calls.some((c) => c[1].sql === "COMMIT")).toBe(true);
    expect(runtime.store.getState().txOpen).toBe(false);
  });

  it("Roll back rolls back before quitting", async () => {
    await withOpenTransaction();
    const done = settleTransactionsBeforeQuit();
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", { name: "Roll back" }),
    );
    expect(await done).toBe(true);
    expect(api.execute.mock.calls.some((c) => c[1].sql === "ROLLBACK")).toBe(true);
  });

  it("Cancel keeps the app open and the transaction as it was", async () => {
    const runtime = await withOpenTransaction();
    const done = settleTransactionsBeforeQuit();
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", { name: "Cancel" }),
    );
    expect(await done).toBe(false);
    expect(runtime.store.getState().txOpen).toBe(true);
    expect(api.execute).not.toHaveBeenCalled();
  });
});

describe("production visibility", () => {
  const staging = { ...prod, id: "c2", name: "staging-pg", environment: "staging" as const };

  it("marks production and staging tabs with different stripes", async () => {
    useConnections.setState({ file: { version: 1, groups: [], connections: [prod, staging] } });
    await openConsole({ connectionId: "c1" });
    await openConsole({ connectionId: "c2" });
    render(<TabStrip />);
    // the stripe is on the wrapper around each tab and its close button
    const tabs = screen.getAllByRole("tab").map((t) => t.parentElement!);
    expect(tabs.map((t) => t.getAttribute("data-env"))).toEqual(["production", "staging"]);
    const stripe = (el: HTMLElement) => el.style.getPropertyValue("--stripe");
    expect(stripe(tabs[0])).toBe("var(--env-prod)");
    expect(stripe(tabs[1])).toBe("var(--env-staging)");
  });

  it("tints the status bar's connection segment on production only", async () => {
    const off = registerTabStatusItems();
    useConnections.setState({
      file: { version: 1, groups: [], connections: [prod, staging] },
      connected: {
        c1: { server: { product: "PostgreSQL", version: "16" }, transport: null },
        c2: { server: { product: "PostgreSQL", version: "16" }, transport: null },
      } as never,
    });
    await openConsole({ connectionId: "c1" });
    const { unmount } = render(<StatusBar />);
    const segment = screen.getByText(/Connected · prod-postgres/);
    expect(segment.closest("[data-env]")).toHaveAttribute("data-env", "production");
    expect(segment).toHaveTextContent("PRODUCTION");
    expect((segment.closest("[data-env]") as HTMLElement).style.background).toContain(
      "--env-prod-badge-bg",
    );
    unmount();
    cleanup();
    await openConsole({ connectionId: "c2" });
    render(<StatusBar />);
    expect(screen.getByText(/Connected · staging-pg/).closest("[data-env]")).toHaveAttribute(
      "data-env",
      "staging",
    );
    expect(screen.queryByText(/PRODUCTION/)).toBeNull();
    off();
  });
});
