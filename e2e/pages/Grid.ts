import { $, $$, browser } from "@wdio/globals";

/**
 * The result grid is a canvas, so tests read its test-mode mirror (see GridMirror.tsx):
 * hidden rows and cells with `data-testid`, only in e2e builds.
 */
export const Grid = {
  mirror: () => $('[data-testid="grid-mirror"]'),
  rows: () => $$('[data-testid="grid-row"]'),
  async rowCount(): Promise<number> {
    return Number(await (await this.mirror()).getAttribute("data-row-count"));
  },
  /** Cell text by row index and column name. */
  async cell(row: number, column: string): Promise<string> {
    const el = await $(`[data-testid="grid-row"][data-row="${row}"] [data-col="${column}"]`);
    return (await el.getProperty("textContent")) as string;
  },
  async columnValues(column: string): Promise<string[]> {
    const els = Array.from(await $$(`[data-testid="grid-cell"][data-col="${column}"]`));
    return Promise.all(els.map(async (e) => (await e.getProperty("textContent")) as string));
  },
  async columnNames(): Promise<string[]> {
    const ths = Array.from(await $$('[data-testid="grid-mirror"] th'));
    return Promise.all(ths.map(async (t) => (await t.getProperty("textContent")) as string));
  },
  /** Select a cell by row index and column name, and give the grid keyboard focus. */
  async select(row: number, column: string) {
    const col = (await this.columnNames()).indexOf(column);
    if (col < 0) throw new Error(`no column ${column}`);
    // Focus first: the canvas selects its first cell when it gains focus, which would undo ours.
    await browser.execute(() =>
      document.querySelector<HTMLCanvasElement>("[data-testid='data-grid-canvas']")?.focus(),
    );
    await browser.execute(
      (c: number, r: number) =>
        (
          window as unknown as { __clewE2E: { selectCell(c: number, r: number): void } }
        ).__clewE2E.selectCell(c, r),
      col,
      row,
    );
    // The selection is applied on the next render; a key pressed before that goes to the cell
    // that was selected (the first one, on focus) and opens its viewer instead of the editor.
    await browser.waitUntil(
      async () =>
        (await (await this.mirror()).getAttribute("data-selected-cell")) === `${col}:${row}`,
      { timeoutMsg: `cell ${col}:${row} should be selected` },
    );
    await browser.execute(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
  },
};
