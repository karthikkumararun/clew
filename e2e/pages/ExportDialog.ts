import { $ } from "@wdio/globals";

export const ExportDialog = {
  dialog: () => $('[role="dialog"]'),
  allRows: () => $('.//*[@role="dialog"]//label[contains(., "All rows")]//input'),
  format: () => $("aria/Format"),
  exportButton: () => $('.//*[@role="dialog"]//button[contains(., "Export…")]'),
  cancelExport: () => $('.//*[@role="dialog"]//button[contains(., "Cancel export")]'),
  status: () => $('[role="dialog"] [role="status"]'),
  doneButton: () => $('.//*[@role="dialog"]//button[normalize-space()="Done"]'),
};
