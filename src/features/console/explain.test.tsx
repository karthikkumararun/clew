import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forEachDiagnostic } from "@codemirror/lint";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { ResultEvent, Value } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { stubLayout } from "../explorer/testing";
import { clearSnapshots } from "./completion/snapshots";
import { registerConsoleTab } from "./ConsoleTab";
import { ConsoleToolbar } from "./ConsoleToolbar";
import { ConsoleView } from "./ConsoleView";
import { openConsole, registerConsoleCommands } from "./commands";
import { charOffsetToIndex, errorRange } from "./editor/diagnostics";
import { getView } from "./editor/views";
import { ExplainUnsupported, explainStatement, isWrite, parsePlan } from "./explain";
import { clearPrompts, ConsolePromptHost } from "./prompts";
import { clearRuntimes, getRuntime } from "./runtime";

const api = vi.hoisted(() => ({ execute: vi.fn(), sessionOpen: vi.fn(), sessionClose: vi.fn() }));
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

const text = (s: string): Value => ({ kind: "text", value: s });
const json = (value: unknown): Value => ({ kind: "json", value: value as never });

/** The plan PostgreSQL returns for a join, trimmed to the fields the tree shows. */
const PG_PLAN = [
  {
    Plan: {
      "Node Type": "Hash Join",
      "Join Type": "Inner",
      "Startup Cost": 12.5,
      "Total Cost": 48.25,
      "Plan Rows": 120,
      "Hash Cond": "(o.user_id = u.id)",
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Alias: "o",
          "Startup Cost": 0,
          "Total Cost": 35.5,
          "Plan Rows": 2550,
          Filter: "(total > 100)",
          "Rows Removed by Filter": 40,
        },
        {
          "Node Type": "Hash",
          "Startup Cost": 10,
          "Total Cost": 10,
          "Plan Rows": 100,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Relation Name": "users",
              Alias: "users",
              "Index Name": "users_pkey",
              "Startup Cost": 0.15,
              "Total Cost": 8.17,
              "Plan Rows": 100,
            },
          ],
        },
      ],
    },
    "Planning Time": 0.21,
    "Execution Time": 3.4,
  },
];

describe("explain statements", () => {
  it("builds the right statement per driver", () => {
    expect(explainStatement("postgres", "select 1", false)).toBe("EXPLAIN (FORMAT JSON) select 1");
    expect(explainStatement("postgres", "select 1", true)).toBe(
      "EXPLAIN (ANALYZE, FORMAT JSON) select 1",
    );
    expect(explainStatement("sqlite", "select 1", false)).toBe("EXPLAIN QUERY PLAN select 1");
    expect(explainStatement("mysql", "select 1", false)).toBe("EXPLAIN FORMAT=JSON select 1");
    expect(explainStatement("mysql", "select 1", true)).toBe("EXPLAIN ANALYZE select 1");
    expect(explainStatement("mariadb", "select 1", true)).toBe("ANALYZE FORMAT=JSON select 1");
    expect(() => explainStatement("sqlite", "select 1", true)).toThrow(ExplainUnsupported);
  });

  it("knows which statements write", () => {
    for (const sql of [
      "update t set a = 1",
      "  -- fix\nDELETE FROM t",
      "insert into t values (1)",
      "with x as (select 1) insert into t select * from x",
      "/* c */ create table t (a int)",
      "truncate t",
    ]) {
      expect(isWrite(sql), sql).toBe(true);
    }
    for (const sql of [
      "select 1",
      "with x as (select 1) select * from x",
      "values (1)",
      "show tables",
    ]) {
      expect(isWrite(sql), sql).toBe(false);
    }
  });
});

describe("plan parsers", () => {
  it("reads PostgreSQL's JSON plan into a tree with costs and details", () => {
    const plan = parsePlan("postgres", [[json(PG_PLAN)]], false)!;
    expect(plan.summary).toEqual(["Planning time: 0.21 ms", "Execution time: 3.4 ms"]);
    const root = plan.nodes[0];
    expect(root).toMatchObject({ type: "Hash Join (Inner)", estRows: 120, cost: "12.50..48.25" });
    expect(root.details).toContain("Hash cond: (o.user_id = u.id)");
    expect(root.children.map((c) => c.type)).toEqual(["Seq Scan", "Hash"]);
    expect(root.children[0]).toMatchObject({ relation: "orders o", estRows: 2550 });
    expect(root.children[0].details).toEqual([
      "Filter: (total > 100)",
      "Rows removed by filter: 40",
    ]);
    expect(root.children[1].children[0]).toMatchObject({ type: "Index Scan", relation: "users" });
    expect(root.children[1].children[0].details).toContain("Index: users_pkey");
  });

  it("accepts the plan as text and rejects what isn't a plan", () => {
    expect(parsePlan("postgres", [[text(JSON.stringify(PG_PLAN))]], false)?.nodes).toHaveLength(1);
    expect(parsePlan("postgres", [[text("not json")]], false)).toBeNull();
    expect(parsePlan("postgres", [], false)).toBeNull();
  });

  it("reads ANALYZE actuals", () => {
    const analyzed = [
      {
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "t",
          "Plan Rows": 10,
          "Actual Rows": 8,
          "Actual Total Time": 0.5,
        },
      },
    ];
    expect(parsePlan("postgres", [[json(analyzed)]], true)!.nodes[0]).toMatchObject({
      actualRows: 8,
      actualMs: 0.5,
    });
  });

  it("builds SQLite's query plan from parent links", () => {
    const row = (id: number, parent: number, detail: string): Value[] => [
      { kind: "int", value: id },
      { kind: "int", value: parent },
      { kind: "int", value: 0 },
      text(detail),
    ];
    const plan = parsePlan(
      "sqlite",
      [
        row(2, 0, "SCAN orders"),
        row(3, 0, "SEARCH users USING INTEGER PRIMARY KEY (rowid=?)"),
        row(5, 3, "USE TEMP B-TREE FOR ORDER BY"),
      ],
      false,
    )!;
    expect(plan.nodes.map((n) => [n.type, n.relation])).toEqual([
      ["SCAN", "orders"],
      ["SEARCH", "users"],
    ]);
    expect(plan.nodes[1].children[0].type).toBe("USE TEMP B-TREE FOR ORDER BY");
  });

  it("reads MySQL's JSON plan", () => {
    const doc = {
      query_block: {
        select_id: 1,
        cost_info: { query_cost: "12.40" },
        nested_loop: [
          {
            table: {
              table_name: "orders",
              access_type: "ALL",
              rows_examined_per_scan: 100,
              cost_info: { prefix_cost: "10.25" },
            },
          },
          {
            table: {
              table_name: "users",
              access_type: "eq_ref",
              key: "PRIMARY",
              rows_examined_per_scan: 1,
              attached_condition: "(u.x > 1)",
            },
          },
        ],
      },
    };
    const plan = parsePlan("mysql", [[text(JSON.stringify(doc))]], false)!;
    expect(plan.nodes[0]).toMatchObject({ type: "Query block", cost: "12.40" });
    const [orders, users] = plan.nodes[0].children[0].children;
    expect(orders).toMatchObject({ type: "ALL", relation: "orders", estRows: 100, cost: "10.25" });
    expect(users.details).toEqual(["Index: PRIMARY", "Filter: (u.x > 1)"]);
  });

  it("reads MySQL's EXPLAIN ANALYZE tree", () => {
    const tree = [
      "-> Nested loop inner join  (cost=1.2 rows=3) (actual time=0.1..0.4 rows=3 loops=1)",
      "    -> Table scan on orders  (cost=0.5 rows=3) (actual time=0.05..0.1 rows=3 loops=1)",
      "    -> Single-row index lookup on users using PRIMARY  (cost=0.25 rows=1) (actual time=0.01..0.01 rows=1 loops=3)",
    ].join("\n");
    const plan = parsePlan("mysql", [[text(tree)]], true)!;
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0].children.map((c) => c.relation)).toEqual(["orders", "users"]);
    expect(plan.nodes[0]).toMatchObject({ estRows: 3, actualRows: 3, actualMs: 0.4 });
  });
});

describe("error positions", () => {
  it("counts Unicode scalars, not UTF-16 units", () => {
    expect(charOffsetToIndex("a😀bc", 0)).toBe(0);
    expect(charOffsetToIndex("a😀bc", 2)).toBe(3);
    expect(charOffsetToIndex("abc", 99)).toBe(3);
  });

  it("underlines the identifier the server pointed at", () => {
    const sql = "select o.carrier from orders o";
    const r = errorRange(sql, 0, sql, 8); // 1-based position of `o.carrier`
    expect(sql.slice(r.from, r.to)).toBe("o.carrier");
  });

  it("offsets into the document and covers at least one character", () => {
    const doc = "select 1;\nselect (";
    const r = errorRange(doc, 10, "select (", 8);
    expect(doc.slice(r.from, r.to)).toBe("(");
  });
});

// ---- in the console ----------------------------------------------------------------------------

const conn = toConnection({ ...newDraft("postgres"), id: "c1", name: "pg", host: "h" });
const readOnly = {
  ...toConnection({ ...newDraft("postgres"), id: "c2", name: "prod", host: "h" }),
  safeguards: { readOnlyByDefault: true, confirmWrites: true, manualCommit: false },
};

type Send = (e: ResultEvent) => void;
const columns = [{ name: "QUERY PLAN", type_name: "json", kind: "json" as const, nullable: false }];

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

async function mountConsole(sql: string, cursorAt: number, connectionId = "c1") {
  const id = (await openConsole({ connectionId, sql }))!;
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
  render(
    <>
      <ConsoleToolbar />
      <ConsoleView tab={tab as never} />
      <ConsolePromptHost />
    </>,
  );
  const view = getView(id)!;
  act(() => view.dispatch({ selection: { anchor: cursorAt } }));
  return { id, view, runtime: getRuntime(id, connectionId) };
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
  api.execute.mockImplementation(async (_s: string, req: { sql: string }, send: Send) => {
    if (/^EXPLAIN/i.test(req.sql)) {
      send({ event: "columns", result_id: 1, statement: 0, columns });
      send({ event: "rows", result_id: 1, rows: [[json(PG_PLAN)]] });
      send({
        event: "done",
        result_id: 1,
        summary: { rows_affected: null, elapsed_ms: 2, has_more: false },
      });
    } else {
      send({
        event: "done",
        result_id: 2,
        summary: { rows_affected: 0, elapsed_ms: 1, has_more: false },
      });
    }
    return null;
  });
  useConnections.setState({
    file: { version: 1, groups: [], connections: [conn, readOnly] },
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

describe("errors in the editor", () => {
  it("shows the message and hint in Output and underlines the failing token", async () => {
    const sql = "select o.carrier\nfrom orders o";
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      send({
        event: "error",
        result_id: null,
        statement: 0,
        error: {
          code: "query_failed",
          message: "column o.carrier does not exist",
          hint: 'Perhaps you meant to reference the column "o.carrier_id".',
          position: 8,
        },
      });
      return null;
    });
    const { view } = await mountConsole(sql, 3);
    await act(async () => void (await runCommand("console.run")));

    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
    const log = within(await screen.findByRole("log", { name: "Output" }));
    expect(log.getByText("column o.carrier does not exist")).toBeInTheDocument();
    expect(log.getByText(/Hint: Perhaps you meant/)).toBeInTheDocument();

    const marks: { from: number; to: number; message: string }[] = [];
    forEachDiagnostic(view.state, (d, from, to) => marks.push({ from, to, message: d.message }));
    expect(marks).toHaveLength(1);
    expect(sql.slice(marks[0].from, marks[0].to)).toBe("o.carrier");
    expect(marks[0].message).toMatch(/does not exist\nHint: Perhaps/);
  });

  it("places the underline inside the failing statement of a script", async () => {
    const sql = "select 1;\nselect nope from t";
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      send({ event: "columns", result_id: 1, statement: 0, columns });
      send({ event: "rows", result_id: 1, rows: [[text("1")]] });
      send({
        event: "done",
        result_id: 1,
        summary: { rows_affected: null, elapsed_ms: 1, has_more: false },
      });
      send({
        event: "error",
        result_id: null,
        statement: 1,
        error: { code: "query_failed", message: "no column", position: 8 },
      });
      return null;
    });
    const { view } = await mountConsole(sql, 0);
    await act(async () => void (await runCommand("console.runScript")));
    const marks: [number, number][] = [];
    forEachDiagnostic(view.state, (_d, from, to) => marks.push([from, to]));
    expect(marks.map(([f, t]) => sql.slice(f, t))).toEqual(["nope"]);
  });

  it("clears the underline when the next run starts", async () => {
    api.execute.mockImplementationOnce(async (_s: string, _r: unknown, send: Send) => {
      send({
        event: "error",
        result_id: null,
        statement: 0,
        error: { code: "query_failed", message: "bad", position: 1 },
      });
      return null;
    });
    const { view } = await mountConsole("selec 1", 2);
    await act(async () => void (await runCommand("console.run")));
    let n = 0;
    forEachDiagnostic(view.state, () => n++);
    expect(n).toBe(1);
    await act(async () => void (await runCommand("console.run")));
    n = 0;
    forEachDiagnostic(view.state, () => n++);
    expect(n).toBe(0);
  });
});

describe("Explain plan", () => {
  it("renders the plan as a tree in the Explain plan tab", async () => {
    await mountConsole("select * from orders o join users u on u.id = o.user_id", 3);
    await act(async () => void (await runCommand("console.explain")));
    expect(api.execute.mock.calls[0][1].sql).toBe(
      "EXPLAIN (FORMAT JSON) select * from orders o join users u on u.id = o.user_id",
    );
    const tree = await screen.findByRole("tree", { name: "Execution plan" });
    expect(screen.getByRole("tab", { name: "Explain plan" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const items = within(tree).getAllByRole("treeitem");
    expect(items.map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "2", "3"]);
    expect(items[0]).toHaveTextContent("Hash Join (Inner)");
    expect(items[0]).toHaveTextContent("rows ≈ 120");
    expect(items[0]).toHaveTextContent("cost 12.50..48.25");
    expect(items[1]).toHaveTextContent("Seq Scan");
    expect(items[1]).toHaveTextContent("on orders o");
    expect(within(tree).getByText("Filter: (total > 100)")).toBeInTheDocument();
    expect(screen.getByText("Execution time: 3.4 ms")).toBeInTheDocument();
  });

  it("falls back to the raw rows when the plan isn't recognised", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      send({ event: "columns", result_id: 1, statement: 0, columns });
      send({ event: "rows", result_id: 1, rows: [[text("Seq Scan on t")]] });
      send({
        event: "done",
        result_id: 1,
        summary: { rows_affected: null, elapsed_ms: 1, has_more: false },
      });
      return null;
    });
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.explain")));
    expect(await screen.findByText("Seq Scan on t")).toBeInTheDocument();
  });

  it("explains an error at the user's token, not the EXPLAIN prefix", async () => {
    const sql = "select nope from t";
    api.execute.mockImplementation(async (_s: string, req: { sql: string }, send: Send) => {
      const position = req.sql.indexOf("nope") + 1;
      send({
        event: "error",
        result_id: null,
        statement: 0,
        error: { code: "query_failed", message: "no column", position },
      });
      return null;
    });
    const { view } = await mountConsole(sql, 2);
    await act(async () => void (await runCommand("console.explain")));
    const marks: [number, number][] = [];
    forEachDiagnostic(view.state, (_d, from, to) => marks.push([from, to]));
    expect(marks.map(([f, t]) => sql.slice(f, t))).toEqual(["nope"]);
    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
  });

  it("Explain Analyze of a SELECT runs without a prompt", async () => {
    await mountConsole("select 1", 3);
    await act(async () => void (await runCommand("console.explainAnalyze")));
    expect(api.execute.mock.calls.map((c) => c[1].sql)).toEqual([
      "EXPLAIN (ANALYZE, FORMAT JSON) select 1",
    ]);
  });

  it("Explain Analyze of a write asks first, then runs it inside a rolled-back transaction", async () => {
    await mountConsole("update orders set total = 0", 3);
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = runCommand("console.explainAnalyze");
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Explain Analyze runs the statement")).toBeInTheDocument();
    expect(within(dialog).getByText(/rolled\s+back/)).toBeInTheDocument();
    expect(api.execute).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run Explain Analyze" }));
    await act(async () => void (await done));
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(3));
    expect(api.execute.mock.calls.map((c) => c[1].sql)).toEqual([
      "BEGIN",
      "EXPLAIN (ANALYZE, FORMAT JSON) update orders set total = 0",
      "ROLLBACK",
    ]);
  });

  it("rolls back even when the explained statement fails", async () => {
    api.execute.mockImplementation(async (_s: string, req: { sql: string }, send: Send) => {
      if (req.sql.startsWith("EXPLAIN")) {
        send({
          event: "error",
          result_id: null,
          statement: 0,
          error: { code: "query_failed", message: "boom" },
        });
      }
      return null;
    });
    await mountConsole("delete from t", 3);
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = runCommand("console.explainAnalyze");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Run Explain Analyze" }));
    await act(async () => void (await done));
    await waitFor(() => expect(api.execute.mock.calls.slice(-1)[0][1].sql).toBe("ROLLBACK"));
  });

  it("declining the Explain Analyze warning runs nothing", async () => {
    await mountConsole("update t set a = 1", 3);
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = runCommand("console.explainAnalyze");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(async () => void (await done));
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("refuses to Explain Analyze a write on a read-only connection", async () => {
    await mountConsole("update t set a = 1", 3, "c2");
    await act(async () => void (await runCommand("console.explainAnalyze")));
    expect(api.execute).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useNotices.getState().notices[0].message).toMatch(/read-only/);
  });

  it("says so when the driver can't analyze", async () => {
    const sqlite = toConnection({ ...newDraft("sqlite"), id: "c3", name: "lite" });
    useConnections.setState({ file: { version: 1, groups: [], connections: [sqlite] } });
    await mountConsole("select 1", 3, "c3");
    await act(async () => void (await runCommand("console.explainAnalyze")));
    expect(api.execute).not.toHaveBeenCalled();
    expect(await screen.findByText("SQLite can't run EXPLAIN ANALYZE")).toBeInTheDocument();
  });

  it("offers Explain Analyze from the toolbar menu", async () => {
    await mountConsole("select 1", 3);
    fireEvent.click(screen.getByRole("button", { name: "More explain options" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Explain Analyze…" })),
    );
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
    expect(api.execute.mock.calls[0][1].sql).toMatch(/^EXPLAIN \(ANALYZE/);
  });
});
