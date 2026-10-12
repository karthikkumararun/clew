import { browser } from "@wdio/globals";

/**
 * Choose an option of a native <select> the way a user's change would: set the value and fire
 * `input` and `change`, which React listens for. `selectByVisibleText` alone changes the DOM but
 * can leave the app's state on the old value in this WebDriver.
 */
export async function chooseOption(
  select: WebdriverIO.Element | ChainablePromiseElement,
  text: string,
): Promise<void> {
  const el = await select;
  const ok = await browser.execute(
    (node: HTMLSelectElement, label: string) => {
      const option = Array.from(node.options).find((o) => o.text.trim() === label);
      if (!option) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(node, option.value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    el,
    text,
  );
  if (!ok) throw new Error(`no option "${text}"`);
}
