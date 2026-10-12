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
  /** The editor's current text. */
  async text(): Promise<string> {
    return (await (await this.editor()).getProperty("innerText")) as string;
  },
  output: () => $("aria/Output"),
};
