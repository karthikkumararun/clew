import { describe, expect, it, vi } from "vitest";
import { conn } from "../explorer/testing";
import type { PaletteHit } from "./api";
import { actionItems, ago, objectItems, queryItems } from "./items";
import type { QuerySources } from "./items";

const prod = conn("c1", "prod-postgres", { environment: "production" });
const NOW = 1_000_000_000_000;

const hit = (name: string, over: Partial<PaletteHit["entry"]> = {}): PaletteHit => ({
  entry: {
    connectionId: "c1",
    database: "analytics",
    kind: "table",
    name,
    parentLabel: "analytics.public",
    path: [{ kind: "table", name }],
    updatedAt: 1,
    ...over,
  },
  indices: [0, 1, 2],
  score: 1,
});

describe("objectItems", () => {
  it("shows the connection with its environment and where the object lives", () => {
    const [item] = objectItems([hit("orders")], [prod], vi.fn());
    expect(item).toMatchObject({
      label: "orders",
      connection: { name: "prod-postgres", env: "production" },
      detail: "analytics.public",
      indices: [0, 1, 2],
      hint: "↵ open data · ⌥↵ console",
    });
  });

  it("drops hits of connections that no longer exist", () => {
    expect(objectItems([hit("orders", { connectionId: "gone" })], [prod], vi.fn())).toEqual([]);
  });

  it("labels columns, fields and graph labels", () => {
    const items = objectItems(
      [
        hit("orders.id", { kind: "column" }),
        hit("carts.orderRef", { kind: "field" }),
        hit("Person", { kind: "label" }),
      ],
      [prod],
      vi.fn(),
    );
    expect(items.map((i) => [i.icon, i.meta])).toEqual([
      ["column", "column"],
      ["field", "field"],
      ["graph", "node label"],
    ]);
  });

  it("opens with Enter and with Alt+Enter", () => {
    const open = vi.fn();
    const [item] = objectItems([hit("orders")], [prod], open);
    void item.run();
    void item.alt!();
    expect(open.mock.calls.map((c) => c[1])).toEqual(["open", "console"]);
  });
});

describe("queryItems (spec: command-palette › Recent files and queries)", () => {
  const sources: QuerySources = {
    recent: [
      {
        id: 1,
        connectionId: "c1",
        database: "analytics",
        sql: "SELECT u.id\n  FROM orders o JOIN users u",
        startedAt: NOW - 12 * 60_000,
        durationMs: 5,
        rows: 3,
        outcome: "ok",
      },
      {
        id: 2,
        connectionId: "gone",
        database: "",
        sql: "SELECT orders",
        startedAt: NOW,
        durationMs: 1,
        rows: 1,
        outcome: "ok",
      },
    ],
    scripts: [
      { connectionId: "c1", name: "weekly_report.sql", path: "/s/weekly_report.sql" },
      { connectionId: "c1", name: "orders_cleanup.sql", path: "/s/orders_cleanup.sql" },
    ],
    files: [
      { path: "/s/orders_cleanup.sql", connectionId: "c1", openedAt: NOW - 3_600_000 },
      { path: "/s/notes.sql", connectionId: "c1", openedAt: NOW - 60_000 },
    ],
  };
  const actions = { openConsole: vi.fn(), openFile: vi.fn() };
  const opts = { limit: 10, now: NOW };

  it("filters statements, scripts and files by the query, flattening whitespace", () => {
    const items = queryItems("orders", sources, [prod], actions, opts);
    expect(items.map((i) => i.label)).toEqual([
      "orders_cleanup.sql",
      "SELECT u.id FROM orders o JOIN users u",
    ]);
    expect(items[1].meta).toBe("12 min ago");
    expect(items[0].meta).toBe("1 h ago");
  });

  it("lists recent files newest first, then saved scripts, once each, with no query", () => {
    const items = queryItems("", sources, [prod], actions, { ...opts, recentOnly: true });
    expect(items.map((i) => [i.label, i.meta])).toEqual([
      ["notes.sql", "1 min ago"],
      ["orders_cleanup.sql", "1 h ago"],
      ["weekly_report.sql", "saved"],
    ]);
  });

  it("opens a statement in a console and a file in a tab", () => {
    const items = queryItems("cleanup", sources, [prod], actions, opts);
    void items[0].run();
    expect(actions.openFile).toHaveBeenCalledWith("c1", "/s/orders_cleanup.sql");
    const [q] = queryItems("join", sources, [prod], actions, opts);
    void q.run();
    expect(actions.openConsole).toHaveBeenCalledWith(
      "c1",
      "analytics",
      "SELECT u.id\n  FROM orders o JOIN users u",
    );
  });
});

describe("actionItems", () => {
  const entries = [
    { id: "connection.new", title: "New connection…", shortcut: "⌘N", run: vi.fn() },
    { id: "ctx.ddl", title: "Generate DDL for orders", run: vi.fn() },
    { id: "view.toggleSidebar", title: "Toggle sidebar", run: vi.fn() },
  ];

  it("finds actions by title and carries the shortcut", () => {
    const items = actionItems("new conn", entries, 10);
    expect(items.map((i) => i.label)).toEqual(["New connection…"]);
    expect(items[0].shortcut).toBe("⌘N");
  });

  it("matches the selection-aware entries", () => {
    expect(actionItems("ddl ord", entries, 10).map((i) => i.label)).toEqual([
      "Generate DDL for orders",
    ]);
  });

  it("honours the limit", () => {
    expect(actionItems("", entries, 2)).toHaveLength(2);
  });
});

describe("ago", () => {
  it("rounds to the nearest unit", () => {
    expect(ago(NOW - 5_000, NOW)).toBe("just now");
    expect(ago(NOW - 90 * 60_000, NOW)).toBe("2 h ago");
    expect(ago(NOW - 24 * 3_600_000, NOW)).toBe("yesterday");
    expect(ago(NOW - 5 * 24 * 3_600_000, NOW)).toBe("5 days ago");
  });
});
