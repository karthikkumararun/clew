import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { clearCommands, registerCommand } from "../../shell/registry/commands";
import { conn } from "../explorer/testing";
import type { PaletteHit } from "./api";
import { openHit, starterText } from "./openObject";

const neo = conn("n1", "graph", { driver: "neo4j" });
const mongo = conn("m1", "dev-mongo", { driver: "mongodb" });
const pg = conn("p1", "pg");

const calls = {
  graph: vi.fn(),
  collection: vi.fn(),
  table: vi.fn(),
  filter: vi.fn(),
  console: vi.fn(),
};

const hit = (connectionId: string, over: Partial<PaletteHit["entry"]>): PaletteHit => ({
  entry: {
    connectionId,
    database: "",
    kind: "table",
    name: "x",
    parentLabel: "",
    path: [],
    updatedAt: 0,
    ...over,
  },
  indices: [],
  score: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearCommands();
  useConnections.setState({
    file: { version: 1, groups: [], connections: [neo, mongo, pg] },
    connected: { n1: {} as never, m1: {} as never, p1: {} as never },
    connect: vi.fn(async () => true),
  });
  registerCommand({ id: "graph.open", title: "g", category: "x", run: calls.graph });
  registerCommand({ id: "collection.open", title: "c", category: "x", run: calls.collection });
  registerCommand({ id: "table.open", title: "t", category: "x", run: calls.table });
  registerCommand({ id: "table.filterByColumn", title: "f", category: "x", run: calls.filter });
  registerCommand({ id: "console.new", title: "n", category: "x", run: calls.console });
});

describe("openHit (spec: command-palette › Result actions; graph-browser › Explorer, palette and AI integration)", () => {
  it("a graph label opens a graph console with its query already run", async () => {
    await openHit(hit("n1", { kind: "label", name: "Person", database: "neo4j" }), "open");
    expect(calls.graph).toHaveBeenCalledWith({
      connectionId: "n1",
      database: "neo4j",
      cypher: "MATCH (n:Person) RETURN n LIMIT 25",
      run: true,
    });
  });

  it("Alt+Enter on a relationship type opens a console with the query, not run", async () => {
    await openHit(
      hit("n1", { kind: "relationship_type", name: "KNOWS", database: "neo4j" }),
      "console",
    );
    expect(calls.console).toHaveBeenCalledWith({
      connectionId: "n1",
      database: "neo4j",
      schema: undefined,
      sql: "MATCH p=()-[:KNOWS]->() RETURN p LIMIT 25",
    });
    expect(calls.graph).not.toHaveBeenCalled();
  });

  it("a collection opens the document browser; Alt+Enter writes a find()", async () => {
    const h = hit("m1", {
      kind: "collection",
      name: "carts",
      database: "shop",
      path: [
        { kind: "database", name: "shop" },
        { kind: "table", name: "carts" },
      ],
    });
    await openHit(h, "open");
    expect(calls.collection).toHaveBeenCalledWith({
      connectionId: "m1",
      database: "shop",
      collection: "carts",
    });
    expect(starterText(h, "mongodb")).toBe("db.carts.find({})");
  });

  it("a field opens its collection", async () => {
    await openHit(
      hit("m1", {
        kind: "field",
        name: "carts.orderRef",
        path: [
          { kind: "database", name: "shop" },
          { kind: "table", name: "carts" },
        ],
      }),
      "open",
    );
    expect(calls.collection.mock.calls[0][0].collection).toBe("carts");
  });

  it("a column opens its table focused on that column", async () => {
    const path = [
      { kind: "schema" as const, name: "public" },
      { kind: "table" as const, name: "orders" },
    ];
    await openHit(hit("p1", { kind: "column", name: "orders.customer_id", path }), "open");
    expect(calls.filter).toHaveBeenCalledWith({
      connectionId: "p1",
      path,
      column: "customer_id",
    });
  });

  it("does nothing for a connection that was deleted", async () => {
    await openHit(hit("gone", {}), "open");
    expect(calls.table).not.toHaveBeenCalled();
  });
});
