import { $, $$, browser } from "@wdio/globals";
import { Grid } from "./Grid";

/** A table-editor tab: filter bar, grid, pending-changes bar, record panel. */
export const TableEditor = {
  where: () => $("aria/WHERE"),
  orderBy: () => $("aria/ORDER BY"),
  async applyFilter(where: string, orderBy = "") {
    await (await this.where()).setValue(where);
    if (orderBy) await (await this.orderBy()).setValue(orderBy);
    await browser.keys("Enter");
  },
  nextPage: () => $("aria/Next page"),
  previousPage: () => $("aria/Previous page"),
  openInConsole: () => $("aria/Open in console"),
  view: (name: "Data" | "Structure" | "Indexes" | "Relations" | "DDL") =>
    $(`.//*[@aria-label="Table views"]//*[@role="tab"][contains(., "${name}")]`),
  /** The row-range text, e.g. "Rows 1–100 of 1,284 · 12 ms". */
  rangeText: () => $('.//*[contains(text(), "Rows ")]'),

  /** Edit one cell: select it, open its editor with Enter, type, commit with Enter. */
  async editCell(row: number, column: string, value: string) {
    await Grid.select(row, column);
    await browser.keys("Enter");
    const input = await $(`aria/Value of ${column}`);
    await input.waitForDisplayed({ timeout: 10_000 });
    await input.setValue(value);
    await browser.keys("Enter");
  },

  pendingBar: () => $("aria/Pending changes"),
  previewButton: () => $("aria/Pending changes").$("button=Preview SQL"),
  revertButton: () => $("aria/Pending changes").$("button=Revert all"),
  submitButton: () => $("aria/Pending changes").$("button*=Submit"),
  generatedSql: () => $("aria/Generated SQL"),

  recordPanelToggle: () => $("aria/Record panel"),
  record: () => $('aside[aria-label="Record"]'),
  references: () => $$('[aria-label="References"] button'),
  referencedBy: () => $$('[aria-label="Referenced by"] button'),
};
