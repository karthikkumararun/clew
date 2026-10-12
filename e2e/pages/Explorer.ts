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
  /** Expand each named row in turn: `reveal(["shop-postgres", db, "public", "tables"])`. */
  async reveal(path: string[]) {
    for (const name of path) {
      const row = await this.row(name);
      await row.waitForDisplayed({ timeout: 20_000 });
      if ((await row.getAttribute("aria-expanded")) !== "true") await this.expand(name);
    }
  },
  /** Open a row (a table opens its editor) with Enter. */
  async open(text: string) {
    await this.select(text);
    await browser.keys("Enter");
  },
  newConnectionButton: () => $("aria/New connection"),
};
