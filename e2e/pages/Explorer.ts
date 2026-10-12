import { $ } from "@wdio/globals";

/** The explorer sidebar. Located by role and accessible name, never by CSS class. */
export const Explorer = {
  panel: () => $("aria/Explorer"),
  connection: (name: string) => $(`aria/${name}`),
  newConnectionButton: () => $("aria/New connection"),
};
