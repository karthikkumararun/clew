import { $, $$, browser } from "@wdio/globals";
import { pressMod } from "../helpers/keys";

/** The SQL console: editor on top, results below. */
export const Console = {
  /** The visible SQL editor (inactive tabs may keep theirs mounted but hidden). */
  async editor() {
    const all = await $$('[aria-label="SQL editor"]');
    for (const el of all) if (await el.isDisplayed()) return el;
    return all[0] ?? $("aria/SQL editor");
  },
  /** Replace the editor's text. The editor is CodeMirror, so type through the keyboard. */
  async setText(sql: string) {
    const ed = await this.editor();
    await ed.click();
    await pressMod("a");
    await browser.keys("Backspace");
    await ed.addValue(sql);
  },
  /**
   * Wait for a visible SQL editor. A restored session can leave an inactive console's editor
   * mounted but hidden, and it comes first in the document, so `$("aria/SQL editor")` may find
   * the hidden one and wait forever.
   */
  async waitForEditor(timeout = 30_000) {
    await browser.waitUntil(
      async () => {
        for (const el of await $$('[aria-label="SQL editor"]')) {
          if (await el.isDisplayed()) return true;
        }
        return false;
      },
      { timeout, timeoutMsg: "a SQL editor should be visible" },
    );
  },
  async run() {
    await pressMod("Enter");
  },
  async runScript() {
    await pressMod("Enter", { shift: true });
  },
  async cancel() {
    await pressMod(".");
  },
  /** Open one of the panel tabs: Result, Output, Explain plan, History. */
  async openTab(name: "Result" | "Output" | "Explain plan" | "History") {
    const tab = await $(`.//*[@aria-label="Result views"]//*[@role="tab"][contains(., "${name}")]`);
    await tab.click();
  },
  /** Result sets of a script: "Result 1", "Result 2", ... */
  resultSets: () => $$('[aria-label="Result sets"] [role="tab"]'),
  /** Underlined error ranges in the editor. */
  errorRanges: () => $$(".cm-lintRange-error"),
  /**
   * The editor's document, line by line. Built from the lines themselves so that what is only
   * drawn over them stays out: ghost text, and the struck-through original lines of a pending AI
   * edit.
   */
  async text(): Promise<string> {
    const ed = await this.editor();
    return browser.execute((root: HTMLElement) => {
      const lines = Array.from(root.querySelectorAll<HTMLElement>(".cm-line")).filter(
        (l) => !l.closest(".cm-deletedChunk"),
      );
      return lines
        .map((l) => {
          const c = l.cloneNode(true) as HTMLElement;
          c.querySelectorAll(".cm-ghost").forEach((g) => g.remove());
          return c.textContent ?? "";
        })
        .join("\n");
    }, ed);
  },
  output: () => $("aria/Output"),
};
