import { $, $$, browser } from "@wdio/globals";
import { pressMod } from "../helpers/keys";

/** The command palette (Mod+K). Located by role and accessible name. */
export const Palette = {
  dialog: () => $('[role="dialog"][aria-label="Command palette"]'),
  input: () => $('[role="dialog"][aria-label="Command palette"] [role="combobox"]'),
  options: () => $$('[role="dialog"][aria-label="Command palette"] [role="option"]'),
  scope: (name: "All" | "Objects" | "Queries" | "Actions") =>
    $(`.//*[@role="tablist"][@aria-label="Scope"]//*[@role="tab"][normalize-space()="${name}"]`),
  async open() {
    await pressMod("k");
    await (await this.dialog()).waitForDisplayed({ timeout: 10_000 });
  },
  async type(text: string) {
    const input = await this.input();
    await input.click();
    await input.setValue(text);
  },
  /** Texts of the visible rows, in order. */
  async rowTexts(): Promise<string[]> {
    return Promise.all(
      Array.from(await this.options()).map(
        async (o) => (await o.getProperty("textContent")) as string,
      ),
    );
  },
  /** Alt+Enter on the highlighted row (WebDriver chords don't set modifier flags). */
  async altEnter() {
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Command palette"] [role="combobox"]',
      );
      el?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  },
};
