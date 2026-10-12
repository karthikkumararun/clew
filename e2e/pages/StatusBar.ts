import { $ } from "@wdio/globals";

export const StatusBar = {
  /** The version at the right of the status bar: it opens the About dialog. */
  version: () => $('.//footer//button[starts-with(normalize-space(.), "Clew v")]'),
};
