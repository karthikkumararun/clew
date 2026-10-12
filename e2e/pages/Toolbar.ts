import { $ } from "@wdio/globals";

export const Toolbar = {
  toggleSidebar: () => $("aria/Toggle sidebar"),
  settings: () => $("aria/Settings"),
};
