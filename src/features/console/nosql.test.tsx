import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { ResultEvent } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { stubLayout } from "../explorer/testing";
import { clearSnapshots } from "./completion/snapshots";
import { MONGO_METHODS, REDIS_COMMANDS, mongoOptions } from "./completion/nosql";
import { registerConsoleTab } from "./ConsoleTab";
import { ConsoleView } from "./ConsoleView";
import { openConsole, registerConsoleCommands } from "./commands";
import { dialectLabel, isNoSql, splitDialect, supportsTransactions } from "./editor/dialects";
import { getView } from "./editor/views";
import { splitStatements } from "./editor/statements";
import { ConsolePromptHost, clearPrompts } from "./prompts";
import { clearRuntimes } from "./runtime";

const api = vi.hoisted(() => ({ execute: vi.fn(), sessionOpen: vi.fn(), sessionClose: vi.fn() }));
vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: (...a: unknown[]) => api.execute(...a),
  queryCancel: vi.fn(),
  queryFetchMore: vi.fn(),
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  completionSnapshot: vi.fn().mockResolvedValue({ schemas: [] }),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("../grid/ResultGrid", async () => {
  const { FakeResultGrid } = await import("../grid/testing");
  return { ResultGrid: FakeResultGrid, autoWidth: () => 100 };
});
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));

describe("the command languages", () => {
  it("Redis runs one command per line and skips comments", () => {
    const text = "# warm up\nSET a 1\n\n  GET a  \n";
    expect(splitStatements(text, "lines").map((s) => s.text)).toEqual(["SET a 1", "GET a"]);
    const [, get] = splitStatements(text, "lines");
    expect(text.slice(get.from, get.to)).toBe("GET a");
    expect(splitDialect("redis")).toBe("lines");
  });

  it("Mongo and Redis are not SQL", () => {
    expect(isNoSql("mongodb") && isNoSql("redis") && !isNoSql("postgres")).toBe(true);
    expect(supportsTransactions("redis") || supportsTransactions("mongodb")).toBe(false);
    expect(supportsTransactions("postgres")).toBe(true);
    expect(dialectLabel("mongodb")).toBe("MongoDB shell");
    expect(dialectLabel("redis")).toBe("Redis commands");
  });
});

describe("completion", () => {
  const labels = (r: ReturnType<typeof mongoOptions>) => r?.options.map((o) => o.label) ?? [];

  it("offers the collections after db.", () => {
    const r = mongoOptions("db.ev", ["events", "users"]);
    expect(labels(r)).toContain("events");
    expect(labels(r)).toContain("getCollection");
    expect(r?.from).toBe(3);
  });

  it("offers the supported methods after db.<collection>.", () => {
    const r = mongoOptions("db.events.fi", ["events"]);
    expect(labels(r)).toEqual(MONGO_METHODS);
    expect(r?.from).toBe("db.events.".length);
  });

  it("offers cursor modifiers after a call, and show targets", () => {
    expect(labels(mongoOptions("db.events.find({}).so", []))).toContain("sort");
    expect(labels(mongoOptions("show c", []))).toEqual(["collections", "dbs"]);
    expect(labels(mongoOptions("", []))).toEqual(["db", "show", "use"]);
    expect(mongoOptions("db.events.find({ a: ", [])).toBeNull();
  });

  it("knows Redis command names", () => {
    for (const c of ["GET", "HGETALL", "ZADD", "XADD", "FLUSHDB", "SCAN"]) {
      expect(REDIS_COMMANDS).toContain(c);
    }
  });
});

// ---- results ---------------------------------------------------------------------------------------

const mongo = toConnection({ ...newDraft("mongodb"), id: "m1", name: "dev-mongo" });
const redis = toConnection({ ...newDraft("redis"), id: "r1", name: "cache" });

const oid = { $oid: "6703f1c2a9e41d7c2e0fb812" };
const DOCS = [
  { _id: oid, type: "checkout", user: { id: { $numberInt: "7" } } },
  { _id: { $oid: "6703ee09a9e41d7c2e0fa771" }, type: "view" },
];

type Send = (e: ResultEvent) => void;

function mongoResult() {
  api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
    send({
      event: "columns",
      result_id: 1,
      statement: 0,
      columns: [
        { name: "_id", type_name: "objectId", kind: "text", nullable: true },
        { name: "type", type_name: "string", kind: "text", nullable: true },
      ],
    });
    send({
      event: "rows",
      result_id: 1,
      rows: [
        [
          { kind: "text", value: "6703f1c2a9e41d7c2e0fb812" },
          { kind: "text", value: "checkout" },
        ],
        [
          { kind: "text", value: "6703ee09a9e41d7c2e0fa771" },
          { kind: "text", value: "view" },
        ],
      ],
    });
    send({ event: "documents", result_id: 1, docs: DOCS });
    send({
      event: "done",
      result_id: 1,
      summary: { rows_affected: null, elapsed_ms: 4, has_more: false },
    });
    return null;
  });
}

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

let restoreLayout: () => void = () => {};
let offTab: () => void = () => {};
let offCommands: () => void = () => {};

async function runIn(connectionId: string, text: string) {
  const id = (await openConsole({ connectionId, sql: text }))!;
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
  render(
    <>
      <ConsoleView tab={tab as never} />
      <ConsolePromptHost />
    </>,
  );
  act(() => getView(id)!.dispatch({ selection: { anchor: 3 } }));
  await act(async () => void (await runCommand("console.run")));
  return id;
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
    server: { product: "MongoDB", version: "8.0.1" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  useConnections.setState({
    file: { version: 1, groups: [], connections: [mongo, redis] },
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

describe("a MongoDB console", () => {
  it("shows documents as a tree first, and switches to table and JSON", async () => {
    mongoResult();
    await runIn("m1", "db.events.find({})");
    // the statement went to the driver as typed
    expect(api.execute.mock.calls[0][1]).toMatchObject({ sql: "db.events.find({})" });
    expect(await screen.findByText(/^\(1\) ObjectId\(/)).toBeInTheDocument();
    expect(screen.getByText(/^\(2\) ObjectId\(/)).toBeInTheDocument();

    const modes = screen.getByRole("tablist", { name: "Document view mode" });
    fireEvent.click(within(modes).getByRole("tab", { name: "JSON" }));
    expect(screen.getAllByText(/_id: ObjectId\("/).length).toBe(2);

    fireEvent.click(within(modes).getByRole("tab", { name: "Table" }));
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /type/ })).toBeInTheDocument();
  });

  it("has no Explain button or transaction controls", async () => {
    mongoResult();
    await runIn("m1", "db.events.find({})");
    expect(screen.queryByRole("button", { name: "Explain" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Tx:/ })).toBeNull();
  });
});

describe("a Redis console", () => {
  it("shows a reply as a table", async () => {
    api.sessionOpen.mockResolvedValue({
      sessionId: "s1",
      server: { product: "Redis", version: "7.2" },
      transport: null,
    });
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      send({
        event: "columns",
        result_id: 1,
        statement: 0,
        columns: [
          { name: "field", type_name: "string", kind: "text", nullable: true },
          { name: "value", type_name: "string", kind: "text", nullable: true },
        ],
      });
      send({
        event: "rows",
        result_id: 1,
        rows: [
          [
            { kind: "text", value: "plan" },
            { kind: "text", value: "pro" },
          ],
        ],
      });
      send({
        event: "done",
        result_id: 1,
        summary: { rows_affected: null, elapsed_ms: 1, has_more: false },
      });
      return null;
    });
    await runIn("r1", "HGETALL session:42");
    expect(await screen.findByRole("columnheader", { name: "field" })).toBeInTheDocument();
    expect(screen.getByText("pro")).toBeInTheDocument();
    // no document switch for table results
    expect(screen.queryByRole("tablist", { name: "Document view mode" })).toBeNull();
  });
});
