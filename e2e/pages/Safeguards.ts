import { $ } from "@wdio/globals";

/** Production safeguards: the session badge, the switch and write-confirmation dialogs. */
export const Safeguards = {
  badge: () => $('.//button[contains(., "PRODUCTION")]'),
  switchItem: () => $("aria/Switch this session to read-write"),
  dialog: () => $('[role="dialog"]'),
  dialogButton: (name: string) => $(`.//*[@role="dialog"]//button[normalize-space()="${name}"]`),
  statements: () => $('[role="dialog"] [aria-label="Statements"]'),
  typedField: () => $("aria/Connection name"),
  target: () => $('.//*[@role="dialog"]//p[contains(@class, "target")]'),
};
