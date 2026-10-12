import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands } from "../../shell/registry/commands";
import { clearShortcuts, installShortcutListener } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { ConsolePromptHost } from "../console/prompts";
import { SafetyPromptHost, clearConfirms } from "../safety/confirm";
import type { DocReply, DocRequest } from "./api";
import { CollectionBrowser } from "./CollectionBrowser";
import { openCollection, registerCollectionCommands, registerCollectionTab } from "./CollectionTab";
import { clearCollectionRuntimes } from "./runtime";
import type { CollectionTabState } from "./state";
import type { EJson } from "./ejson";

const api = vi.hoisted(() => ({
  docCall: vi.fn(),
  docFetchMore: vi.fn(),
  docSafetyCheck: vi.fn(),
  exportPickPath: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  queryCancel: vi.fn(),
  introspect: vi.fn(),
}));

vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("./api", () => ({
  docCall: (...a: unknown[]) => api.docCall(...a),
  docFetchMore: (...a: unknown[]) => api.docFetchMore(...a),
  docSafetyCheck: (...a: unknown[]) => api.docSafetyCheck(...a),
  exportPickPath: (...a: unknown[]) => api.exportPickPath(...a),
}));
vi.mock("../../lib/ipc/drivers", () => ({
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  queryCancel: (...a: unknown[]) => api.queryCancel(...a),
  introspectChildren: (...a: unknown[]) => api.introspect(...a),
}));
vi.mock("../grid/ResultGrid", async () => {
  const { FakeResultGrid } = await import("../grid/testing");
  return { ResultGrid: FakeResultGrid, autoWidth: () => 100 };
});

const OID1 = "6703f1c2a9e41d7c2e0fb812";
const OID2 = "6703ee09a9e41d7c2e0fa771";
const int = (n: number) => ({ $numberInt: String(n) });

const DOC1: EJson = {
  _id: { $oid: OID1 },
  type: "checkout",
  user: { id: int(1042), plan: "pro", beta: true },
  items: [{ sku: "TBL-OAK", qty: int(1) }],
  ts: { $date: { $numberLong: "1790857800000" } },
};
const DOC2: EJson = { _id: { $oid: OID2 }, type: "view", user: { id: int(7), plan: "free" } };

const conn = {
  ...toConnection({ ...newDraft("mongodb"), id: "m1", name: "dev-mongo" }),
  environment: "development" as const,
};

const found = (over: Partial<Extract<DocReply, { kind: "found" }>> = {}): DocReply => ({
  kind: "found",
  result_id: 1,
  has_more: false,
  elapsed_ms: 12,
  database: null,
  ...over,
});

let docs: EJson[] = [DOC1, DOC2];
let explain = { index: "_id_" as string | null, collscan: false };
let writeReply: DocReply | ((req: DocRequest) => DocReply) = {
  kind: "written",
  inserted: [],
  matched: 1,
  modified: 1,
  deleted: 0,
};
let findError: { message: string; detail?: string } | null = null;

function server() {
  api.docCall.mockImplementation(
    async (
      _s: string,
      req: DocRequest,
      onDocs?: (id: number, d: EJson[]) => void,
    ): Promise<DocReply> => {
      switch (req.op) {
        case "find":
          if (findError) throw { code: "query_failed", ...findError };
          onDocs?.(1, docs);
          return found();
        case "count":
          return { kind: "count", count: 1936, capped: false };
        case "explain":
          return { kind: "explain", ...explain };
        case "update":
        case "replace":
        case "delete":
        case "insert":
          return typeof writeReply === "function" ? writeReply(req) : writeReply;
        case "evaluate":
          return { kind: "value", value: JSON.parse(req.text) };
        case "schema":
          return {
            kind: "schema",
            sampled: 2,
            fields: [
              {
                path: "type",
                types: [{ type_name: "string", percent: 100 }],
                present_percent: 100,
              },
              {
                path: "coupon",
                types: [
                  { type_name: "string", percent: 50 },
                  { type_name: "null", percent: 50 },
                ],
                present_percent: 50,
              },
            ],
          };
        case "indexes":
          return {
            kind: "indexes",
            items: [
              {
                name: "_id_",
                keys: { _id: int(1) },
                unique: false,
                sparse: false,
                ttl_seconds: null,
                size_bytes: 36864,
              },
            ],
          };
        case "export":
          return { kind: "exported", count: 2 };
        default:
          throw new Error(`unexpected ${req.op}`);
      }
    },
  );
}

const calls = (op: string) =>
  api.docCall.mock.calls.filter((c) => (c[1] as DocRequest).op === op).map((c) => c[1] as never);

let offTab: () => void = () => {};
let offCommands: () => void = () => {};
let offKeys: () => void = () => {};

function Live({ id }: { id: string }) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === id));
  return (
    <>
      {tab ? <CollectionBrowser tab={tab as never} /> : null}
      <ConsolePromptHost />
      <SafetyPromptHost />
    </>
  );
}

function mount(extra: Partial<CollectionTabState> = {}) {
  const id = openCollection("m1", "shop", "events", extra);
  render(<Live id={id} />);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearCollectionRuntimes();
  clearConfirms();
  setPlatformForTests("mac");
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useConnections.setState((s) => ({ file: { ...s.file, connections: [conn] } }));
  useConnections.setState({ connect: async () => true } as never);
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "MongoDB", version: "8.0.1" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  api.queryCancel.mockResolvedValue(undefined);
  api.introspect.mockResolvedValue([
    { name: "carts", detail: "1.2k", kind: "table", hasChildren: false, path: [] },
    { name: "events", detail: "418k", kind: "table", hasChildren: false, path: [] },
    { name: "users", detail: "8.1k", kind: "table", hasChildren: false, path: [] },
  ]);
  api.docSafetyCheck.mockResolvedValue({
    decision: "allow",
    connection: "",
    environment: "",
    statements: [],
  });
  docs = [DOC1, DOC2];
  explain = { index: "_id_", collscan: false };
  writeReply = { kind: "written", inserted: [], matched: 1, modified: 1, deleted: 0 };
  findError = null;
  server();
  offTab = registerCollectionTab();
  offCommands = registerCollectionCommands();
  offKeys = installShortcutListener();
});

afterEach(() => {
  offTab();
  offCommands();
  offKeys();
});

describe("opening a collection", () => {
  it("shows the first 50 documents sorted by _id descending (spec: document-browser › Open a collection)", async () => {
    mount();
    await screen.findByText(/^\(1\) ObjectId\("6703/);
    const [find] = calls("find") as { sort: string; filter: string; page_size: number }[];
    expect(find).toMatchObject({ sort: "{ _id: -1 }", filter: "", page_size: 50 });
    expect(screen.getByText(/^\(2\) ObjectId/)).toBeInTheDocument();
  });

  it("reports matches, time and the index used", async () => {
    mount();
    expect(await screen.findByText("2 of 1,936 matched · 12 ms · index _id_")).toBeInTheDocument();
  });

  it("warns about a collection scan", async () => {
    explain = { index: null, collscan: true };
    mount();
    expect(await screen.findByText("COLLSCAN")).toBeInTheDocument();
    expect(screen.queryByText(/index _id_/)).toBeNull();
  });

  it("says when nothing matches", async () => {
    docs = [];
    mount();
    expect(await screen.findByText("No documents match.")).toBeInTheDocument();
  });
});

describe("the query bar", () => {
  it("runs the filter, projection, sort and limit that were typed", async () => {
    mount();
    await screen.findByText(/^\(1\)/);
    fireEvent.change(screen.getByLabelText("FILTER"), { target: { value: "{ type: 'view' }" } });
    fireEvent.change(screen.getByLabelText("PROJECT"), { target: { value: "{ type: 1 }" } });
    fireEvent.change(screen.getByLabelText("SORT"), { target: { value: "{ ts: -1 }" } });
    fireEvent.change(screen.getByLabelText("LIMIT"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /^Find/ }));
    await waitFor(() => expect(calls("find")).toHaveLength(2));
    expect(calls("find")[1]).toMatchObject({
      filter: "{ type: 'view' }",
      projection: "{ type: 1 }",
      sort: "{ ts: -1 }",
      limit: 25,
    });
  });

  it("runs on Enter and on Mod+Enter", async () => {
    mount();
    await screen.findByText(/^\(1\)/);
    const filter = screen.getByLabelText("FILTER");
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() => expect(calls("find")).toHaveLength(2));
    fireEvent.keyDown(filter, { key: "Enter", metaKey: true });
    await waitFor(() => expect(calls("find").length).toBeGreaterThanOrEqual(3));
  });

  it("shows a parse error under the bar and keeps the old documents (spec: document-browser › Invalid filter)", async () => {
    mount();
    await screen.findByText(/^\(1\)/);
    findError = { message: "Filter: Expected a value but the text ended", detail: "position:6" };
    fireEvent.change(screen.getByLabelText("FILTER"), { target: { value: "{ a: }" } });
    fireEvent.click(screen.getByRole("button", { name: /^Find/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Expected a value but the text ended (at character 6)",
    );
    expect(screen.getByText(/^\(1\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("FILTER").closest("div")).toHaveAttribute("data-invalid", "true");
  });
});

describe("views", () => {
  it("expands a document into typed fields", async () => {
    mount();
    const row = (await screen.findByText(/^\(1\)/)).closest("tr")!;
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(await screen.findByText('ObjectId("6703f1c2a9e41d7c2e0fb812")')).toBeInTheDocument();
    expect(screen.getByText('"checkout"')).toBeInTheDocument();
    expect(screen.getByText("2026-10-01T12:30:00.000Z")).toBeInTheDocument();
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getAllByText("{ 3 fields }").length).toBeGreaterThan(0); // user, and the second document
  });

  it("expand all opens nested objects and arrays", async () => {
    mount();
    await screen.findByText(/^\(1\)/);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(await screen.findByText("TBL-OAK", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("1042")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  it("shows the JSON view in shell syntax and folds objects", async () => {
    mount({ docView: "json" });
    const ids = await screen.findAllByText(/^_id: ObjectId\("/);
    expect(ids.length).toBe(2);
    expect(screen.getAllByText(/^ts: ISODate\("2026-10-01T12:30:00.000Z"\)$/).length).toBe(1);
    expect(screen.getAllByText('plan: "pro",').length).toBeGreaterThan(0);
    // fold the first document's `user` object
    const user = screen.getAllByText("user: {")[0];
    fireEvent.click(within(user.parentElement!).getByRole("button", { name: "Fold" }));
    expect(screen.getByText("user: { … 3 fields },")).toBeInTheDocument();
  });

  it("shows the table view with one column per top-level field", async () => {
    mount({ docView: "table" });
    expect(await screen.findByRole("columnheader", { name: /_id/ })).toBeInTheDocument();
    for (const name of ["type", "user", "items", "ts"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
  });
});

describe("editing", () => {
  async function stageNewType() {
    const row = (await screen.findByText(/^\(1\)/)).closest("tr")!;
    fireEvent.keyDown(row, { key: "ArrowRight" });
    const value = await screen.findByText('"checkout"');
    fireEvent.doubleClick(value.closest("tr")!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "refund" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stage change" }));
  }

  it("stages an edit, marks it, and saves it with a version check", async () => {
    mount();
    await stageNewType();
    expect(await screen.findByText('"refund"')).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 document has unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls("update")).toHaveLength(1));
    expect(calls("update")[0]).toMatchObject({
      id: { $oid: OID1 },
      set: { type: "refund" },
      unset: [],
      check: [{ path: "type", absent: false, value: "checkout" }],
      force: false,
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByText('"refund"')).toBeInTheDocument();
  });

  it("saves with Mod+S", async () => {
    mount();
    await stageNewType();
    await screen.findByRole("status");
    fireEvent.keyDown(screen.getByText('"refund"'), { key: "s", metaKey: true });
    await waitFor(() => expect(calls("update")).toHaveLength(1));
  });

  it("types an edited value: 5 becomes an Int32, not a string", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
    fireEvent.doubleClick((await screen.findByText("1042")).closest("tr")!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "2000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stage change" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls("update")).toHaveLength(1));
    expect(calls("update")[0]).toMatchObject({ set: { "user.id": int(2000) } });
  });

  it("rejects a value that doesn't fit its type", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
    fireEvent.doubleClick((await screen.findByText("1042")).closest("tr")!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "4.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stage change" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Not a 32-bit integer");
    expect(calls("update")).toHaveLength(0);
  });

  it("offers Reload or Overwrite when the document changed underneath (spec: document-browser › Concurrent modification)", async () => {
    writeReply = (req) =>
      (req as { force?: boolean }).force
        ? { kind: "written", inserted: [], matched: 1, modified: 1, deleted: 0 }
        : { kind: "conflict", current: { ...(DOC1 as object), type: "other" } as never };
    mount();
    await stageNewType();
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("This document changed")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(calls("update")).toHaveLength(2));
    expect((calls("update")[1] as { force: boolean }).force).toBe(true);
  });

  it("Reload drops the edit and shows the server's version", async () => {
    writeReply = { kind: "conflict", current: { ...(DOC1 as object), type: "other" } as never };
    mount();
    await stageNewType();
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(await screen.findByText('"other"')).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks the safeguards first and sends their token", async () => {
    api.docSafetyCheck.mockResolvedValue({
      decision: "confirm",
      connection: "dev-mongo",
      environment: "development",
      statements: [{ text: "db.events.updateOne(…)", class: "write" }],
      token: "tok-1",
    });
    mount();
    await stageNewType();
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: /Run|Confirm|Yes/i }));
    await waitFor(() => expect(calls("update")).toHaveLength(1));
    expect(api.docCall.mock.calls.find((c) => (c[1] as DocRequest).op === "update")![3]).toBe(
      "tok-1",
    );
  });

  it("discard throws the staged edits away", async () => {
    mount();
    await stageNewType();
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText('"checkout"')).toBeInTheDocument();
    expect(calls("update")).toHaveLength(0);
  });

  it("inserts a document written in shell syntax", async () => {
    mount();
    await screen.findByText(/^\(1\)/);
    fireEvent.click(screen.getByRole("button", { name: "Insert document" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Document"), {
      target: { value: '{"name": "x"}' },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(calls("insert")).toHaveLength(1));
    expect(calls("insert")[0]).toMatchObject({ documents: [{ name: "x" }] });
    // the list is reloaded afterwards
    await waitFor(() => expect(calls("find")).toHaveLength(2));
  });

  it("won't edit on a read-only session", async () => {
    const { sessionReadOnly } = await import("../safety/ipcMock");
    (sessionReadOnly as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    mount();
    await screen.findByText(/^\(1\)/);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Insert document" })).toBeDisabled(),
    );
    const row = screen.getByText(/^\(1\)/).closest("tr")!;
    fireEvent.keyDown(row, { key: "ArrowRight" });
    fireEvent.doubleClick((await screen.findByText('"checkout"')).closest("tr")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useNotices.getState().notices.map((n) => n.message)).toContain(
      "This session is read-only",
    );
  });
});

describe("schema, indexes and export", () => {
  it("shows the inferred schema (spec: document-browser › Mixed types)", async () => {
    mount({ pane: "schema" });
    const table = await screen.findByRole("table", { name: "Inferred schema" });
    expect(within(table).getByText("coupon")).toBeInTheDocument();
    expect(within(table).getByText("string 50% · null 50%")).toBeInTheDocument();
    expect(screen.getByText(/sample of 2 documents/)).toBeInTheDocument();
  });

  it("lists indexes and creates one", async () => {
    mount({ pane: "indexes" });
    const table = await screen.findByRole("table", { name: "Indexes" });
    expect(within(table).getByText("_id_")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Index keys"), { target: { value: "{ ts: -1 }" } });
    fireEvent.click(screen.getByLabelText("Unique"));
    api.docCall.mockImplementationOnce(async () => ({ kind: "indexes", items: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Create index" }));
    await waitFor(() => expect(calls("create_index")).toHaveLength(1));
    expect(calls("create_index")[0]).toMatchObject({ keys: "{ ts: -1 }", unique: true });
  });

  it("exports every match to the file the user picks", async () => {
    api.exportPickPath.mockResolvedValue("/tmp/events.jsonl");
    mount();
    await screen.findByText(/^\(1\)/);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "JSON Lines" }));
    await waitFor(() => expect(calls("export")).toHaveLength(1));
    expect(api.exportPickPath).toHaveBeenCalledWith("events", "jsonl");
    expect(calls("export")[0]).toMatchObject({ format: "jsonl", path: "/tmp/events.jsonl" });
    await waitFor(() =>
      expect(useNotices.getState().notices.map((n) => n.message)).toContain(
        "Exported 2 documents to /tmp/events.jsonl",
      ),
    );
  });
});

describe("paging", () => {
  it("loads the next page from the open cursor", async () => {
    api.docCall.mockImplementationOnce(async (_s: string, _r: unknown, onDocs: never) => {
      (onDocs as (i: number, d: EJson[]) => void)(1, [DOC1]);
      return found({ has_more: true });
    });
    api.docFetchMore.mockImplementation(
      async (_s: string, _id: number, _n: number, onDocs: (d: EJson[]) => void) => {
        onDocs([DOC2]);
        return false;
      },
    );
    mount();
    await screen.findByText(/^\(1\)/);
    expect(screen.queryByText(/^\(2\)/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    expect(await screen.findByText(/^\(2\)/)).toBeInTheDocument();
    expect(api.docFetchMore).toHaveBeenCalledWith("s1", 1, 50, expect.any(Function));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("the side list and the aggregation view", () => {
  it("lists the database's collections with counts and opens another", async () => {
    mount();
    const aside = await screen.findByRole("complementary", { name: "Collections" });
    expect(within(aside).getByText("SHOP · COLLECTIONS")).toBeInTheDocument();
    expect(await within(aside).findByText("418k")).toBeInTheDocument();
    const current = within(aside).getByRole("button", { name: /events/ });
    expect(current).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(aside).getByRole("button", { name: /users/ }));
    await waitFor(() =>
      expect(
        useWorkspace
          .getState()
          .tabs.some((t) => (t.state as { collection?: string }).collection === "users"),
      ).toBe(true),
    );
  });

  it("runs a pipeline and shows the grouped results (spec: document-browser › Aggregate)", async () => {
    api.docCall.mockImplementation(
      async (_s: string, req: DocRequest, onDocs?: (id: number, d: EJson[]) => void) => {
        if (req.op === "aggregate") {
          onDocs?.(7, [
            { _id: "checkout", n: int(12) },
            { _id: "view", n: int(30) },
          ]);
          return found({ result_id: 7 });
        }
        if (req.op === "find") {
          onDocs?.(1, docs);
          return found();
        }
        return { kind: "count", count: 2, capped: false } as DocReply;
      },
    );
    mount({ pane: "aggregation" });
    const box = await screen.findByLabelText("Pipeline");
    fireEvent.change(box, {
      target: { value: '[{ $group: { _id: "$type", n: { $sum: 1 } } }]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run pipeline" }));
    expect(await screen.findByText(/^\(1\) "checkout"/)).toBeInTheDocument();
    expect(screen.getByText("2 documents · 12 ms")).toBeInTheDocument();
    const sent = calls("aggregate")[0] as { pipeline: string; collection: string };
    expect(sent.collection).toBe("events");
    expect(sent.pipeline).toContain("$group");
  });

  it("runs the pipeline with Mod+Enter instead of a find", async () => {
    mount({ pane: "aggregation" });
    await screen.findByLabelText("Pipeline");
    const before = calls("find").length;
    fireEvent.keyDown(screen.getByLabelText("Pipeline"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(calls("aggregate").length).toBeGreaterThan(0));
    expect(calls("find").length).toBe(before);
  });
});

describe("more of the spec", () => {
  it("changes a field's type through the type menu (spec: document-browser › Change a field type)", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
    fireEvent.doubleClick((await screen.findByText("1042")).closest("tr")!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "String" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stage change" }));
    // the pending value is now a string
    expect(await screen.findByText('"1042"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls("update")).toHaveLength(1));
    expect(calls("update")[0]).toMatchObject({ set: { "user.id": "1042" } });
  });

  it("asks before dropping an index", async () => {
    api.docCall.mockImplementation(async (_s: string, req: DocRequest): Promise<DocReply> => {
      if (req.op === "indexes" || req.op === "drop_index") {
        return {
          kind: "indexes",
          items: [
            {
              name: "_id_",
              keys: { _id: int(1) },
              unique: false,
              sparse: false,
              ttl_seconds: null,
              size_bytes: null,
            },
            {
              name: "ts_-1",
              keys: { ts: int(-1) },
              unique: false,
              sparse: false,
              ttl_seconds: null,
              size_bytes: null,
            },
          ],
        };
      }
      return found();
    });
    mount({ pane: "indexes" });
    fireEvent.click(await screen.findByRole("button", { name: "Drop index ts_-1" }));
    const ask = await screen.findByRole("dialog");
    expect(within(ask).getByText("Drop index ts_-1?")).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(calls("drop_index")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Drop index ts_-1" }));
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", { name: "Drop index" }),
    );
    await waitFor(() => expect(calls("drop_index")).toHaveLength(1));
    expect(calls("drop_index")[0]).toMatchObject({ name: "ts_-1" });
  });
});
