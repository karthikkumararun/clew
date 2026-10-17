import { copyFileSync } from "node:fs";
import { $, $$, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { seedAi } from "../helpers/ai";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { createIsolatedDb } from "../helpers/db";
import { MockLlm } from "../helpers/mockLlm";
import type { RecordedRequest } from "../helpers/mockLlm";
import { AiPanel } from "../pages/AiPanel";
import { Overlays } from "../helpers/overlay";
import { pointerClick } from "../helpers/pointer";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";

// J-17 the AI assistant against a mock model (spec: ai-assistant, ai-providers,
// ai-inline-completion): Fix with AI writes a reviewable diff and runs nothing, hunks are kept or
// undone, Run asks first, a production connection shares schema only, ghost text is accepted
// with Tab. The mock records everything the app sends.
describe("J-17 AI assistant", () => {
  const data = withDataDir();
  const llm = new MockLlm();
  const BROKEN = "SELECT o.carrier FROM orders o";
  const FIXED = ["SELECT s.carrier", "FROM orders o", "JOIN shipments s ON s.order_id = o.id"].join(
    "\n",
  );

  const seeded = async (name: string, env: "development" | "production") => {
    const lite = await createIsolatedDb("sqlite");
    const path = `${data.dir}/${name}.sqlite`;
    copyFileSync(lite.name, path);
    await lite.cleanup();
    return connectionFactory.sqlite(name, path, env);
  };

  const openConsole = async (name: string) => {
    await Explorer.select(name);
    await browser.keys("Enter");
    await Console.waitForEditor(30_000);
  };

  const outputEntries = async () => {
    await Console.openTab("Output");
    return (await $$('[aria-label="Output"] [data-kind]')).length;
  };

  const hunkButtons = (kind: "accept" | "reject") => $$(`button[name="${kind}"]`);

  before(async () => {
    await llm.start();
    llm.respond((req: RecordedRequest) => {
      if (req.completion) return { text: " AND o.status = 'shipped'" };
      const editing = req.body.tools?.some((t) => t.function.name === "edit_console");
      const answered = req.body.messages.some((m) => m.role === "tool");
      const ask = req.body.messages.filter((m) => m.role === "user").pop()?.content ?? "";
      if (editing && !answered && /Fix the error/.test(ask)) {
        return {
          tools: [
            {
              name: "edit_console",
              args: {
                summary: "Join shipments",
                edits: [{ start_line: 1, end_line: 1, replacement: FIXED }],
              },
            },
          ],
        };
      }
      if (editing && !answered && /limit/i.test(ask)) {
        return {
          tools: [
            {
              name: "edit_console",
              args: {
                summary: "Add o.id and a limit",
                edits: [
                  { start_line: 1, end_line: 1, replacement: "SELECT s.carrier, o.id" },
                  { start_line: 4, end_line: 3, replacement: "LIMIT 10" },
                ],
              },
            },
          ],
        };
      }
      return { text: "`carrier` lives on `shipments`, so I joined it in." };
    });
    seedConnections(data.dir, [
      await seeded("dev-sqlite", "development"),
      await seeded("prod-sqlite", "production"),
    ]);
    seedAi(data.dir, llm, { inline: true });
    await launchApp(data);
    await openConsole("dev-sqlite");
  });
  after(async () => {
    await llm.stop();
  });

  it(`Fix with AI writes a reviewable diff and runs nothing ${covers("ai-assistant › Fix with AI", "ai-assistant › Fix applied as a diff")}`, async () => {
    await Console.setText(BROKEN);
    await Console.run();
    await Console.openTab("Output");
    await $('[aria-label="Output"] [data-kind="error"]').waitForDisplayed({ timeout: 30_000 });
    const before = await outputEntries();

    await AiPanel.fixButton().click();
    await AiPanel.reviewBar().waitForDisplayed({ timeout: 30_000 });
    await expect(AiPanel.reviewBar()).toHaveText(expect.stringContaining("AI edited 1 hunk"));
    expect(await Console.text()).toContain("JOIN shipments s ON s.order_id = o.id");
    await expect(AiPanel.card()).toHaveText(expect.stringContaining("Pending review"));
    await AiPanel.answered();
    // Nothing ran: the log has the one failed run it had before, and the model never had a tool
    // that could execute.
    expect(await outputEntries()).toBe(before);
    const sent = llm.chats()[0];
    expect(sent.body.tools?.map((t) => t.function.name)).not.toContain("run_sql");
    // It saw the schema of the table the statement uses, not any rows.
    expect(sent.system).toContain("orders (table):");
    expect(sent.system).not.toContain("Ada Lovelace");
  });

  it(`shows the context that was sent ${covers("ai-providers › What was sent")}`, async () => {
    const message = (await AiPanel.messages())[0];
    await message.$("button*=Context sent").click();
    const list = message.$('[aria-label="Context sent"]');
    await expect(list).toHaveText(expect.stringContaining("schema of orders"));
    await expect(list).toHaveText(expect.stringContaining(BROKEN));
  });

  it(`keeps one hunk and undoes another ${covers("ai-assistant › Keep one, undo another")}`, async () => {
    await AiPanel.reviewBar().$("button*=Keep all").click();
    await AiPanel.reviewBar().waitForDisplayed({ reverse: true, timeout: 10_000 });
    expect(await Console.text()).toBe(FIXED);

    await AiPanel.mode("Edit").click();
    await AiPanel.ask("Add o.id and a limit");
    await AiPanel.reviewBar().waitForDisplayed({ timeout: 30_000 });
    await expect(AiPanel.reviewBar()).toHaveText(expect.stringContaining("AI edited 2 hunks"));
    await browser.waitUntil(async () => (await hunkButtons("accept")).length === 2);
    await pointerClick((await hunkButtons("accept"))[0]);
    await browser.waitUntil(async () => (await hunkButtons("accept")).length === 1);
    await pointerClick((await hunkButtons("reject"))[0]);
    await AiPanel.reviewBar().waitForDisplayed({ reverse: true, timeout: 10_000 });
    const text = await Console.text();
    expect(text).toContain("SELECT s.carrier, o.id");
    expect(text).not.toContain("LIMIT 10");
    await expect(AiPanel.lastCard()).toHaveText(expect.stringContaining("1 kept · 1 undone"));
  });

  it(`asks before running with pending AI edits ${covers("ai-assistant › Run with pending AI edits")}`, async () => {
    await AiPanel.ask("Add a limit please");
    await AiPanel.reviewBar().waitForDisplayed({ timeout: 30_000 });
    const entries = await outputEntries();
    await $('.//button[contains(., "Run") and not(contains(., "script"))]').click();
    const dialog = $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 10_000 });
    await expect(dialog).toHaveText(expect.stringContaining("AI edits are waiting for review"));
    for (const name of ["Cancel", "Run original", "Keep all and run"]) {
      await expect(dialog.$(`button=${name}`)).toBeDisplayed();
    }
    await dialog.$("button=Cancel").click();
    expect(await outputEntries()).toBe(entries);
    await AiPanel.reviewBar().$("button*=Undo all").click();
    await AiPanel.reviewBar().waitForDisplayed({ reverse: true, timeout: 10_000 });
    expect(await Console.text()).not.toContain("LIMIT 10");
  });

  it(`accepts ghost text with Tab ${covers("ai-inline-completion › Accept a suggestion")}`, async () => {
    await Console.setText("SELECT * FROM orders o WHERE o.total > 0");
    const editor = await Console.editor();
    await editor.click();
    await browser.keys("End");
    await browser.keys(" ");
    const ghost = $(".cm-ghostText");
    await ghost.waitForDisplayed({ timeout: 15_000 });
    await expect(ghost).toHaveText(expect.stringContaining("AND o.status = 'shipped'"));
    await browser.keys("Tab");
    expect(await Console.text()).toContain("o.total > 0 AND o.status = 'shipped'");
    expect(llm.completions().length).toBeGreaterThanOrEqual(1);
  });

  it(`shares schema only on a production connection ${covers("ai-providers › Production schema-only", "ai-assistant › Ask mode suggestion")}`, async () => {
    await openConsole("prod-sqlite");
    await Console.setText("SELECT id, name FROM users ORDER BY id LIMIT 5");
    await Console.run();
    await browser.pause(1500);
    await AiPanel.mode("Ask").click();
    const asked = llm.chats().length;
    await AiPanel.ask("what is in users?");
    await browser.waitUntil(() => llm.chats().length > asked, { timeoutMsg: "a request was sent" });
    await AiPanel.answered();
    const sent = llm.chats()[llm.chats().length - 1];
    expect(sent.system).toContain("users (table):");
    expect(sent.system).not.toContain("Ada Lovelace");
    // Ask mode leaves the editor alone.
    expect(await Console.text()).toBe("SELECT id, name FROM users ORDER BY id LIMIT 5");

    await $("button=+ context").click();
    await $('[role="menuitem"]*=Result rows').click();
    await expect($('[role="status"]*=Row data isn')).toBeDisplayed();
  });

  for (const width of [1440, 880]) {
    it(`opens the composer menus inside the ${width}px window ${covers("ai-assistant › Menus are fully visible")}`, async () => {
      await browser.setWindowSize(width, 900);
      await browser.pause(300);
      await AiPanel.open();
      await Overlays.openMenu($('button[aria-haspopup="menu"][aria-label^="Model"]'));
      await Overlays.openMenu($("button=+ context"));
    });
  }

  it(`brings the panel back after a restart ${covers("ai-assistant › Panel comes back")}`, async () => {
    await browser.setWindowSize(1440, 900);
    await AiPanel.open();
    await launchApp(data);
    await AiPanel.panel().waitForDisplayed({ timeout: 20_000 });
    await AiPanel.toggle().click();
    await AiPanel.panel().waitForDisplayed({ reverse: true, timeout: 10_000 });
    await AiPanel.toggle().click();
    await AiPanel.panel().waitForDisplayed({ timeout: 10_000 });
  });
});
