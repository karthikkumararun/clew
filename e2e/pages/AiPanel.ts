import { $, $$, browser } from "@wdio/globals";

/** The AI assistant side panel, its composer and the review bar over the editor. */
export const AiPanel = {
  toggle: () => $("aria/Toggle AI assistant"),
  panel: () => $('aside[aria-label="AI assistant"]'),
  composer: () => $("aria/Ask the assistant"),
  send: () => $("aria/Send"),
  mode: (name: "Ask" | "Edit") => $(`.//*[@role="radio"][normalize-space()="${name}"]`),
  messages: () => $$('[data-testid="assistant-message"]'),
  card: () => $('[data-testid="edit-card"]'),
  /** The newest Edited card: earlier ones keep their final state. */
  lastCard: () => $('(//*[@data-testid="edit-card"])[last()]'),
  reviewBar: () => $('[data-testid="review-bar"]'),
  fixButton: () => $('.//button[contains(., "Fix with AI")]'),
  async open() {
    if (!(await this.panel().isExisting())) await this.toggle().click();
    await this.composer().waitForDisplayed({ timeout: 10_000 });
  },
  async ask(text: string) {
    const input = await this.composer();
    await input.click();
    await input.setValue(text);
    await browser.keys("Enter");
  },
  /** Wait until the newest answer has finished streaming. */
  async answered(timeout = 30_000) {
    await browser.waitUntil(
      async () => {
        const all = await this.messages();
        if (all.length === 0) return false;
        return (await all[all.length - 1].getAttribute("data-status")) === "done";
      },
      { timeout, timeoutMsg: "the answer should finish streaming" },
    );
  },
};
