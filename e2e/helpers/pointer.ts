import { browser } from "@wdio/globals";

/**
 * A click made of the pointer events a real mouse produces: pointerdown, mousedown, pointerup,
 * mouseup, click, at the element's centre. The embedded WebDriver emits only `click` for
 * `element.click()` and no pointer events at all for pointer actions, so handlers written for
 * `pointerdown` (the tab strip, drag sources) are unreachable otherwise. Dispatching them from
 * the page keeps the handler under test; only the browser's own event synthesis is replaced.
 */
export async function pointerClick(
  el: WebdriverIO.Element | ChainablePromiseElement,
): Promise<void> {
  const target = await el;
  await browser.execute((node: HTMLElement) => {
    const r = node.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 1,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    const fire = (type: string, E: typeof PointerEvent | typeof MouseEvent) =>
      node.dispatchEvent(
        new E(type, {
          ...init,
          pointerId: 1,
          isPrimary: true,
          pointerType: "mouse",
        } as PointerEventInit),
      );
    fire("pointerdown", PointerEvent);
    fire("mousedown", MouseEvent);
    fire("pointerup", PointerEvent);
    fire("mouseup", MouseEvent);
    fire("click", MouseEvent);
  }, target);
}
