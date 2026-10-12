import { $, $$ } from "@wdio/globals";

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
    const els = await $$(`[data-testid="grid-cell"][data-col="${column}"]`);
    return Promise.all(els.map(async (e) => (await e.getProperty("textContent")) as string));
  },
};
