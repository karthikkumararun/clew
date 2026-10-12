import { $, $$, browser } from "@wdio/globals";

/** The explorer sidebar. Located by role and accessible name, never by CSS class. */
export const Explorer = {
  panel: () => $("aria/Explorer"),
  /** A tree row by its visible text (a connection, schema, table or column). */
  row: (text: string) => $(`.//*[@role="treeitem"][contains(., "${text}")]`),
  rows: () => $$('[role="treeitem"]'),
  connection: (name: string) => $(`.//*[@role="treeitem"][contains(., "${name}")]`),
  tree: () => $('[role="tree"]'),
  /**
   * Select a row and give the tree keyboard focus. The embedded WebDriver's click is synthetic and
   * does not move focus, so a click alone leaves arrow keys going elsewhere.
   */
  async select(text: string) {
    const row = await this.row(text);
    await row.click();
    const tree = await this.tree();
    await browser.execute((el) => (el as HTMLElement).focus(), tree);
  },
  /** Expand a row with the keyboard (select it, then Right arrow). */
  async expand(text: string) {
    await this.select(text);
    await browser.keys("ArrowRight");
  },
  newConnectionButton: () => $("aria/New connection"),
};
