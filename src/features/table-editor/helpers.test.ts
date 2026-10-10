import { describe, expect, it } from "vitest";
import type { NodePath, Value } from "../../lib/ipc/drivers";
import { applyCompletion, completeAt } from "./complete";
import { andWhere, orderFor, quickFilterSql, siblingTablePath, sortOf } from "./paths";
import { deserializeTable, rowKeyColumns, serializeTable, tableKey } from "./state";
import type { TableTabState } from "./state";

const text = (s: string): Value => ({ kind: "text", value: s });

describe("quick filters", () => {
  it("writes equals / not equals / null checks with dialect quoting", () => {
    expect(quickFilterSql("postgres", "status", text("pending"), "equals")).toBe(
      `"status" = 'pending'`,
    );
    expect(quickFilterSql("mysql", "status", text("it's"), "notEquals")).toBe(
      "`status` <> 'it''s'",
    );
    expect(quickFilterSql("postgres", "n", { kind: "int", value: 5 }, "equals")).toBe(`"n" = 5`);
    expect(quickFilterSql("postgres", "n", { kind: "null" }, "equals")).toBe(`"n" IS NULL`);
    expect(quickFilterSql("postgres", "n", { kind: "null" }, "notEquals")).toBe(`"n" IS NOT NULL`);
    expect(quickFilterSql("sqlserver", "n", { kind: "null" }, "isNull")).toBe("[n] IS NULL");
    expect(quickFilterSql("postgres", "n", text("x"), "notNull")).toBe(`"n" IS NOT NULL`);
  });

  it("escapes LIKE wildcards in Contains", () => {
    expect(quickFilterSql("postgres", "note", text("50%_off"), "contains")).toBe(
      `"note" LIKE '%50\\%\\_off%' ESCAPE '\\'`,
    );
  });

  it("ANDs a fragment onto what is there, grouping an OR", () => {
    expect(andWhere("", `"a" = 1`)).toBe(`"a" = 1`);
    expect(andWhere("b > 2;", `"a" = 1`)).toBe(`b > 2 AND "a" = 1`);
    expect(andWhere("b > 2 or c < 1", `"a" = 1`)).toBe(`(b > 2 or c < 1) AND "a" = 1`);
  });
});

describe("sort <-> ORDER BY", () => {
  const cols = ["id", "created at", "status"];
  it("writes the header cycle as ORDER BY text", () => {
    expect(orderFor("postgres", "created at", "desc")).toBe(`"created at" DESC`);
    expect(orderFor("postgres", "id", null)).toBe("");
  });

  it("recognises exactly one column and a direction", () => {
    expect(sortOf("postgres", `"created at" DESC`, cols)).toEqual({ column: 1, dir: "desc" });
    expect(sortOf("postgres", "status asc", cols)).toEqual({ column: 2, dir: "asc" });
    expect(sortOf("postgres", "  id  ", cols)).toEqual({ column: 0, dir: "asc" });
    expect(sortOf("postgres", "id DESC, status", cols)).toBeNull();
    expect(sortOf("postgres", "", cols)).toBeNull();
  });
});

describe("sibling table paths", () => {
  const pg: NodePath = [
    { kind: "database", name: "analytics" },
    { kind: "schema", name: "public" },
    { kind: "group", name: "tables" },
    { kind: "table", name: "orders" },
  ];
  it("keeps the database and uses the referenced schema", () => {
    expect(siblingTablePath(pg, "billing", "invoices").map((s) => s.name)).toEqual([
      "analytics",
      "billing",
      "tables",
      "invoices",
    ]);
    expect(siblingTablePath(pg, null, "users").map((s) => s.name)).toEqual([
      "analytics",
      "public",
      "tables",
      "users",
    ]);
  });

  it("treats the referenced schema as a database on MySQL-like servers", () => {
    const my: NodePath = [
      { kind: "database", name: "shop" },
      { kind: "group", name: "tables" },
      { kind: "table", name: "orders" },
    ];
    expect(siblingTablePath(my, "crm", "customers").map((s) => s.name)).toEqual([
      "crm",
      "tables",
      "customers",
    ]);
    expect(siblingTablePath(my, null, "items").map((s) => s.name)).toEqual([
      "shop",
      "tables",
      "items",
    ]);
  });
});

describe("column completion", () => {
  const cols = ["id", "user_id", "status", "total", "created_at"];
  it("suggests prefix matches first, then others containing the word", () => {
    expect(completeAt("st", 2, cols)?.items).toEqual(["status"]);
    expect(completeAt("status = 'a' AND us", 18, cols)?.items).toEqual(["user_id", "status"]);
    // A word that is already a whole column name is not offered back to the user.
    expect(completeAt("id", 2, cols)?.items).toEqual(["user_id"]);
  });

  it("matches inside names too", () => {
    expect(completeAt("at", 2, cols)?.items).toEqual(
      ["status", "created_at"].filter((c) => c.includes("at")),
    );
  });

  it("stays quiet inside a string and with nothing typed", () => {
    expect(completeAt("name = 'sta", 11, cols)).toBeNull();
    expect(completeAt("status = ", 9, cols)).toBeNull();
  });

  it("inserts the column, quoting names that need it", () => {
    const c = completeAt("a = 1 AND us", 12, cols)!;
    expect(applyCompletion("a = 1 AND us", c, "user_id", "postgres")).toEqual({
      text: "a = 1 AND user_id",
      caret: 17,
    });
    const q = completeAt("cre", 3, ["Created At"])!;
    expect(applyCompletion("cre", q, "Created At", "mysql").text).toBe("`Created At`");
  });
});

describe("row keys", () => {
  const c = (name: string, nullable: boolean, primaryKey = false) => ({
    name,
    nullable,
    primaryKey,
  });
  it("uses the primary key", () => {
    expect(rowKeyColumns({ columns: [c("id", false, true), c("n", true)], indexes: [] })).toEqual([
      "id",
    ]);
    expect(
      rowKeyColumns({ columns: [c("a", false, true), c("b", false, true)], indexes: [] }),
    ).toEqual(["a", "b"]);
  });

  it("falls back to a unique index whose columns cannot be NULL", () => {
    const columns = [c("email", false), c("code", true)];
    expect(
      rowKeyColumns({
        columns,
        indexes: [
          { columns: ["code"], unique: true, primary: false },
          { columns: ["email"], unique: true, primary: false },
        ],
      }),
    ).toEqual(["email"]);
    expect(
      rowKeyColumns({ columns, indexes: [{ columns: ["code"], unique: true, primary: false }] }),
    ).toBeNull();
    expect(
      rowKeyColumns({ columns, indexes: [{ columns: ["email"], unique: false, primary: false }] }),
    ).toBeNull();
  });
});

describe("tab state", () => {
  const state: TableTabState = {
    connectionId: "c1",
    path: [{ kind: "table", name: "t" }],
    view: "indexes",
    where: "a = 1",
    orderBy: "id",
    pageSize: 100,
    page: 3,
    record: true,
    sessionId: "s1",
    focusColumn: "a",
  };

  it("drops transient fields when saved", () => {
    const saved = serializeTable(state);
    expect(saved).not.toHaveProperty("sessionId");
    expect(saved).not.toHaveProperty("focusColumn");
    expect(deserializeTable(JSON.parse(JSON.stringify(saved)))).toEqual({ ...saved });
  });

  it("repairs what an older save got wrong", () => {
    expect(
      deserializeTable({
        connectionId: "c",
        path: [{ kind: "table", name: "t" }],
        view: "nope",
        pageSize: 7,
        page: -1,
      }),
    ).toMatchObject({
      view: "data",
      pageSize: 500,
      page: 0,
      where: "",
    });
    expect(() => deserializeTable({ connectionId: "c", path: [] })).toThrow();
  });

  it("keys a tab by connection and path", () => {
    expect(tableKey("c1", state.path)).toBe("table:c1/table:t");
  });
});
