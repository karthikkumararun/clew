import { $, browser } from "@wdio/globals";

/** The Connections dialog (Import / Export). It has no menu yet, so it is opened by command id. */
export const Exchange = {
  async open(tab: "export" | "import") {
    await browser.execute((id: string) => {
      (window as unknown as { __clewE2E: { runCommand(id: string): void } }).__clewE2E.runCommand(
        id,
      );
    }, `connection.${tab}`);
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10_000 });
  },
  tab: (name: "Export" | "Import") =>
    $(
      `.//*[@role="tablist"][@aria-label="Import or export"]//*[@role="tab"][contains(., "${name}")]`,
    ),
  button: (text: string) => $(`.//*[@role="dialog"]//button[normalize-space()="${text}"]`),
  checkbox: (label: string) => $(`.//*[@role="dialog"]//label[contains(., "${label}")]//input`),
  /** Choose what to import from: DataGrip, Clew export, DBeaver, ~/.pgpass. */
  source: (name: string) => $(`.//*[@role="dialog"]//button[contains(., "${name}")]`),
  /** The row checkbox of one importable connection. */
  candidate: (name: string) =>
    $(`.//*[@role="dialog"]//input[starts-with(@aria-label, "Import ${name}")]`),
  passphrase: () => $("#pp1"),
  confirm: () => $("#pp2"),
  unlock: () => $("#ip"),
  alert: () => $('[role="dialog"] [role="alert"]'),
  summary: () => $("[role=dialog]"),
};
