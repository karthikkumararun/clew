import { $, $$ } from "@wdio/globals";
import { pointerClick } from "../helpers/pointer";

export const TabStrip = {
  strip: () => $("aria/Open editors"),
  tabs: () => $$('[aria-label="Open editors"] [role="tab"]'),
  /** Activate the nth tab (0-based). The strip reacts to pointerdown, so use real pointer events. */
  async select(index: number) {
    const tabs = await this.tabs();
    await pointerClick(tabs[index]);
  },
  newConsole: () => $("aria/New console"),
};
