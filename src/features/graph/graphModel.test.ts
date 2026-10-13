import { describe, expect, it } from "vitest";
import {
  NODE_CAP,
  buildGraph,
  captionOf,
  cellSummary,
  mergeById,
  recordsAsJson,
} from "./graphModel";
import { matchCypher, relTypeQuery, labelQuery, setStatement } from "./cypherText";
import { LABEL_TOKENS, tokenOfLabel } from "./palette";
import { flattenPlan, maxDbHits } from "./planModel";
import { schemaItemText, listedSchemaItems } from "./SchemaSidebar";
import type { GraphNode, GraphRel } from "./types";

const text = (value: string) => ({ kind: "text" as const, value });
const node = (
  id: string,
  labels: string[],
  properties: GraphNode["properties"] = {},
): GraphNode => ({
  elementId: id,
  labels,
  properties,
});
const rel = (id: string, type: string, a: string, b: string): GraphRel => ({
  elementId: id,
  relType: type,
  startId: a,
  endId: b,
  properties: {},
});

const none = { cap: null, hidden: new Set<string>(), captions: {} };

describe("GraphResult -> Cytoscape elements (spec: graph-browser › Graph view)", () => {
  const nodes = [
    node("n1", ["User"], { name: text("Ada Lovelace") }),
    node("n2", ["Product"], { title: text("Brass Lamp") }),
    node("n3", ["User"], { name: text("Grace") }),
  ];
  const rels = [rel("r1", "PURCHASED", "n1", "n2"), rel("r2", "PURCHASED", "n3", "n2")];

  it("maps nodes and relationships with captions, label colours and types", () => {
    const built = buildGraph(nodes, rels, none);
    expect(built.elements.filter((e) => e.group === "nodes").map((e) => e.data)).toEqual([
      { id: "n1", caption: "Ada Lovelace", label: "User", token: tokenOfLabel("User") },
      { id: "n2", caption: "Brass Lamp", label: "Product", token: tokenOfLabel("Product") },
      { id: "n3", caption: "Grace", label: "User", token: tokenOfLabel("User") },
    ]);
    expect(built.elements.filter((e) => e.group === "edges").map((e) => e.data)).toEqual([
      { id: "r1", source: "n1", target: "n2", type: "PURCHASED" },
      { id: "r2", source: "n3", target: "n2", type: "PURCHASED" },
    ]);
    expect(built.labels.map((l) => [l.name, l.count])).toEqual([
      ["User", 2],
      ["Product", 1],
    ]);
    expect(built.types).toEqual([{ name: "PURCHASED", count: 2 }]);
    expect(built.total).toBe(3);
  });

  it("drops relationships whose end is hidden or missing, and duplicates", () => {
    const built = buildGraph(nodes, [...rels, rels[0], rel("r9", "X", "n1", "gone")], {
      ...none,
      hidden: new Set(["n3"]),
    });
    expect(built.shown).toEqual(["n1", "n2"]);
    expect(built.edges).toBe(1);
    expect(built.total).toBe(2);
  });

  it("draws the first 300 nodes and reports the total (spec: graph-browser › Too many nodes)", () => {
    const many = Array.from({ length: 301 }, (_, i) => node(`n${i}`, ["User"]));
    const built = buildGraph(many, [rel("r", "KNOWS", "n0", "n300")], {
      ...none,
      cap: NODE_CAP,
    });
    expect(built.shown).toHaveLength(300);
    expect(built.total).toBe(301);
    expect(built.edges).toBe(0); // n300 is not drawn
    expect(buildGraph(many, [], none).shown).toHaveLength(301);
  });

  it("chooses captions: the picked property, name, title, first string, the id", () => {
    const n = node("e:1", ["Doc"], { n: { kind: "int", value: 4 }, slug: text("intro") });
    expect(captionOf(n)).toBe("intro");
    expect(captionOf(node("e:2", ["Doc"], { title: text("T"), name: text("N") }))).toBe("N");
    expect(captionOf(node("e:3", ["Doc"], { title: text("T") }))).toBe("T");
    expect(captionOf(node("e:4", ["Doc"], { n: { kind: "int", value: 4 } }))).toBe("e:4");
    expect(captionOf(n, { Doc: "n" })).toBe("4");
    expect(captionOf(n, { Doc: "missing" })).toBe("intro");
  });
});

describe("label colours", () => {
  it("are stable and come from the fixed token list", () => {
    expect(tokenOfLabel("User")).toBe(tokenOfLabel("User"));
    expect(LABEL_TOKENS).toHaveLength(10);
    for (const l of ["User", "Product", "Review", "Category", "", "Ünïcode"]) {
      expect(LABEL_TOKENS).toContain(tokenOfLabel(l));
    }
  });
});

describe("table and JSON cells", () => {
  const ada = { kind: "node" as const, ...node("n1", ["User", "Admin"], { name: text("Ada") }) };

  it("summarises nodes, relationships and paths", () => {
    expect(cellSummary(ada)).toBe('(:User:Admin {name: "Ada"})');
    expect(cellSummary({ kind: "node", ...node("n2", ["Tag"]) })).toBe("(:Tag)");
    expect(cellSummary({ kind: "relationship", ...rel("r1", "PURCHASED", "a", "b") })).toBe(
      "[:PURCHASED]",
    );
    expect(cellSummary({ kind: "int", value: 42 })).toBe("42");
    expect(cellSummary({ kind: "null" })).toBe("null");
    expect(cellSummary({ kind: "path", nodes: [node("a", [])], relationships: [] })).toContain(
      "1 node",
    );
  });

  it("converts records to JSON, keeping large integers exact", () => {
    const json = recordsAsJson({
      columns: ["u", "n"],
      records: [[ada, { kind: "bigint", value: "9007199254740993" }]],
    });
    expect(json).toEqual([
      {
        u: {
          type: "node",
          elementId: "n1",
          labels: ["User", "Admin"],
          properties: { name: "Ada" },
        },
        n: "9007199254740993",
      },
    ]);
  });

  it("merges by element id keeping first-seen order", () => {
    const merged = mergeById([node("a", []), node("b", [])], [node("b", ["X"]), node("c", [])]);
    expect(merged.map((n) => n.elementId)).toEqual(["a", "b", "c"]);
    expect(merged[1].labels).toEqual([]);
  });
});

describe("Cypher texts", () => {
  it("writes the sidebar queries", () => {
    expect(labelQuery("Product")).toBe("MATCH (n:Product) RETURN n LIMIT 25");
    expect(relTypeQuery("PURCHASED")).toBe("MATCH p=()-[:PURCHASED]->() RETURN p LIMIT 25");
    expect(labelQuery("Has Space")).toBe("MATCH (n:`Has Space`) RETURN n LIMIT 25");
  });

  it("writes the parameterised SET and the MATCH by element id", () => {
    expect(setStatement("node", ["plan"])).toBe(
      "MATCH (n) WHERE elementId(n) = $id SET n.plan = $value",
    );
    expect(setStatement("node", ["a", "b"])).toContain("n.a = $value_a, n.b = $value_b");
    expect(setStatement("relationship", ["w"])).toBe(
      "MATCH ()-[r]->() WHERE elementId(r) = $id SET r.w = $value",
    );
    expect(matchCypher(node("4:abc:1", ["User"]))).toBe(
      'MATCH (n:User) WHERE elementId(n) = "4:abc:1" RETURN n',
    );
    expect(matchCypher(rel("5:abc:2", "PURCHASED", "a", "b"))).toBe(
      'MATCH ()-[r:PURCHASED]->() WHERE elementId(r) = "5:abc:2" RETURN r',
    );
  });
});

describe("plan and schema helpers", () => {
  const plan = {
    operator: "ProduceResults",
    details: "u",
    children: [
      { operator: "Filter", details: "", dbHits: 12, children: [] },
      {
        operator: "Expand",
        details: "",
        dbHits: 90,
        children: [{ operator: "NodeByLabelScan", details: "", dbHits: 40, children: [] }],
      },
    ],
  };

  it("finds the highest db hits and flattens the tree", () => {
    expect(maxDbHits(plan)).toBe(90);
    expect(flattenPlan(plan).map((p) => [p.node.operator, p.depth])).toEqual([
      ["ProduceResults", 0],
      ["Filter", 1],
      ["Expand", 1],
      ["NodeByLabelScan", 2],
    ]);
  });

  it("writes constraints and indexes as the canvas does", () => {
    expect(
      schemaItemText({ name: "u", kind: "UNIQUENESS", labels: ["User"], properties: ["email"] }),
    ).toBe(":User(email) UNIQUE");
    expect(
      schemaItemText({ name: "r", kind: "RANGE", labels: ["Review"], properties: ["created_at"] }),
    ).toBe(":Review(created_at) RANGE");
    const listed = listedSchemaItems({
      labels: [],
      relationshipTypes: [],
      propertyKeys: [],
      constraints: [{ name: "c", kind: "UNIQUENESS", labels: ["User"], properties: ["email"] }],
      indexes: [
        { name: "c", kind: "RANGE", labels: ["User"], properties: ["email"] },
        { name: "i", kind: "TEXT", labels: ["User"], properties: ["bio"] },
      ],
    });
    expect(listed.map((i) => i.name)).toEqual(["c", "i"]);
  });
});
