import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds, getTabKind } from "../../shell/registry/tabKinds";
import { useWorkspace } from "../../stores/workspaceStore";
import { nodeMenu } from "../explorer/menus";
import { registerConsoleCommands } from "../console/commands";
import { graphTargetOf } from "./explorerTarget";
import { viewAfterRun } from "./commands";
import { buildGraph } from "./graphModel";
import { registerGraphCommands, registerGraphTab } from "./GraphTab";
import { GRAPH_KIND, deserializeGraph, serializeGraph } from "./state";
import type { GraphTabState } from "./state";
import type { GraphNode, GraphRel } from "./types";

vi.mock("cytoscape", () => import("./cytoscape.fake"));
vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));
vi.mock("../../lib/ipc/drivers", () => ({
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  queryCancel: vi.fn(),
}));
vi.mock("./api", () => ({}));

const conn = {
  ...toConnection({ ...newDraft("neo4j"), id: "g1", name: "staging-neo4j" }),
  environment: "staging" as const,
};
const pg = toConnection({ ...newDraft("postgres"), id: "p1", name: "pg" });

describe("opening consoles on Neo4j connections", () => {
  let offs: (() => void)[] = [];
  beforeEach(() => {
    clearShortcuts();
    clearCommands();
    clearTabKinds();
    useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
    useConnections.setState((s) => ({ file: { ...s.file, connections: [conn, pg] } }));
    offs = [registerGraphTab(), registerGraphCommands(), registerConsoleCommands()];
  });
  afterEach(() => offs.forEach((off) => off()));

  it("opens the graph console for `console.new` on a Neo4j connection, the SQL console otherwise", async () => {
    await runCommand("console.new", { connectionId: "g1", database: "movies" });
    await runCommand("console.new", { connectionId: "p1" });
    const tabs = useWorkspace.getState().tabs;
    expect(tabs.map((t) => t.kind)).toEqual([GRAPH_KIND, "console"]);
    expect(tabs[0].state).toMatchObject({ connectionId: "g1", database: "movies", view: "graph" });
  });

  it("opens a console with a query to run from `graph.open`", async () => {
    await runCommand("graph.open", {
      connectionId: "g1",
      cypher: "MATCH (n:Product) RETURN n LIMIT 25",
      run: true,
    });
    expect(useWorkspace.getState().tabs[0].state).toMatchObject({
      text: "MATCH (n:Product) RETURN n LIMIT 25",
      autoRun: true,
    });
  });

  it("registers the tab kind with a title, the connection as subtitle and the env stripe", () => {
    const kind = getTabKind(GRAPH_KIND)!;
    const state = deserializeGraph({ connectionId: "g1" });
    expect(kind.title(state)).toBe("cypher");
    expect(kind.subtitle?.(state)).toBe("staging-neo4j");
    expect(kind.env?.(state)).toBe("staging");
  });
});

describe("tab state", () => {
  it("round-trips through the session and drops transient fields", () => {
    const state: GraphTabState = {
      connectionId: "g1",
      database: "movies",
      text: "MATCH (n) RETURN n",
      params: '{"a":1}',
      paramsOpen: true,
      view: "json",
      inspectorOpen: false,
      sessionId: "s1",
      autoRun: true,
    };
    const saved = serializeGraph(state);
    expect(saved).not.toHaveProperty("sessionId");
    expect(saved).not.toHaveProperty("autoRun");
    expect(deserializeGraph(JSON.parse(JSON.stringify(saved)))).toEqual({
      connectionId: "g1",
      database: "movies",
      text: "MATCH (n) RETURN n",
      params: '{"a":1}',
      paramsOpen: true,
      view: "json",
      inspectorOpen: false,
    });
  });

  it("repairs damaged state and refuses a console without a connection", () => {
    expect(deserializeGraph({ connectionId: "g1", view: "weird", params: "  " })).toMatchObject({
      view: "graph",
      params: "{}",
      inspectorOpen: true,
    });
    expect(() => deserializeGraph({})).toThrow();
  });
});

describe("view after a run", () => {
  it("opens the plan for EXPLAIN and PROFILE, and the table for scalar results", () => {
    expect(viewAfterRun("graph", "profile", true, null)).toEqual({
      view: "plan",
      autoFrom: "graph",
    });
    expect(viewAfterRun("graph", "run", false, null)).toEqual({ view: "table", autoFrom: "graph" });
    expect(viewAfterRun("json", "run", false, null)).toEqual({ view: "json", autoFrom: null });
  });

  it("goes back to where the user was once a graph returns", () => {
    expect(viewAfterRun("table", "run", true, "graph")).toEqual({ view: "graph", autoFrom: null });
    expect(viewAfterRun("plan", "run", true, "graph")).toEqual({ view: "graph", autoFrom: null });
    expect(viewAfterRun("plan", "run", true, null)).toEqual({ view: "graph", autoFrom: null });
    expect(viewAfterRun("table", "run", true, null)).toEqual({ view: "table", autoFrom: null });
  });
});

describe("explorer targets (spec: graph-browser › Explorer, palette and AI integration)", () => {
  const path = (...segments: [string, string][]) =>
    segments.map(([kind, name]) => ({ kind, name }));

  it("maps databases, labels and relationship types", () => {
    const db = path(["database", "movies"]);
    expect(graphTargetOf(db as never, "database")).toEqual({
      kind: "database",
      database: "movies",
      name: "movies",
    });
    const label = path(["database", "movies"], ["group", "Node labels"], ["table", "Product"]);
    expect(graphTargetOf(label as never, "table")).toEqual({
      kind: "label",
      database: "movies",
      name: "Product",
      cypher: "MATCH (n:Product) RETURN n LIMIT 25",
    });
    const type = path(["database", "movies"], ["group", "Relationship types"], ["table", "BOUGHT"]);
    expect(graphTargetOf(type as never, "table")?.cypher).toBe(
      "MATCH p=()-[:BOUGHT]->() RETURN p LIMIT 25",
    );
    const index = path(["database", "movies"], ["group", "Indexes"], ["index", "i"]);
    expect(graphTargetOf(index as never, "index")).toBeNull();
  });

  it("offers the matching menu entries", () => {
    const entry = (kind: string, p: ReturnType<typeof path>) =>
      ({
        id: "x",
        connId: "g1",
        parentId: null,
        kind,
        name: "n",
        path: p,
        hasChildren: false,
        childIds: [],
        state: "loaded",
      }) as never;
    const labelItems = nodeMenu(
      entry("table", path(["database", "d"], ["group", "Node labels"], ["table", "Product"])),
      "neo4j",
    );
    expect(labelItems[0]).toEqual({ id: "explorer.openData", label: "Show nodes" });
    expect(nodeMenu(entry("database", path(["database", "d"])), "neo4j")[0].label).toBe(
      "Open Cypher console",
    );
  });
});

describe("test-mode graph mirror (task 6.0)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const nodes: GraphNode[] = [
    {
      elementId: "n1",
      labels: ["User"],
      properties: { name: { kind: "text" as const, value: "Ada" } },
    },
    { elementId: "n2", labels: ["Product"], properties: {} },
  ];
  const rels: GraphRel[] = [
    { elementId: "r1", relType: "PURCHASED", startId: "n1", endId: "n2", properties: {} },
  ];
  const props = () => ({
    built: buildGraph(nodes, rels, { cap: null, hidden: new Set(), captions: {} }),
    nodes,
    relationships: rels,
    epoch: 1,
    selectedId: null,
    capNotice: null,
    hiddenCount: 0,
    onSelect: () => {},
    onExpand: () => {},
    onShowAll: () => {},
    onUseTable: () => {},
    onUnhide: () => {},
  });

  it("exposes data-testid nodes and edges only when VITE_CLEW_E2E=1", async () => {
    vi.stubEnv("VITE_CLEW_E2E", "1");
    vi.resetModules();
    const { GraphCanvas } = await import("./GraphCanvas");
    render(<GraphCanvas {...props()} />);
    const mirror = screen.getByTestId("graph-mirror");
    expect(mirror).toHaveAttribute("data-node-count", "2");
    expect(mirror).toHaveAttribute("data-edge-count", "1");
    const nodeButtons = screen.getAllByTestId("graph-node");
    expect(
      nodeButtons.map((n) => [n.getAttribute("data-id"), n.getAttribute("data-caption")]),
    ).toEqual([
      ["n1", "Ada"],
      ["n2", "n2"],
    ]);
    const edge = screen.getByTestId("graph-edge");
    expect(edge).toHaveAttribute("data-type", "PURCHASED");
    expect(edge).toHaveAttribute("data-source", "n1");
    expect(edge).toHaveAttribute("data-target", "n2");
  });

  it("has no test ids in a normal build", async () => {
    vi.resetModules();
    const { GraphCanvas } = await import("./GraphCanvas");
    render(<GraphCanvas {...props()} />);
    expect(screen.queryByTestId("graph-node")).toBeNull();
    expect(screen.queryByTestId("graph-mirror")).toBeNull();
    expect(screen.getByRole("list", { name: "Graph elements" })).toBeInTheDocument();
  });
});
