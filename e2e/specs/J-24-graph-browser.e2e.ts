import { $, $$, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections, seedPassword } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { type GraphDb, connectGraph, GRAPH_SEED, NEO4J } from "../helpers/neo4j";
import { pressMod } from "../helpers/keys";
import { Explorer } from "../pages/Explorer";
import { Safeguards } from "../pages/Safeguards";

// J-24 the graph browser: run a Cypher query, see the graph, inspect a node, expand its
// neighbours, read a big integer exactly, and the typed confirmation of an unfiltered DETACH DELETE
// on a production connection. Needs the `graph` Compose profile (pnpm qa:up --profiles graph).
describe("J-24 graph browser", () => {
  const data = withDataDir();
  let graph: GraphDb;

  const connect = async (name: string, environment: "local" | "production") => {
    const conn = connectionFactory.neo4j(name, {
      port: NEO4J.boltPort,
      user: NEO4J.user,
      environment,
    });
    seedConnections(data.dir, [conn]);
    seedPassword(data.dir, conn.id, NEO4J.password);
    await launchApp(data);
    await Explorer.select(name);
    await browser.keys("Enter");
    await $('[aria-label="Cypher editor"]').waitForDisplayed({ timeout: 30_000 });
  };

  const run = async (cypher: string) => {
    const editor = await $('[aria-label="Cypher editor"] .cm-content');
    await editor.click();
    await pressMod("a");
    await browser.keys("Backspace");
    await editor.addValue(cypher);
    await pressMod("Enter");
  };

  const nodeCount = async () => (await $$('[data-testid="graph-node"]')).length;

  before(async () => {
    graph = await connectGraph();
    await graph.reset();
  });

  describe("on a local connection", () => {
    before(async () => {
      await connect("graph-local", "local");
    });

    it(`loads the schema sidebar of the database ${covers("graph-browser › Open a console")}`, async () => {
      const sidebar = $('[aria-label="Graph schema"]');
      await sidebar.waitForDisplayed({ timeout: 20_000 });
      for (const label of Object.keys(GRAPH_SEED.labels)) {
        await expect(sidebar).toHaveText(expect.stringContaining(label));
      }
    });

    it(`shows the nodes and relationships of a query as a graph ${covers("graph-browser › Graph view", "driver-framework › Records with graph values")}`, async () => {
      await run(
        `MATCH (p:Product {name: '${GRAPH_SEED.product}'})<-[b:BOUGHT]-(u:User) RETURN p, b, u`,
      );
      await browser.waitUntil(async () => (await nodeCount()) >= 2, {
        timeoutMsg: "the graph should show the product and its buyers",
      });
      expect((await $$('[data-testid="graph-edge"]')).length).toBeGreaterThanOrEqual(1);
    });

    it(`inspects a node and expands its neighbours ${covers("graph-browser › Expand neighbours")}`, async () => {
      const before = await nodeCount();
      const lamp = await $(`[data-testid="graph-node"][data-caption="${GRAPH_SEED.product}"]`);
      await lamp.click();
      const inspector = $('[aria-label="Selected element"]');
      await inspector.waitForDisplayed({ timeout: 10_000 });
      await expect(inspector).toHaveText(expect.stringContaining(GRAPH_SEED.product));
      await inspector.$("button=Expand neighbours").click();
      await browser.waitUntil(async () => (await nodeCount()) > before, {
        timeoutMsg: "expanding should add neighbours",
      });
    });

    it(`opens scalar results in the table with big integers exact ${covers("graph-browser › No graph values", "driver-framework › Large integers")}`, async () => {
      await run(
        "MATCH (o:Order {id: 'O-1001'}) RETURN toString(o.reference) AS reference, o.reference AS raw",
      );
      const table = $('[aria-label="Result table"]');
      await table.waitForDisplayed({ timeout: 20_000 });
      await expect(table).toHaveText(expect.stringContaining(GRAPH_SEED.bigInteger));
    });
  });

  describe("on a production connection", () => {
    before(async () => {
      await connect("graph-prod", "production");
    });

    it(`asks to type the connection name before an unfiltered DETACH DELETE ${covers("graph-browser › Delete everything on production")}`, async () => {
      // the session is read-only until switched, so switch it as a user would
      await $('button[data-mode="read"]').click();
      await $('[role="menuitem"]*=read-write').click();
      await Safeguards.dialogButton("Switch to read-write").click();
      await run("MATCH (n) DETACH DELETE n");
      await Safeguards.dialog().waitForDisplayed({ timeout: 15_000 });
      await expect(Safeguards.typedField()).toBeDisplayed();
      await expect(Safeguards.dialogButton("Run")).toBeDisabled();
      await browser.keys("Escape");
      const [row] = await graph.query("MATCH (n) RETURN count(n) AS n");
      expect(Number(row.n)).toBeGreaterThan(0);
    });
  });
});
