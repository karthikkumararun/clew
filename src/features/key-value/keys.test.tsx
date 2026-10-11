import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { ConsolePromptHost } from "../console/prompts";
import { SafetyPromptHost, clearConfirms } from "../safety/confirm";
import type { KeyDetail, KeyInfo, KvReply, KvRequest, RedisValue } from "./api";
import { KeyBrowser } from "./KeyBrowser";
import { openKeys, registerKeysCommands, registerKeysTab } from "./KeysTab";
import { clearKeysRuntimes } from "./runtime";
import type { KeysTabState } from "./state";

const api = vi.hoisted(() => ({
  kvCall: vi.fn(),
  kvSafetyCheck: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
}));

vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("./api", () => ({
  kvCall: (...a: unknown[]) => api.kvCall(...a),
  kvSafetyCheck: (...a: unknown[]) => api.kvSafetyCheck(...a),
}));
vi.mock("../../lib/ipc/drivers", () => ({
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
}));

const conn = {
  ...toConnection({ ...newDraft("redis"), id: "r1", name: "cache-redis" }),
  environment: "development" as const,
};

const k = (name: string, type_name: string, ttl_ms: number | null = null): KeyInfo => ({
  name,
  type_name,
  ttl_ms,
});
const text = (value: string): RedisValue => ({ kind: "text", value });

let scanPages: Record<string, { cursor: string; keys: KeyInfo[] }>;
let details: Record<string, KeyDetail | null>;
let pages: Record<string, Extract<KvReply, { kind: "page" }>>;
let writeError: string | null;

const detail = (name: string, type_name: string, size: number, ttl_ms: number | null = null) => ({
  name,
  type_name,
  ttl_ms,
  size,
  encoding: "listpack",
  memory: 1536,
});

function server() {
  api.kvCall.mockImplementation(async (_s: string, req: KvRequest): Promise<KvReply> => {
    switch (req.op) {
      case "databases":
        return {
          kind: "databases",
          items: [
            [0, 4],
            [3, 9],
          ],
          databases: 16,
        };
      case "scan":
        return { kind: "keys", ...(scanPages[req.cursor || "start"] ?? { cursor: "0", keys: [] }) };
      case "inspect":
        return { kind: "key", detail: details[req.key] ?? null };
      case "page":
        return pages[req.key] ?? { kind: "page", rows: [], next: null, total: 0 };
      case "command":
        if (writeError) return { kind: "reply", value: { kind: "error", message: writeError } };
        return { kind: "reply", value: { kind: "status", value: "OK" } };
      default:
        throw new Error(`unexpected ${req.op}`);
    }
  });
}

const commands = () =>
  api.kvCall.mock.calls
    .filter((c) => (c[1] as KvRequest).op === "command")
    .map((c) => (c[1] as { line: string }).line);

function Live({ id }: { id: string }) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === id));
  return (
    <>
      {tab ? <KeyBrowser tab={tab as never} /> : null}
      <ConsolePromptHost />
      <SafetyPromptHost />
    </>
  );
}

function mount(db = 0, extra: Partial<KeysTabState> = {}) {
  const id = openKeys("r1", db, extra);
  render(<Live id={id} />);
  return id;
}

let offTab: () => void = () => {};
let offCommands: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearKeysRuntimes();
  clearConfirms();
  setPlatformForTests("mac");
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useConnections.setState((s) => ({ file: { ...s.file, connections: [conn] } }));
  useConnections.setState({ connect: async () => true } as never);
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "Redis", version: "7.2" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  api.kvSafetyCheck.mockResolvedValue({
    decision: "allow",
    connection: "",
    environment: "",
    statements: [],
  });
  scanPages = {
    start: {
      cursor: "0",
      keys: [
        k("session:1", "hash", 60_000),
        k("session:2", "hash"),
        k("rate:ip:1.2.3.4", "string", 5_000),
        k("queue", "list"),
      ],
    },
  };
  details = {};
  pages = {};
  writeError = null;
  server();
  offTab = registerKeysTab();
  offCommands = registerKeysCommands();
});

afterEach(() => {
  offTab();
  offCommands();
});

describe("the key list", () => {
  it("groups keys by prefix with their types", async () => {
    mount();
    const list = await screen.findByRole("listbox", { name: "Key list" });
    const session = within(list).getByRole("button", { name: /session:\*/ });
    expect(session).toHaveTextContent("2 · hash");
    expect(within(list).getByRole("button", { name: /rate:\*/ })).toHaveTextContent("1 · string");
    expect(within(list).getByRole("option", { name: "queue" })).toHaveTextContent("list");
    // groups open on click
    expect(within(list).queryByRole("option", { name: /session:1/ })).toBeNull();
    fireEvent.click(session);
    expect(within(list).getByRole("option", { name: "session:1" })).toHaveTextContent("1hash · 1m");
  });

  it("scans incrementally and never uses KEYS", async () => {
    scanPages = {
      start: { cursor: "17", keys: [k("a:1", "string")] },
      "17": { cursor: "0", keys: [k("a:2", "string"), k("a:1", "string")] },
    };
    mount();
    await screen.findByText("1 key so far");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("2 keys");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const scans = api.kvCall.mock.calls
      .map((c) => c[1] as KvRequest)
      .filter((r) => r.op === "scan");
    expect(scans.map((r) => (r as { cursor: string }).cursor)).toEqual(["", "17"]);
    expect(scans[0]).toMatchObject({ count: 1000, pattern: "" });
  });

  it("filters by glob pattern", async () => {
    mount();
    await screen.findByRole("listbox");
    fireEvent.change(screen.getByLabelText("Key pattern"), { target: { value: "session:*" } });
    fireEvent.keyDown(screen.getByLabelText("Key pattern"), { key: "Enter" });
    await waitFor(() =>
      expect(
        api.kvCall.mock.calls.some(
          (c) => (c[1] as { op: string; pattern?: string }).pattern === "session:*",
        ),
      ).toBe(true),
    );
  });

  it("switches logical database", async () => {
    mount();
    await screen.findByRole("listbox");
    const select = screen.getByLabelText("Database");
    expect(within(select).getByRole("option", { name: "db3 (9)" })).toBeInTheDocument();
    expect(within(select).getAllByRole("option")).toHaveLength(16);
    fireEvent.change(select, { target: { value: "3" } });
    await waitFor(() =>
      expect(
        api.kvCall.mock.calls.some((c) => {
          const r = c[1] as { op: string; db?: number };
          return r.op === "scan" && r.db === 3;
        }),
      ).toBe(true),
    );
  });

  it("says when nothing matches", async () => {
    scanPages = { start: { cursor: "0", keys: [] } };
    mount();
    expect(await screen.findByText("No keys match.")).toBeInTheDocument();
  });
});

describe("viewing keys", () => {
  it("shows a string with TTL, size and encoding, and pretty-prints JSON", async () => {
    details["rate:ip:1.2.3.4"] = detail("rate:ip:1.2.3.4", "string", 14, 5_000);
    pages["rate:ip:1.2.3.4"] = {
      kind: "page",
      rows: [[text('{"hits":3}')]],
      next: null,
      total: 14,
    };
    mount(0, { selected: "rate:ip:1.2.3.4" });
    expect(await screen.findByRole("textbox", { name: "Value" })).toHaveValue('{"hits":3}');
    expect(
      screen.getByText(/TTL 5s · 14 bytes · encoding listpack · 1.5 KB in memory/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    expect(screen.getByLabelText("Value as JSON")).toHaveTextContent('"hits": 3');
    fireEvent.click(screen.getByRole("tab", { name: "Hex" }));
    expect(screen.getByLabelText("Value as hex")).toHaveTextContent("7b 22 68");
  });

  it("shows binary values as hex only", async () => {
    details.bin = detail("bin", "string", 3);
    pages.bin = {
      kind: "page",
      rows: [[{ kind: "bytes", hex: "ff0010", len: 3 }]],
      next: null,
      total: 3,
    };
    mount(0, { selected: "bin" });
    expect(await screen.findByLabelText("Value as hex")).toHaveTextContent("ff 00 10");
    expect(screen.queryByRole("tab", { name: "Text" })).toBeNull();
  });

  it("lists a hash as fields and values", async () => {
    details["session:42"] = detail("session:42", "hash", 2);
    pages["session:42"] = {
      kind: "page",
      rows: [
        [text("plan"), text("free")],
        [text("seats"), text("3")],
      ],
      next: null,
      total: 2,
    };
    mount(0, { selected: "session:42" });
    const table = await screen.findByRole("table", { name: "Hash fields" });
    expect(within(table).getByText("plan")).toBeInTheDocument();
    expect(within(table).getByText("free")).toBeInTheDocument();
  });

  it("pages a long list in chunks", async () => {
    details.queue = detail("queue", "list", 1200);
    pages.queue = {
      kind: "page",
      rows: Array.from({ length: 500 }, (_, i) => [text(`v${i}`)]),
      next: "500",
      total: 1200,
    };
    mount(0, { selected: "queue" });
    await screen.findByRole("table", { name: "List elements" });
    pages.queue = { kind: "page", rows: [[text("v500")]], next: null, total: 1200 };
    fireEvent.click(screen.getByRole("button", { name: "Load more (500 of 1,200)" }));
    await screen.findByText("v500");
    const page = api.kvCall.mock.calls.map((c) => c[1] as KvRequest).filter((r) => r.op === "page");
    expect(page.map((r) => (r as { position: string }).position)).toEqual(["", "500"]);
    expect(page[0]).toMatchObject({ count: 500 });
  });

  it("shows sorted sets with scores and streams latest first", async () => {
    details.z = detail("z", "zset", 2);
    pages.z = {
      kind: "page",
      rows: [
        [text("a"), text("1")],
        [text("b"), text("2")],
      ],
      next: null,
      total: 2,
    };
    details.st = detail("st", "stream", 2);
    pages.st = {
      kind: "page",
      rows: [
        [text("2-1"), { kind: "array", items: [text("k"), text("w")] }],
        [text("1-1"), { kind: "array", items: [text("k"), text("v")] }],
      ],
      next: null,
      total: 2,
    };
    mount(0, { selected: "z" });
    const z = await screen.findByRole("table", { name: "Sorted set members" });
    expect(within(z).getAllByRole("row")[1]).toHaveTextContent("a1");
    mount(1, { selected: "st" });
    const st = await screen.findByRole("table", { name: "Stream entries" });
    const rows = within(st).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("2-1");
    expect(rows[1]).toHaveTextContent("k=w");
  });

  it("says when the key is gone", async () => {
    mount(0, { selected: "expired" });
    expect(await screen.findByText(/expired no longer exists/)).toBeInTheDocument();
  });
});

describe("editing", () => {
  beforeEach(() => {
    details["session:42"] = detail("session:42", "hash", 1);
    pages["session:42"] = {
      kind: "page",
      rows: [[text("plan"), text("free")]],
      next: null,
      total: 1,
    };
  });

  it("changes a hash field with HSET and refreshes", async () => {
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit plan" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "pro" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(commands()).toEqual(['HSET "session:42" "plan" "pro"']));
    // the key is read again afterwards
    await waitFor(() =>
      expect(
        api.kvCall.mock.calls.filter((c) => (c[1] as KvRequest).op === "inspect"),
      ).toHaveLength(2),
    );
  });

  it("adds and removes fields", async () => {
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "Add field" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Field"), { target: { value: "seats" } });
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: 'say "hi"' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(commands()).toContain('HSET "session:42" "seats" "say \\"hi\\""'));
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan" }));
    await waitFor(() => expect(commands()).toContain('HDEL "session:42" "plan"'));
  });

  it("saves a string without losing its TTL", async () => {
    details.s = detail("s", "string", 1, 90_000);
    pages.s = { kind: "page", rows: [[text("v")]], next: null, total: 1 };
    mount(0, { selected: "s" });
    const box = await screen.findByRole("textbox", { name: "Value" });
    fireEvent.change(box, { target: { value: "w" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(commands()).toEqual(['SET "s" "w" KEEPTTL']));
  });

  it("sets and clears the expiry", async () => {
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "TTL…" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "300" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set expiry" }));
    await waitFor(() => expect(commands()).toEqual(['EXPIRE "session:42" 300']));
    fireEvent.click(await screen.findByRole("button", { name: "TTL…" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set expiry" }));
    await waitFor(() => expect(commands()).toContain('PERSIST "session:42"'));
  });

  it("renames a key, refusing to overwrite one", async () => {
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "session:43" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(commands()).toEqual(['RENAMENX "session:42" "session:43"']));
  });

  it("deletes after asking", async () => {
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const ask = await screen.findByRole("dialog");
    fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(commands()).toEqual(['DEL "session:42"']));
    expect(await screen.findByText("Select a key to see its value.")).toBeInTheDocument();
  });

  it("shows what the server says when a write fails", async () => {
    writeError = "WRONGTYPE Operation against a key holding the wrong kind of value";
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("WRONGTYPE");
  });

  it("asks the safeguards first, and stops when they refuse", async () => {
    api.kvSafetyCheck.mockResolvedValue({
      decision: "block",
      reason: "This session is read-only",
      connection: "",
      environment: "",
      statements: [],
    });
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This session is read-only");
    expect(commands()).toEqual([]);
  });

  it("sends the confirmation token with a confirmed write", async () => {
    api.kvSafetyCheck.mockResolvedValue({
      decision: "confirm",
      connection: "cache-redis",
      environment: "development",
      statements: [{ text: 'HDEL "session:42" "plan"', class: "write" }],
      token: "tok-9",
    });
    mount(0, { selected: "session:42" });
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan" }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: /Run|Confirm|Yes/i }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    const call = api.kvCall.mock.calls.find((c) => (c[1] as KvRequest).op === "command")!;
    expect(call[2]).toBe("tok-9");
  });
});
