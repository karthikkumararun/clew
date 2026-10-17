import { copyFileSync } from "node:fs";
import { $, browser } from "@wdio/globals";
import type { Connection } from "../../../src/lib/ipc/generated/Connection";
import { connectionFactory } from "../../helpers/connections";
import { createIsolatedDb } from "../../helpers/db";
import { tablesPath } from "../../helpers/dialect";
import { seedAi } from "../../helpers/ai";
import { pressMod } from "../../helpers/keys";
import { MockLlm } from "../../helpers/mockLlm";
import { AiPanel } from "../../pages/AiPanel";
import { Console } from "../../pages/Console";
import { ConnectionDialog } from "../../pages/ConnectionDialog";
import { Exchange } from "../../pages/Exchange";
import { Explorer } from "../../pages/Explorer";
import { Grid } from "../../pages/Grid";
import { Palette } from "../../pages/Palette";
import { TableEditor } from "../../pages/TableEditor";
import { Welcome } from "../../pages/Welcome";

/**
 * How to reproduce a state of a canvas screen from the canvas sample data (connection names such
 * as dev-sqlite and prod-sqlite, the Ada Lovelace rows of the `shop` seed). The runner seeds
 * `connections`, restarts the app, then calls `steps` (spec: design-conformance › Screen state matrix).
 */
export interface StateFixture {
  connections?(dir: string): Promise<Connection[]> | Connection[];
  /** Anything else that must exist before the app starts (AI settings, a mock model). */
  prepare?(dir: string): Promise<void> | void;
  steps?(): Promise<void>;
  /** Selectors of regions whose pixels change from run to run (timings, ids): masked in comparisons. */
  masks?: string[];
}

const STATUS_BAR = '[data-metric="status-bar"]';

/** The model the AI states talk to; started by the first state that needs it. */
const llm = new MockLlm();
let llmStarted = false;
export async function stopStateServices() {
  if (llmStarted) await llm.stop();
  llmStarted = false;
}
async function startLlm() {
  if (!llmStarted) {
    await llm.start();
    llmStarted = true;
    llm.respond((req) => {
      if (req.completion) return {};
      const answered = req.body.messages.some((m) => m.role === "tool");
      if (!answered && req.body.tools?.some((t) => t.function.name === "edit_console")) {
        return {
          tools: [
            {
              name: "edit_console",
              args: {
                summary: "Join shipments",
                edits: [
                  {
                    start_line: 1,
                    end_line: 1,
                    replacement:
                      "SELECT s.carrier\nFROM orders o\nJOIN shipments s ON s.order_id = o.id",
                  },
                ],
              },
            },
          ],
        };
      }
      return { text: "`carrier` lives on `shipments`, not `orders`, so I joined it in." };
    });
  }
}

/** A saved connection to a fresh copy of the `shop` seed (SQLite, so no containers). */
async function shopConnection(dir: string, name: string, env: Connection["environment"]) {
  const lite = await createIsolatedDb("sqlite");
  const path = `${dir}/${name}.sqlite`;
  copyFileSync(lite.name, path);
  await lite.cleanup();
  return connectionFactory.sqlite(name, path, env);
}

async function openConsole(name: string) {
  await Explorer.select(name);
  await browser.keys("Enter");
  await Console.waitForEditor(30_000);
}

async function dialogTab(tab: "General" | "SSH tunnel" | "SSL / TLS" | "Advanced") {
  await Explorer.newConnectionButton().click();
  await $('[role="dialog"]').waitForDisplayed({ timeout: 10_000 });
  await ConnectionDialog.tab(tab).click();
}

/** Open the Sessions panel unless it already is (its visibility is saved across restarts). */
async function openSessionsPanel() {
  const open = () =>
    browser.execute(() => document.querySelector('[data-testid="sessions-panel"]') !== null);
  if (!(await open())) await pressMod("s", { alt: true });
  await browser.waitUntil(open, { timeoutMsg: "the Sessions panel should open" });
}

async function runQuery(sql: string) {
  await Console.setText(sql);
  await Console.run();
  await browser.waitUntil(async () => (await Grid.rowCount()) > 0, { timeoutMsg: "rows expected" });
}

const ORDERS = "SELECT id, user_id, status, total FROM orders ORDER BY id LIMIT 20";

/** A development SQLite console with the orders query run (the result-editing states start here). */
async function ordersConsole(dir: string) {
  return [await shopConnection(dir, "dev-sqlite", "development")];
}

export const STATES: Record<string, StateFixture> = {
  "welcome-first-run": {
    steps: async () => {
      await Welcome.newConnection().waitForDisplayed({ timeout: 10_000 });
    },
  },
  "welcome-with-connections": {
    connections: async (dir) => [
      await shopConnection(dir, "dev-sqlite", "development"),
      await shopConnection(dir, "prod-sqlite", "production"),
    ],
    steps: async () => {
      await Explorer.row("dev-sqlite").waitForDisplayed({ timeout: 10_000 });
    },
  },
  "main-console-results": {
    connections: async (dir) => [await shopConnection(dir, "dev-sqlite", "development")],
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await Console.setText("SELECT id, name, email, plan FROM users ORDER BY id LIMIT 20");
      await Console.run();
      await browser.waitUntil(async () => (await Grid.rowCount()) > 0, {
        timeoutMsg: "rows expected",
      });
    },
  },
  "main-production-readonly": {
    connections: async (dir) => [await shopConnection(dir, "prod-sqlite", "production")],
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("prod-sqlite");
      await $('.//button[starts-with(normalize-space(.), "PRODUCTION")]').waitForDisplayed({
        timeout: 10_000,
      });
    },
  },
  "grid-pending-edit": {
    connections: async (dir) => [await shopConnection(dir, "dev-sqlite", "development")],
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      const lite = { dialect: "sqlite" as const, name: "", cleanup: async () => {} };
      await Explorer.reveal(tablesPath("dev-sqlite", lite));
      await Explorer.open("orders");
      await browser.waitUntil(async () => (await Grid.rowCount()) > 0, {
        timeoutMsg: "rows expected",
      });
      await TableEditor.editCell(0, "status", "shipped");
      await TableEditor.pendingBar().waitForDisplayed({ timeout: 10_000 });
    },
  },
  "palette-search": {
    connections: async (dir) => [await shopConnection(dir, "dev-sqlite", "development")],
    // Connecting indexes the connection; the footer's counts and the status bar change per run.
    masks: [STATUS_BAR, '[data-testid="palette-footer"]'],
    steps: async () => {
      await openConsole("dev-sqlite");
      await browser.waitUntil(
        async () => {
          await Palette.open();
          await Palette.type("ord");
          const found = (await Palette.rowTexts()).some((t) => t.startsWith("orders"));
          if (!found) await browser.keys("Escape");
          return found;
        },
        { timeout: 30_000, interval: 1000, timeoutMsg: "the connection should be indexed" },
      );
    },
  },
  "ai-settings": {
    // Nothing is called: the page only shows what is set up.
    prepare: (dir) => seedAi(dir, { url: "http://127.0.0.1:9/v1" }),
    steps: async () => {
      await $("aria/Settings").click();
      await $(
        './/nav[@aria-label="Settings sections"]//button[normalize-space()="AI assistant"]',
      ).click();
      await $("aria/Chat provider").waitForDisplayed({ timeout: 10_000 });
    },
  },
  "ai-fix-review": {
    connections: async (dir) => [await shopConnection(dir, "dev-sqlite", "development")],
    prepare: async (dir) => {
      await startLlm();
      seedAi(dir, llm);
    },
    masks: [STATUS_BAR, '[aria-label="Output"]'],
    steps: async () => {
      await openConsole("dev-sqlite");
      await Console.setText("SELECT o.carrier FROM orders o");
      await Console.run();
      await Console.openTab("Output");
      await $('[aria-label="Output"] [data-kind="error"]').waitForDisplayed({ timeout: 30_000 });
      await AiPanel.fixButton().click();
      await AiPanel.reviewBar().waitForDisplayed({ timeout: 30_000 });
      await AiPanel.answered();
    },
  },
  "dialog-general-network": { steps: () => dialogTab("General") },
  "dialog-ssh-tab": { steps: () => dialogTab("SSH tunnel") },
  "dialog-tls-tab": { steps: () => dialogTab("SSL / TLS") },
  "dialog-advanced-tab": { steps: () => dialogTab("Advanced") },
  "dialog-sqlite-file": {
    steps: async () => {
      await dialogTab("General");
      await ConnectionDialog.driver("SQLite").click();
    },
  },
  "exchange-export": { steps: () => Exchange.open("export") },
  "exchange-import": { steps: () => Exchange.open("import") },
  "result-editing-pending": {
    connections: ordersConsole,
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery(ORDERS);
      await $('.//button[starts-with(@aria-label, "Editing ")]').waitForDisplayed({
        timeout: 20_000,
      });
      await TableEditor.editCell(0, "status", "shipped");
      await TableEditor.pendingBar().waitForDisplayed({ timeout: 10_000 });
    },
  },
  "result-editing-options": {
    connections: ordersConsole,
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery(ORDERS);
      await $("aria/More options").click();
      await $('[role="menu"], [role="menu"] *')
        .waitForDisplayed({ timeout: 5_000 })
        .catch(() => {});
    },
  },
  "result-editing-tree": {
    connections: ordersConsole,
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery(ORDERS);
      await $(
        './/*[@role="radiogroup"][@aria-label="View as"]//*[@role="radio"][normalize-space()="Tree"]',
      ).click();
    },
  },
  "result-editing-no-key": {
    connections: ordersConsole,
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery("SELECT status, total FROM orders ORDER BY total LIMIT 20");
      await $('[role="status"]*=No primary key').waitForDisplayed({ timeout: 20_000 });
    },
  },
  "result-editing-chooser": {
    connections: ordersConsole,
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery(
        "SELECT o.id AS oid, o.status, u.id AS uid, u.name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id LIMIT 10",
      );
      const chip = $('.//button[starts-with(@aria-label, "Editing ")]');
      await chip.waitForDisplayed({ timeout: 20_000 });
      await chip.click();
      await $('[role="menu"]').waitForDisplayed({ timeout: 5_000 });
    },
  },
  "result-editing-local-filter": {
    connections: ordersConsole,
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery(ORDERS);
      await $('.//button[@aria-label="Local filter"][@aria-pressed]').click();
      const field = $("aria/Filter status");
      await field.waitForDisplayed({ timeout: 5_000 });
      await field.setValue("paid");
    },
  },
  "result-editing-value-editor": {
    connections: ordersConsole,
    masks: [STATUS_BAR],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery(ORDERS);
      await Grid.select(0, "status");
      await $("aria/More options").click();
      await $('[role="menuitem"]*=Value editor').click();
    },
  },
  "sessions-panel": {
    connections: ordersConsole,
    masks: [STATUS_BAR, '[aria-label="Session details"]', '[aria-label="Sessions by connection"]'],
    steps: async () => {
      await openConsole("dev-sqlite");
      await $('.//button[starts-with(normalize-space(.), "Tx:")]').click();
      await $('[role="menuitem"]*=Manual').click();
      await Console.setText("UPDATE orders SET status = 'paid' WHERE id = 1");
      await Console.run();
      await $('.//button[starts-with(normalize-space(.), "Commit")]').waitForDisplayed({
        timeout: 10_000,
      });
      await openSessionsPanel();
    },
  },
  "sessions-attach-menu": {
    connections: ordersConsole,
    masks: [STATUS_BAR, '[aria-label="Session details"]', '[aria-label="Sessions by connection"]'],
    steps: async () => {
      await openConsole("dev-sqlite");
      await runQuery("SELECT 1 AS one");
      await openSessionsPanel();
      await $('[data-testid="sessions-panel"] [role="treeitem"][aria-level="2"]').click();
      await $("button=Attach to…").click();
      await $('[role="menu"]').waitForDisplayed({ timeout: 10_000 });
    },
  },
};
