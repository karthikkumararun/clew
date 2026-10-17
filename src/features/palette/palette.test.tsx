import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, registerCommand } from "../../shell/registry/commands";
import { clearShortcuts, installShortcutListener } from "../../shell/registry/shortcuts";
import { setUiState } from "../../lib/uiState";
import { conn } from "../explorer/testing";
import type { PaletteHit } from "./api";
import { PalettePanel } from "./PalettePanel";
import { usePalette } from "./paletteStore";
import { registerPalette } from "./index";
import { rememberFile } from "./recentFiles";

const api = vi.hoisted(() => ({
  search: vi.fn(),
  stats: vi.fn(),
  recent: vi.fn(),
  scripts: vi.fn(),
}));

vi.mock("./api", () => ({
  paletteSearch: (...a: unknown[]) => api.search(...a),
  paletteStats: () => api.stats(),
  paletteRecentQueries: () => api.recent(),
}));
vi.mock("../explorer/api", () => ({ scriptsList: (...a: unknown[]) => api.scripts(...a) }));
vi.mock("../console/completion/snapshots", () => ({
  loadSnapshot: vi.fn().mockResolvedValue({ schemas: [] }),
  invalidateSnapshots: vi.fn(),
}));

const prod = conn("c1", "prod-postgres", { environment: "production" });
const staging = conn("c2", "staging-mysql", { environment: "staging", driver: "mysql" });

const table = (connectionId: string, name: string, parentLabel: string): PaletteHit => ({
  entry: {
    connectionId,
    database: "analytics",
    kind: "table",
    name,
    parentLabel,
    path: [
      { kind: "schema", name: "public" },
      { kind: "table", name },
    ],
    updatedAt: 1,
  },
  indices: [0, 1, 2],
  score: 1,
});

const HITS = [
  table("c1", "orders", "analytics.public"),
  table("c1", "order_items", "analytics.public"),
  table("c2", "orders", "app"),
];

const calls = { table: vi.fn(), console: vi.fn(), newConn: vi.fn(), script: vi.fn() };
let offPalette: () => void = () => {};
let offKeys: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  setPlatformForTests("mac");
  api.search.mockImplementation(async (q: string) => (q === "ord" ? HITS : []));
  api.stats.mockResolvedValue({ connections: 2, objects: 1204 });
  api.recent.mockResolvedValue([]);
  api.scripts.mockResolvedValue([]);
  useConnections.setState({
    file: { version: 1, groups: [], connections: [prod, staging] },
    connected: { c1: {} as never },
    busy: {},
    connect: vi.fn(async (id: string) => {
      useConnections.setState((s) => ({ connected: { ...s.connected, [id]: {} as never } }));
      return true;
    }),
  });
  registerCommand({ id: "table.open", title: "Open table", category: "Table", run: calls.table });
  registerCommand({
    id: "console.new",
    title: "New console",
    category: "Console",
    shortcut: "Mod+T",
    run: calls.console,
  });
  registerCommand({
    id: "connection.new",
    title: "New connection…",
    category: "Connection",
    run: calls.newConn,
  });
  registerCommand({
    id: "script.open",
    title: "Open script",
    category: "Console",
    run: calls.script,
  });
  setUiState("palette.recentFiles", "[]");
  offPalette = registerPalette();
  offKeys = installShortcutListener();
});
afterEach(() => {
  act(() => usePalette.setState({ open: false, preset: null, scope: "all" }));
  offPalette();
  offKeys();
});

const open = async (opts?: Parameters<ReturnType<typeof usePalette.getState>["show"]>[0]) => {
  act(() => usePalette.getState().show(opts));
  return screen.findByRole("combobox");
};
const type = async (input: HTMLElement, text: string) => {
  fireEvent.change(input, { target: { value: text } });
};
const rows = () => screen.queryAllByRole("option");
const key = (input: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(input, { key: k, code: k, ...init });

describe("Open the palette (spec: command-palette › Open the palette)", () => {
  it("opens with the input focused, then closes on Esc and returns focus (spec: command-palette › Open and close)", async () => {
    render(
      <>
        <button>before</button>
        <PalettePanel />
      </>,
    );
    screen.getByText("before").focus();
    const input = await open();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("before")));
  });

  it("states how many connections and objects it searches", async () => {
    render(<PalettePanel />);
    await open();
    expect(await screen.findByText(/Searching 2 connections · 1,204 objects indexed/)).toBeTruthy();
  });

  it("offers the four scopes and Tab cycles them (spec: command-palette › Scopes)", async () => {
    render(<PalettePanel />);
    const input = await open();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["All", "Objects", "Queries", "Actions"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    key(input, "Tab");
    expect(screen.getByRole("tab", { name: "Objects" }).getAttribute("aria-selected")).toBe("true");
    key(input, "Tab", { shiftKey: true });
    key(input, "Tab", { shiftKey: true });
    expect(screen.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Fuzzy search and Result actions", () => {
  it("lists the matching objects with connection, env and highlighted characters", async () => {
    render(<PalettePanel />);
    const input = await open();
    await type(input, "ord");
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(3));
    const group = screen.getByRole("group", { name: "TABLES & COLLECTIONS" });
    const first = within(group).getAllByRole("option")[0];
    expect(first.textContent).toContain("orders");
    expect(first.textContent).toContain("prod-postgres · analytics.public");
    expect(first.querySelector("span[class*=hl]")?.textContent).toBe("ord");
    expect(within(first).getByRole("img", { name: "production environment" })).toBeTruthy();
    expect(first.textContent).toContain("↵ open data · ⌥↵ console");
  });

  it("moves with Up and Down, wrapping at the ends", async () => {
    render(<PalettePanel />);
    const input = await open();
    await type(input, "ord");
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    const active = () => rows().findIndex((r) => r.getAttribute("aria-selected") === "true");
    expect(active()).toBe(0);
    key(input, "ArrowDown");
    expect(active()).toBe(1);
    key(input, "ArrowUp");
    key(input, "ArrowUp");
    expect(active()).toBe(rows().length - 1);
    expect(input.getAttribute("aria-activedescendant")).toBe(rows()[active()].id);
  });

  it("Enter opens the table in its connection", async () => {
    render(<PalettePanel />);
    const input = await open();
    await type(input, "ord");
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    key(input, "Enter");
    await waitFor(() => expect(calls.table).toHaveBeenCalled());
    expect(calls.table).toHaveBeenCalledWith({
      connectionId: "c1",
      path: HITS[0].entry.path,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Alt+Enter opens a console with a starter query that is not run (spec: command-palette › Open in console)", async () => {
    render(<PalettePanel />);
    const input = await open();
    await type(input, "ord");
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    key(input, "Enter", { altKey: true });
    await waitFor(() => expect(calls.console).toHaveBeenCalled());
    expect(calls.console).toHaveBeenCalledWith({
      connectionId: "c1",
      database: "analytics",
      schema: "public",
      sql: 'SELECT * FROM "public"."orders" LIMIT 100;',
    });
  });

  it("clicking a row picks it", async () => {
    render(<PalettePanel />);
    const input = await open();
    await type(input, "ord");
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    fireEvent.click(rows()[1]);
    await waitFor(() => expect(calls.table).toHaveBeenCalled());
    expect(calls.table.mock.calls[0][0].path[1].name).toBe("order_items");
  });

  it("connects a disconnected connection before opening its table (spec: command-palette › Disconnected connection)", async () => {
    render(<PalettePanel />);
    const input = await open();
    await type(input, "ord");
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    const staged = rows().find((r) => r.textContent?.includes("staging-mysql"))!;
    fireEvent.click(staged);
    await waitFor(() => expect(calls.table).toHaveBeenCalled());
    expect(useConnections.getState().connect).toHaveBeenCalledWith("c2");
    expect(calls.table.mock.calls[0][0].connectionId).toBe("c2");
  });

  it("opens nothing when the connection can't be reached", async () => {
    useConnections.setState({ connect: vi.fn(async () => false) });
    render(<PalettePanel />);
    const input = await open();
    await type(input, "ord");
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    fireEvent.click(rows().find((r) => r.textContent?.includes("staging-mysql"))!);
    await waitFor(() => expect(useConnections.getState().connect).toHaveBeenCalled());
    expect(calls.table).not.toHaveBeenCalled();
  });
});

describe("Empty query (spec: command-palette › Empty query)", () => {
  it("lists recent tables, recent statements and actions, capped per section", async () => {
    api.search.mockResolvedValue(HITS);
    api.recent.mockResolvedValue([
      {
        id: 1,
        connectionId: "c1",
        database: "analytics",
        sql: "SELECT 1",
        startedAt: Date.now() - 60_000,
        durationMs: 1,
        rows: 1,
        outcome: "ok",
      },
    ]);
    render(<PalettePanel />);
    await open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    expect(screen.getByRole("group", { name: "TABLES & COLLECTIONS" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "SAVED & RECENT QUERIES" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "ACTIONS" })).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "ACTIONS" })).getAllByRole("option").length,
    ).toBeLessThanOrEqual(6);
  });

  it("shows only one kind on its own scope", async () => {
    api.search.mockResolvedValue(HITS);
    render(<PalettePanel />);
    await open({ scope: "objects" });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole("group", { name: "ACTIONS" })).toBeNull();
  });
});

describe("Actions from the command registry", () => {
  it("finds a command by title, shows its shortcut and runs it on Enter (spec: command-palette › Run an action)", async () => {
    render(<PalettePanel />);
    const input = await open({ scope: "actions" });
    await type(input, "new conn");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toContain("New connection…");
    key(input, "Enter");
    await waitFor(() => expect(calls.newConn).toHaveBeenCalled());
  });

  it("shows the shortcut of a command", async () => {
    render(<PalettePanel />);
    const input = await open({ scope: "actions" });
    await type(input, "new console");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].querySelector("kbd")?.textContent).toBe("⌘T");
  });

  it("leaves out commands that need an argument, and the palette's own", async () => {
    render(<PalettePanel />);
    await open({ scope: "actions" });
    const labels = rows().map((r) => r.textContent ?? "");
    expect(labels.some((l) => l.includes("Open table"))).toBe(false);
    expect(labels.some((l) => l.includes("Go to anything"))).toBe(false);
    expect(labels.some((l) => l.includes("Refresh object index"))).toBe(true);
  });
});

describe("Nothing found", () => {
  it("says so and offers to refresh the index when a connection is disconnected (spec: command-palette › Nothing found)", async () => {
    render(<PalettePanel />);
    const input = await open();
    await type(input, "zzzz");
    expect(await screen.findByText("No matches")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh index" })).toBeTruthy();
  });

  it("doesn't offer a refresh when every connection is connected", async () => {
    useConnections.setState({ connected: { c1: {} as never, c2: {} as never } });
    render(<PalettePanel />);
    const input = await open({ scope: "objects" });
    await type(input, "zzzz");
    expect(await screen.findByText("No matches")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh index" })).toBeNull();
  });
});

describe("Recent files and queries (spec: command-palette › Recent files and queries)", () => {
  it("Mod+E opens the palette on recent files and saved queries, newest first (spec: command-palette › Recent files)", async () => {
    rememberFile({ path: "/s/old.sql", connectionId: "c1" }, 1_000);
    rememberFile({ path: "/s/new.sql", connectionId: "c1" }, 2_000);
    api.scripts.mockImplementation(async (id: string) =>
      id === "c1" ? [{ name: "saved.sql", relPath: "saved.sql", path: "/s/saved.sql" }] : [],
    );
    render(<PalettePanel />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "e", code: "KeyE", metaKey: true });
    });
    await screen.findByRole("combobox");
    await waitFor(() =>
      expect(rows().map((r) => r.textContent?.split("prod-postgres")[0])).toEqual([
        "new.sql",
        "old.sql",
        "saved.sql",
      ]),
    );
    expect(screen.getByRole("group", { name: "RECENT FILES & SAVED QUERIES" })).toBeTruthy();
    expect(api.search).not.toHaveBeenCalled();
  });

  it("opens a recent file in its connection", async () => {
    rememberFile({ path: "/s/new.sql", connectionId: "c1" }, 2_000);
    render(<PalettePanel />);
    const input = await open({ scope: "queries", preset: "recent" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    key(input, "Enter");
    await waitFor(() => expect(calls.script).toHaveBeenCalled());
    expect(calls.script).toHaveBeenCalledWith({ connectionId: "c1", path: "/s/new.sql" });
  });
});

describe("Shortcuts", () => {
  it("Mod+K opens the palette from anywhere", async () => {
    render(<PalettePanel />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });
});
