import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import * as safety from "../safety/ipcMock";
import { instances } from "./cytoscape.fake";
import { GraphBrowser } from "./GraphBrowser";
import { openGraphConsole, registerGraphCommands, registerGraphTab } from "./GraphTab";
import { clearGraphRuntimes } from "./runtime";
import type { GraphResult, GraphSchema, GraphNode, GraphRel } from "./types";

const api = vi.hoisted(() => ({
  graphQuery: vi.fn(),
  graphFetchMore: vi.fn(),
  graphExpand: vi.fn(),
  graphSchema: vi.fn(),
  graphDatabases: vi.fn(),
  graphUpdateProperties: vi.fn(),
  graphSafetyCheck: vi.fn(),
  graphUpdateSafetyCheck: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  queryCancel: vi.fn(),
  switchNamespace: vi.fn(),
}));

vi.mock("cytoscape", () => import("./cytoscape.fake"));
vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("./api", () => ({
  graphQuery: (...a: unknown[]) => api.graphQuery(...a),
  graphFetchMore: (...a: unknown[]) => api.graphFetchMore(...a),
  graphExpand: (...a: unknown[]) => api.graphExpand(...a),
  graphSchema: (...a: unknown[]) => api.graphSchema(...a),
  graphDatabases: (...a: unknown[]) => api.graphDatabases(...a),
  graphUpdateProperties: (...a: unknown[]) => api.graphUpdateProperties(...a),
  graphSafetyCheck: (...a: unknown[]) => api.graphSafetyCheck(...a),
  graphUpdateSafetyCheck: (...a: unknown[]) => api.graphUpdateSafetyCheck(...a),
}));
vi.mock("../../connections/api", () => ({
  sessionSwitchNamespace: (...a: unknown[]) => api.switchNamespace(...a),
}));
vi.mock("../../lib/ipc/drivers", () => ({
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  queryCancel: (...a: unknown[]) => api.queryCancel(...a),
}));

const conn = {
  ...toConnection({ ...newDraft("neo4j"), id: "g1", name: "staging-neo4j" }),
  environment: "staging" as const,
};

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

const summary = { elapsedMs: 18, counters: {}, database: "neo4j" };

const schema: GraphSchema = {
  labels: [
    { name: "User", count: 8100 },
    { name: "Product", count: 3900 },
  ],
  relationshipTypes: [{ name: "PURCHASED", count: 120 }],
  propertyKeys: ["name", "plan"],
  indexes: [
    { name: "i", kind: "RANGE", labels: ["Review"], properties: ["created_at"], state: "ONLINE" },
  ],
  constraints: [{ name: "c", kind: "UNIQUENESS", labels: ["User"], properties: ["email"] }],
};

const ada = node("4:x:1", ["User"], { name: text("Ada Lovelace"), plan: text("pro") });
const lamp = node("4:x:2", ["Product"], { name: text("Brass Lamp") });
const bought = rel("5:x:1", "PURCHASED", "4:x:1", "4:x:2");

const graphResult = (over: Partial<GraphResult> = {}): GraphResult => ({
  columns: ["u", "p"],
  records: [
    [
      { kind: "node", ...ada },
      { kind: "node", ...lamp },
    ],
  ],
  nodes: [ada, lamp],
  relationships: [bought],
  hasMore: false,
  summary,
  ...over,
});

let result: GraphResult;
let guard: "allow" | "confirm" | "block";

function Live({ id }: { id: string }) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === id));
  return (
    <>
      {tab ? <GraphBrowser tab={tab as never} /> : null}
      <ConsolePromptHost />
      <SafetyPromptHost />
    </>
  );
}

async function mount(cypher = "MATCH (u:User) RETURN u", run = false) {
  const id = openGraphConsole({ connectionId: "g1", cypher, run });
  render(<Live id={id} />);
  await screen.findByRole("button", { name: /^User/ });
  return id;
}

const tabState = (id: string) =>
  useWorkspace.getState().tabs.find((t) => t.id === id)!.state as {
    text: string;
    view: string;
    params: string;
  };

const queries = () =>
  api.graphQuery.mock.calls.map(
    (c) =>
      c[1] as { cypher: string; mode: string; access: string; params: unknown; fetchSize: number },
  );
const userQueries = () => queries().filter((q) => !q.cypher.includes("startNode(r)"));

let offTab: () => void = () => {};
let offCommands: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  instances.length = 0;
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearGraphRuntimes();
  clearConfirms();
  setPlatformForTests("mac");
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useConnections.setState((s) => ({ file: { ...s.file, connections: [conn] } }));
  useConnections.setState({ connect: async () => true } as never);
  vi.mocked(safety.sessionReadOnly).mockResolvedValue(false);
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "Neo4j", version: "5.24" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  api.switchNamespace.mockResolvedValue("movies");
  api.graphSchema.mockResolvedValue(schema);
  api.graphDatabases.mockResolvedValue(["neo4j", "movies"]);
  result = graphResult();
  guard = "allow";
  api.graphSafetyCheck.mockImplementation(async (_s: string, cypher: string) => ({
    decision: guard,
    connection: "staging-neo4j",
    environment: "staging",
    statements: [{ text: cypher, class: guard === "allow" ? "read" : "write" }],
    token: guard === "confirm" ? "tok-1" : undefined,
    reason: guard === "block" ? "This session is read-only" : undefined,
  }));
  api.graphUpdateSafetyCheck.mockImplementation(async () => ({
    decision: guard,
    connection: "staging-neo4j",
    environment: "staging",
    statements: [{ text: "MATCH (n) SET n += $props", class: "write" }],
    token: guard === "confirm" ? "tok-1" : undefined,
    reason: guard === "block" ? "This session is read-only" : undefined,
  }));
  api.graphQuery.mockImplementation(async (_s: string, req: { cypher: string }) => {
    if (req.cypher.includes("startNode(r)")) {
      return {
        columns: ["type", "outgoing", "count"],
        records: [
          [text("PURCHASED"), { kind: "bool", value: true }, { kind: "int", value: 42 }],
          [text("FOLLOWS"), { kind: "bool", value: false }, { kind: "int", value: 130 }],
        ],
        nodes: [],
        relationships: [],
        hasMore: false,
        summary,
      } satisfies GraphResult;
    }
    return result;
  });
  api.graphExpand.mockResolvedValue({
    ...graphResult(),
    nodes: [node("4:x:3", ["User"], { name: text("Grace") })],
    relationships: [rel("5:x:2", "PURCHASED", "4:x:3", "4:x:2")],
  });
  api.graphUpdateProperties.mockResolvedValue(undefined);
  offTab = registerGraphTab();
  offCommands = registerGraphCommands();
});

afterEach(() => {
  offTab();
  offCommands();
});

describe("graph console tab (spec: graph-browser › Graph console tab)", () => {
  it("opens with the schema sidebar loaded for the database (spec: graph-browser › Open a console)", async () => {
    await mount();
    expect(api.graphSchema).toHaveBeenCalledWith("g1", undefined);
    const labels = screen.getByRole("heading", { name: "Node labels" }).parentElement!;
    expect(within(labels).getByRole("button", { name: /User\s*8\.1k/ })).toBeInTheDocument();
    expect(within(labels).getByRole("button", { name: /Product\s*3\.9k/ })).toBeInTheDocument();
    expect(screen.getByText("PURCHASED")).toBeInTheDocument();
    expect(screen.getByText(":User(email) UNIQUE")).toBeInTheDocument();
    expect(screen.getByText(":Review(created_at) RANGE")).toBeInTheDocument();
    // breadcrumb and badge
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("staging-neo4j");
    expect(within(crumbs).getByRole("button", { name: "Database: neo4j" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "STAGING · WRITE" })).toBeInTheDocument();
  });

  it("shows the READ access mode of a read-only session and hides editing", async () => {
    vi.mocked(safety.sessionReadOnly).mockResolvedValue(true);
    await mount("MATCH (u:User) RETURN u", true);
    await screen.findByRole("button", { name: "STAGING · READ" });
    await waitFor(() => expect(userQueries()).toHaveLength(1));
    expect(userQueries()[0].access).toBe("read");
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    fireEvent.click(await screen.findByRole("button", { name: /\(:User/ }));
    await screen.findByRole("button", { name: "Copy as Cypher MATCH" });
    expect(screen.queryByRole("button", { name: "Edit properties" })).toBeNull();
  });

  it("switches database from the breadcrumb menu and reloads the schema (spec: graph-browser › Switch database)", async () => {
    const id = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Database: neo4j" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /movies/ }));
    await waitFor(() =>
      expect(api.switchNamespace).toHaveBeenCalledWith("s1", { database: "movies" }),
    );
    await waitFor(() => expect(api.graphSchema).toHaveBeenLastCalledWith("g1", "movies"));
    expect(useWorkspace.getState().tabs.find((t) => t.id === id)!.state).toMatchObject({
      database: "movies",
    });
  });
});

describe("Cypher editor (spec: graph-browser › Cypher editor)", () => {
  it("asks for a missing parameter and focuses the Parameters panel (spec: graph-browser › Missing parameter)", async () => {
    await mount("MATCH (u:User {name: $name}) RETURN u");
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByText("Set a value for $name");
    const panel = screen.getByLabelText("Query parameters (JSON)");
    await waitFor(() => expect(panel).toHaveFocus());
    expect(api.graphQuery).not.toHaveBeenCalled();

    fireEvent.change(panel, { target: { value: '{"name": "Ada"}' } });
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(userQueries()).toHaveLength(1));
    expect(userQueries()[0].params).toEqual({ name: "Ada" });
  });

  it("runs with the READ/WRITE access of the session and a fetch size", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(userQueries()).toHaveLength(1));
    expect(userQueries()[0]).toMatchObject({
      cypher: "MATCH (u:User) RETURN u",
      mode: "run",
      access: "write",
      fetchSize: 500,
    });
  });
});

describe("Graph view (spec: graph-browser › Graph view)", () => {
  it("draws the distinct nodes and relationships with the summary", async () => {
    await mount("MATCH (u)-[b]->(p) RETURN u, p", true);
    await screen.findByText("2 nodes · 1 relationship · 18 ms");
    const cy = instances[instances.length - 1];
    expect(cy.nodes().map((n) => n.data)).toEqual([
      expect.objectContaining({ id: "4:x:1", caption: "Ada Lovelace", label: "User" }),
      expect.objectContaining({ id: "4:x:2", caption: "Brass Lamp", label: "Product" }),
    ]);
    expect(cy.edges().map((e) => e.data)).toEqual([
      { id: "5:x:1", source: "4:x:1", target: "4:x:2", type: "PURCHASED" },
    ]);
    const legend = screen.getByLabelText("Legend");
    expect(legend).toHaveTextContent("User 1");
    expect(legend).toHaveTextContent("PURCHASED 1");
  });

  it("shows the cap notice for more than 300 nodes (spec: graph-browser › Too many nodes)", async () => {
    const many = Array.from({ length: 301 }, (_, i) =>
      node(`n${i}`, ["User"], { name: text(`u${i}`) }),
    );
    result = graphResult({
      nodes: many,
      relationships: [],
      records: many.map((n) => [{ kind: "node", ...n }]),
    });
    await mount("MATCH (n) RETURN n", true);
    await screen.findByText(/Showing 300 of 301 nodes/);
    const cy = instances[instances.length - 1];
    expect(cy.nodes()).toHaveLength(300);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() => expect(instances[instances.length - 1].nodes()).toHaveLength(301));
    expect(screen.queryByText(/Showing 300 of/)).toBeNull();
  });

  it("offers Use Table view from the cap notice", async () => {
    const many = Array.from({ length: 301 }, (_, i) => node(`n${i}`, ["User"]));
    result = graphResult({
      nodes: many,
      relationships: [],
      records: many.map((n) => [{ kind: "node", ...n }]),
    });
    const id = await mount("MATCH (n) RETURN n", true);
    await screen.findByText(/Showing 300 of 301 nodes/);
    fireEvent.click(screen.getByRole("button", { name: "Use Table view" }));
    expect(tabState(id).view).toBe("table");
  });

  it("opens the Table view and disables Graph when the result has only scalars (spec: graph-browser › No graph values)", async () => {
    result = {
      columns: ["count(*)"],
      records: [[{ kind: "int", value: 42 }]],
      nodes: [],
      relationships: [],
      hasMore: false,
      summary,
    };
    const id = await mount("MATCH (n) RETURN count(*)", true);
    const graphTab = await screen.findByRole("tab", { name: "Graph" });
    await waitFor(() => expect(graphTab).toBeDisabled());
    expect(graphTab).toHaveAttribute("title", "No nodes or relationships in this result");
    expect(screen.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
    expect(tabState(id).view).toBe("table");
    expect(await screen.findByRole("table", { name: "Result table" })).toHaveTextContent("42");
    expect(screen.getByText("1 record · 18 ms")).toBeInTheDocument();
    expect(screen.getByText("No nodes or relationships in this result")).toBeInTheDocument();
  });

  it("returns to the Graph view when a later run has a graph", async () => {
    result = {
      ...graphResult(),
      columns: ["c"],
      records: [[{ kind: "int", value: 1 }]],
      nodes: [],
      relationships: [],
    };
    const id = await mount("RETURN 1", true);
    await waitFor(() => expect(tabState(id).view).toBe("table"));
    result = graphResult();
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(tabState(id).view).toBe("graph"));
  });

  it("expands neighbours on a double tap with a limit of 25", async () => {
    await mount("MATCH (u)-[b]->(p) RETURN u, p", true);
    await screen.findByText("2 nodes · 1 relationship · 18 ms");
    const cy = instances[instances.length - 1];
    const target = { id: () => "4:x:2" };
    act(() => {
      cy.emit("tap", target, "node");
      cy.emit("tap", target, "node");
    });
    await waitFor(() => expect(api.graphExpand).toHaveBeenCalledWith("s1", "4:x:2", 25));
    await screen.findByText("3 nodes · 2 relationships · 18 ms");
    expect(instances[instances.length - 1].nodes().map((n) => n.data.id)).toContain("4:x:3");
  });

  it("lets keyboard users Tab through nodes and Enter selects them (spec: graph-browser › Keyboard access)", async () => {
    await mount("MATCH (u)-[b]->(p) RETURN u, p", true);
    const list = await screen.findByRole("list", { name: "Graph elements" });
    const items = within(list).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([
      "User: Ada Lovelace",
      "Product: Brass Lamp",
      "PURCHASED from Ada Lovelace to Brass Lamp",
    ]);
    items[0].focus();
    fireEvent.click(items[0]);
    await screen.findByText("Selected node User: Ada Lovelace");
    expect(screen.getByRole("complementary", { name: "Selected element" })).toHaveTextContent(
      '"Ada Lovelace"',
    );
  });
});

describe("Table, JSON and Plan views (spec: graph-browser › Table, JSON and Plan views)", () => {
  it("shows nodes as summaries that open in the inspector", async () => {
    await mount("MATCH (u)-[b]->(p) RETURN u, p", true);
    await screen.findByText("2 nodes · 1 relationship · 18 ms");
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    const table = await screen.findByRole("table", { name: "Result table" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["u", "p"]);
    fireEvent.click(within(table).getByRole("button", { name: '(:User {name: "Ada Lovelace"})' }));
    const inspector = screen.getByRole("complementary", { name: "Selected element" });
    expect(inspector).toHaveTextContent("<id> 4:x:1");
    await within(inspector).findByText("→ PURCHASED");
    expect(inspector).toHaveTextContent("← FOLLOWS");
    expect(inspector).toHaveTextContent("130");
  });

  it("shows the records as JSON", async () => {
    await mount("MATCH (u)-[b]->(p) RETURN u, p", true);
    await screen.findByText("2 nodes · 1 relationship · 18 ms");
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const json = JSON.parse((await screen.findByLabelText("Result JSON")).textContent!);
    expect(json[0].u.properties.name).toBe("Ada Lovelace");
  });

  it("profiles a query and highlights the highest db hits (spec: graph-browser › Profile)", async () => {
    result = graphResult({
      mode: undefined,
      plan: {
        operator: "ProduceResults",
        details: "u",
        estimatedRows: 25,
        rows: 25,
        dbHits: 0,
        children: [
          {
            operator: "Expand(All)",
            details: "(u)-[:PURCHASED]->(p)",
            estimatedRows: 100,
            rows: 120,
            dbHits: 480,
            children: [
              {
                operator: "NodeByLabelScan",
                details: "u:User",
                rows: 40,
                dbHits: 41,
                children: [],
              },
            ],
          },
        ],
      },
    } as never);
    const id = await mount("MATCH (u:User)-[:PURCHASED]->(p) RETURN u");
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    await waitFor(() => expect(userQueries()).toHaveLength(1));
    expect(userQueries()[0].mode).toBe("profile");
    await waitFor(() => expect(tabState(id).view).toBe("plan"));
    const tree = await screen.findByRole("tree", { name: "Query plan" });
    const ops = within(tree).getAllByTestId("plan-operator");
    expect(ops.map((o) => o.getAttribute("data-hot"))).toEqual(["false", "true", "false"]);
    expect(ops[1]).toHaveTextContent("db hits 480");
    expect(ops[1]).toHaveTextContent("rows 120");
  });
});

describe("Graph schema sidebar (spec: graph-browser › Graph schema sidebar)", () => {
  it("inserts the label query into the editor first, then runs it (spec: graph-browser › Click a label)", async () => {
    const id = await mount("");
    fireEvent.click(screen.getByRole("button", { name: /Product\s*3\.9k/ }));
    expect(tabState(id).text).toBe("MATCH (n:Product) RETURN n LIMIT 25");
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "MATCH (n:Product) RETURN n LIMIT 25",
      ),
    );
    await waitFor(() => expect(userQueries()).toHaveLength(1));
    expect(userQueries()[0].cypher).toBe("MATCH (n:Product) RETURN n LIMIT 25");
    await screen.findByText("2 nodes · 1 relationship · 18 ms");
  });

  it("runs the relationship type query and keeps what the user had typed", async () => {
    const id = await mount("MATCH (a) RETURN a");
    fireEvent.click(screen.getByRole("button", { name: "PURCHASED" }));
    expect(tabState(id).text).toBe(
      "MATCH (a) RETURN a\n\nMATCH p=()-[:PURCHASED]->() RETURN p LIMIT 25",
    );
    await waitFor(() => expect(userQueries()).toHaveLength(1));
    expect(userQueries()[0].cypher).toBe("MATCH p=()-[:PURCHASED]->() RETURN p LIMIT 25");
  });
});

describe("Inspector (spec: graph-browser › Inspector)", () => {
  async function inspectAda() {
    await mount("MATCH (u)-[b]->(p) RETURN u, p", true);
    await screen.findByText("2 nodes · 1 relationship · 18 ms");
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    fireEvent.click(await screen.findByRole("button", { name: /\(:User/ }));
    return screen.getByRole("complementary", { name: "Selected element" });
  }

  it("edits a property with a parameterised SET after the confirmation (spec: graph-browser › Edit a property)", async () => {
    const inspector = await inspectAda();
    guard = "confirm";
    fireEvent.click(within(inspector).getByRole("button", { name: "Edit properties" }));
    fireEvent.change(within(inspector).getByLabelText("Value of plan"), {
      target: { value: '"team"' },
    });
    fireEvent.click(within(inspector).getByRole("button", { name: "Save properties" }));

    // the guard is asked about the property edit; staging asks for a confirmation
    await waitFor(() => expect(api.graphUpdateSafetyCheck).toHaveBeenCalledWith("s1", "node"));
    const dialog = await screen.findByRole("dialog");
    expect(api.graphUpdateProperties).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(api.graphUpdateProperties).toHaveBeenCalledWith(
        "s1",
        "4:x:1",
        { plan: "team" },
        "node",
        "tok-1",
      ),
    );
    await waitFor(() => expect(inspector).toHaveTextContent('"team"'));
  });

  it("does not write when the confirmation is declined", async () => {
    const inspector = await inspectAda();
    guard = "confirm";
    fireEvent.click(within(inspector).getByRole("button", { name: "Edit properties" }));
    fireEvent.change(within(inspector).getByLabelText("Value of plan"), { target: { value: "7" } });
    fireEvent.click(within(inspector).getByRole("button", { name: "Save properties" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.graphUpdateProperties).not.toHaveBeenCalled();
  });

  it("copies a MATCH by element id and hides a node", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const inspector = await inspectAda();
    fireEvent.click(within(inspector).getByRole("button", { name: "Copy as Cypher MATCH" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'MATCH (n:User) WHERE elementId(n) = "4:x:1" RETURN n',
      ),
    );
    fireEvent.click(within(inspector).getByRole("button", { name: "Hide node" }));
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Selected element" })).toHaveTextContent(
        "Nothing selected",
      ),
    );
  });

  it("stores the caption property per label", async () => {
    const inspector = await inspectAda();
    fireEvent.change(within(inspector).getByLabelText("Caption of User nodes"), {
      target: { value: "plan" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    await waitFor(() =>
      expect(instances[instances.length - 1].nodes().map((n) => n.data.caption)).toContain("pro"),
    );
  });
});

describe("Cypher safeguards in the console (spec: graph-browser › Cypher safeguards)", () => {
  it("shows the typed confirmation of the guard and sends its token", async () => {
    api.graphSafetyCheck.mockResolvedValue({
      decision: "typed_confirm",
      connection: "staging-neo4j",
      environment: "production",
      statements: [
        { text: "MATCH (n) DETACH DELETE n", class: "write", danger: "Delete everything" },
      ],
      token: "tok-9",
      typed: "staging-neo4j",
    });
    await mount("MATCH (n) DETACH DELETE n");
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete everything");
    const run = within(dialog).getByRole("button", { name: "Run" });
    expect(run).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Connection name"), {
      target: { value: "staging-neo4j" },
    });
    fireEvent.click(run);
    await waitFor(() => expect(userQueries()).toHaveLength(1));
    expect(api.graphQuery.mock.calls[0][2]).toBe("tok-9");
  });

  it("shows a refusal and does not run", async () => {
    guard = "block";
    await mount("CREATE (n:Test)");
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByText("This session is read-only");
    expect(api.graphQuery).not.toHaveBeenCalled();
  });
});
