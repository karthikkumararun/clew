import { $, $$, browser } from "@wdio/globals";

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
    await browser.keys([process.platform === "darwin" ? "Command" : "Control", "a"]);
    await browser.keys("Backspace");
    await ed.addValue(sql);
  },
  async run() {
    await browser.keys([process.platform === "darwin" ? "Command" : "Control", "Enter"]);
  },
  /** The editor's current text. */
  async text(): Promise<string> {
    return (await (await this.editor()).getProperty("innerText")) as string;
  },
  output: () => $("aria/Output"),
};
