import { browser } from "@wdio/globals";

type El =
  Parameters<typeof browser.getElementRect>[0] | WebdriverIO.Element | ChainablePromiseElement;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rendered box of an element in CSS pixels, from `getBoundingClientRect`. */
export async function boxOf(el: El): Promise<Box> {
  const target = await el;
  return browser.execute(
    (e) => {
      const r = (e as unknown as HTMLElement).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    target as unknown as WebdriverIO.Element,
  );
}

/** Has a size and lies fully inside the window. (This WebDriver has no isDisplayedInViewport.) */
export async function isInsideWindow(el: El): Promise<boolean> {
  const target = await el;
  return browser.execute(
    (e) => {
      const r = (e as unknown as HTMLElement).getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.left >= 0 &&
        r.top >= 0 &&
        r.right <= window.innerWidth &&
        r.bottom <= window.innerHeight
      );
    },
    target as unknown as WebdriverIO.Element,
  );
}

/**
 * Make the page viewport `width` x `height` CSS pixels. A window size is not a viewport size
 * (title bars, rounding), and screenshots only compare across runs when the viewport is the same,
 * so grow or shrink the window by the difference until it matches. A display can be too small
 * for the target (the window cannot grow past the screen); then the largest viewport it allows
 * is used, and returned, so the run is still repeatable on that machine.
 */
export async function setViewport(
  width: number,
  height: number,
): Promise<{ width: number; height: number }> {
  for (let i = 0; i < 4; i++) {
    const inner = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
    if (inner.w === width && inner.h === height) break;
    const outer = await browser.getWindowSize();
    await browser.setWindowSize(outer.width + (width - inner.w), outer.height + (height - inner.h));
    await browser.pause(250);
  }
  const inner = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
  return { width: inner.w, height: inner.h };
}
