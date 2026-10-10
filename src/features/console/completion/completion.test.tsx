import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { act, render } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaSnapshot } from "../../../lib/ipc/drivers";
import { Editor } from "../editor/Editor";
import { getView } from "../editor/views";
import { suggest, tableRefs } from "./engine";
import { sqlCompletion } from "./extension";
import type { CompletionTarget } from "./extension";
import {
  changesSchema,
  clearSnapshots,
  invalidateSnapshots,
  loadSnapshot,
  peekSnapshot,
} from "./snapshots";

const api = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../../../lib/ipc/drivers", () => ({
  completionSnapshot: (...a: unknown[]) => api.snapshot(...a),
}));

const col = (name: string, type_name: string) => ({ name, type_name });
const SNAPSHOT: SchemaSnapshot = {
  schemas: [
    {
      name: "public",
      functions: ["add_one"],
      tables: [
        {
          name: "orders",
          kind: "table",
          columns: [col("id", "int8"), col("user_id", "int8"), col("created_at", "timestamptz")],
        },
        {
          name: "users",
          kind: "table",
          columns: [col("id", "int8"), col("name", "text"), col("created_at", "timestamptz")],
        },
        { name: "order_totals", kind: "view", columns: [col("total", "numeric")] },
        { name: "Mixed Case", kind: "table", columns: [col("Odd Col", "text")] },
      ],
    },
    {
      name: "billing",
      functions: [],
      tables: [{ name: "invoices", kind: "table", columns: [col("amount", "numeric")] }],
    },
  ],
};

const KEYWORDS = ["SELECT", "FROM", "WHERE", "JOIN", "ORDER", "GROUP"];
const input = (before: string, over: Partial<Parameters<typeof suggest>[0]> = {}) => ({
  before,
  after: "",
  snapshot: SNAPSHOT,
  driver: "postgres",
  defaultSchema: "public",
  keywords: KEYWORDS,
  ...over,
});
const labels = (s: { label: string }[]) => s.map((x) => x.label);

describe("tableRefs", () => {
  it("finds tables with and without aliases", () => {
    expect(
      tableRefs("SELECT * FROM orders o JOIN users AS u ON u.id = o.user_id WHERE o.id = 1"),
    ).toEqual([
      { alias: "o", table: "orders", schema: undefined },
      { alias: "u", table: "users", schema: undefined },
    ]);
  });

  it("handles schema-qualified, quoted and comma-separated tables", () => {
    expect(tableRefs('select 1 from billing.invoices i, "Mixed Case" m, users')).toEqual([
      { alias: "i", table: "invoices", schema: "billing" },
      { alias: "m", table: "Mixed Case", schema: undefined },
      { alias: "users", table: "users", schema: undefined },
    ]);
  });

  it("never mistakes a keyword for an alias", () => {
    const refs = tableRefs("select * from orders where id = 1");
    expect(refs).toEqual([{ alias: "orders", table: "orders", schema: undefined }]);
    expect(tableRefs("update orders set a = 1")[0].alias).toBe("orders");
    expect(tableRefs("select * from orders left join users on true").map((r) => r.alias)).toEqual([
      "orders",
      "users",
    ]);
  });
});

describe("suggest", () => {
  it("lists the columns of an aliased table after `alias.`, with types", () => {
    const s = suggest(
      input("select o. from orders o", { before: "select o.", after: " from orders o" }),
    );
    expect(labels(s)).toEqual(["id", "user_id", "created_at"]);
    expect(s.map((x) => x.right)).toEqual(["int8", "int8", "timestamptz"]);
    expect(new Set(s.map((x) => x.kind))).toEqual(new Set(["column"]));
  });

  it("resolves the alias that is declared after the cursor", () => {
    const s = suggest(
      input("select o.cr", { after: " from orders o join users u on u.id = o.user_id" }),
    );
    expect(labels(s)).toContain("created_at");
    expect(labels(s)).not.toContain("name");
  });

  it("qualifies columns when several tables are in scope", () => {
    const s = suggest(input("select cr", { after: " from orders o join users u on true" }));
    expect(labels(s)).toEqual(expect.arrayContaining(["o.created_at", "u.created_at", "u.name"]));
  });

  it("offers plain column names for a single table", () => {
    const s = suggest(input("select ", { after: " from orders" }));
    expect(labels(s)).toEqual(expect.arrayContaining(["id", "user_id", "created_at"]));
  });

  it("completes a table's columns by name or schema-qualified name", () => {
    expect(labels(suggest(input("select users.")))).toEqual(["id", "name", "created_at"]);
    expect(labels(suggest(input("select * from billing.")))).toEqual(["invoices"]);
  });

  it("completes the tables of a schema after `schema.`", () => {
    const s = suggest(input("select * from public."));
    expect(labels(s)).toEqual(
      expect.arrayContaining(["orders", "users", "order_totals", "add_one"]),
    );
    expect(s.find((x) => x.label === "order_totals")?.kind).toBe("view");
  });

  it("puts tables first after FROM and columns/functions first after SELECT", () => {
    const top = (before: string, after = "") =>
      suggest(input(before, { after })).sort((a, b) => b.boost - a.boost)[0];
    expect(top("select * from ").kind).toBe("table");
    expect(top("select ", " from orders").kind).toBe("column");
    const afterFrom = suggest(input("select * from "));
    expect(labels(afterFrom)).not.toContain("count"); // no functions where a table goes
  });

  it("quotes names that aren't plain words", () => {
    const t = suggest(input("select * from ")).find((x) => x.label === "Mixed Case");
    expect(t?.insert).toBe('"Mixed Case"');
    const mysql = suggest(input("select * from ", { driver: "mysql" })).find(
      (x) => x.label === "Mixed Case",
    );
    expect(mysql?.insert).toBe("`Mixed Case`");
    const c = suggest(input('select "Mixed Case".'));
    expect(c.find((x) => x.label === "Odd Col")?.insert).toBe('"Odd Col"');
  });

  it("offers functions with signatures", () => {
    const max = suggest(input("select ma")).find((x) => x.label === "max");
    expect(max).toMatchObject({ kind: "aggregate", signature: "(expr)", right: "aggregate" });
    expect(suggest(input("select ma")).find((x) => x.label === "add_one")?.kind).toBe("function");
  });

  it("falls back to keywords and functions without a snapshot", () => {
    const s = suggest(input("sel", { snapshot: null }));
    expect(labels(s)).toEqual(expect.arrayContaining(["SELECT", "count"]));
    expect(s.some((x) => x.kind === "table")).toBe(false);
    expect(suggest(input("o.", { snapshot: null }))).toEqual([]);
  });

  it("is fast on a huge schema", () => {
    const big: SchemaSnapshot = {
      schemas: [
        {
          name: "public",
          functions: [],
          tables: Array.from({ length: 500 }, (_, t) => ({
            name: `t${t}`,
            kind: "table" as const,
            columns: Array.from({ length: 100 }, (_, c) => col(`c${c}`, "int4")),
          })),
        },
      ],
    };
    const start = performance.now();
    suggest(input("select t42.", { snapshot: big }));
    suggest(input("select * from ", { snapshot: big }));
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("snapshot cache", () => {
  beforeEach(() => {
    clearSnapshots();
    api.snapshot.mockReset();
  });

  it("fetches once per database and shares the answer", async () => {
    api.snapshot.mockResolvedValue(SNAPSHOT);
    const [a, b] = await Promise.all([loadSnapshot("c1", "db"), loadSnapshot("c1", "db")]);
    expect(a).toBe(b);
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(peekSnapshot("c1", "db")).toBe(SNAPSHOT);
    expect(await loadSnapshot("c1", "db")).toBe(SNAPSHOT);
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    await loadSnapshot("c1", "other");
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache a failure", async () => {
    api.snapshot.mockRejectedValueOnce(new Error("not connected")).mockResolvedValueOnce(SNAPSHOT);
    await expect(loadSnapshot("c1", "db")).rejects.toThrow("not connected");
    expect(await loadSnapshot("c1", "db")).toBe(SNAPSHOT);
  });

  it("refreshes after a schema change and discards an answer that raced it", async () => {
    let release: (s: SchemaSnapshot) => void = () => {};
    api.snapshot.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const stale = loadSnapshot("c1", "db");
    invalidateSnapshots("c1");
    const fresh: SchemaSnapshot = { schemas: [] };
    api.snapshot.mockResolvedValueOnce(fresh);
    release(SNAPSHOT);
    expect(await stale).toBe(fresh);
    expect(peekSnapshot("c1", "db")).toBe(fresh);
  });

  it("knows which statements change the schema", () => {
    for (const sql of [
      "CREATE TABLE t (id int)",
      "  alter table t add column x int",
      "-- add it\nDROP VIEW v",
      "/* c */ truncate t",
      "COMMENT ON TABLE t IS 'x'",
    ]) {
      expect(changesSchema(sql), sql).toBe(true);
    }
    for (const sql of ["select 1", "insert into create_log values (1)", "update t set a=1"]) {
      expect(changesSchema(sql), sql).toBe(false);
    }
  });
});

describe("in the editor", () => {
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
  beforeEach(() => {
    clearSnapshots();
    api.snapshot.mockReset();
  });

  const target: CompletionTarget = {
    connectionId: "c1",
    driver: "postgres",
    database: "db",
    defaultSchema: "public",
    connected: true,
  };

  function mount(value: string) {
    render(
      <Editor
        tabId="t1"
        driver="postgres"
        value={value}
        fontSize={13}
        extensions={sqlCompletion(() => target)}
        onChange={() => {}}
        onRunStatement={() => {}}
      />,
    );
    const view = getView("t1")!;
    act(() => view.dispatch({ selection: { anchor: value.length } }));
    return view;
  }
  const names = (view: NonNullable<ReturnType<typeof getView>>) =>
    currentCompletions(view.state).map((c) => c.label);

  it("lists the aliased table's columns after `o.`", async () => {
    api.snapshot.mockResolvedValue(SNAPSHOT);
    await loadSnapshot("c1", "db");
    const view = mount("select o.\nfrom orders o");
    act(() => view.dispatch({ selection: { anchor: 9 } }));
    act(() => void startCompletion(view));
    await vi.waitFor(() =>
      expect(names(view)).toEqual(expect.arrayContaining(["id", "user_id", "created_at"])),
    );
    expect(names(view)).not.toContain("name");
  });

  it("offers keywords before the snapshot arrives, then schema items without retyping", async () => {
    let release: (s: SchemaSnapshot) => void = () => {};
    api.snapshot.mockImplementation(() => new Promise((r) => (release = r)));
    const view = mount("sel");
    act(() => void startCompletion(view));
    await vi.waitFor(() => expect(names(view)).toContain("SELECT"));
    expect(names(view)).not.toContain("users");

    // Same prefix, snapshot now here: the open popup refreshes itself.
    const view2 = mount("ord");
    void view2;
    await act(async () => {
      release(SNAPSHOT);
      await Promise.resolve();
    });
    act(() => void startCompletion(getView("t1")!));
    await vi.waitFor(() => expect(names(getView("t1")!)).toContain("orders"));
  });
});
