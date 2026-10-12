import { $, browser } from "@wdio/globals";

/**
 * Overlay integrity (spec: design-conformance › Overlay integrity). Checks that an open menu,
 * popover or dialog (a) lies inside the window, (b) is what hit-testing finds at its centre and
 * four inner corners, (c) is not clipped by an ancestor with `overflow` other than visible.
 * Returns the problems found; an empty list means the overlay is intact.
 */
export async function overlayProblems(selector: string): Promise<string[]> {
  return browser.execute((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return [`no element matches ${sel}`];
    const problems: string[] = [];
    const r = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) {
      problems.push(
        `box ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} leaves the ${W}x${H} window`,
      );
    }
    const inset = 4;
    const points: [string, number, number][] = [
      ["centre", r.left + r.width / 2, r.top + r.height / 2],
      ["top-left", r.left + inset, r.top + inset],
      ["top-right", r.right - inset, r.top + inset],
      ["bottom-left", r.left + inset, r.bottom - inset],
      ["bottom-right", r.right - inset, r.bottom - inset],
    ];
    for (const [name, x, y] of points) {
      if (x < 0 || y < 0 || x > W || y > H) continue; // off-screen: already reported above
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit)) {
        problems.push(`${name} point is covered by <${hit?.tagName.toLowerCase() ?? "nothing"}>`);
      }
    }
    for (
      let p = el.parentElement;
      p && p !== document.body && p !== document.documentElement;
      p = p.parentElement
    ) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      if (
        r.left < pr.left - 1 ||
        r.top < pr.top - 1 ||
        r.right > pr.right + 1 ||
        r.bottom > pr.bottom + 1
      ) {
        problems.push(
          `clipped by <${p.tagName.toLowerCase()} class="${p.className}"> with overflow ${cs.overflowX}/${cs.overflowY}`,
        );
      }
    }
    return problems;
  }, selector);
}

export async function expectOverlayIntact(selector: string): Promise<void> {
  const problems = await overlayProblems(selector);
  if (problems.length > 0)
    throw new Error(`overlay ${selector} is not intact: ${problems.join("; ")}`);
}

type Opener = ChainablePromiseElement;

/** Focus the opener first: the embedded WebDriver's click does not move focus. */
async function focusAndClick(opener: Opener): Promise<void> {
  await browser.execute((e) => (e as HTMLElement).focus(), await opener);
  await opener.click();
}

async function open(
  opener: Opener,
  selector: string,
  opts: { keepOpen?: boolean; reason?: string },
): Promise<void> {
  await focusAndClick(opener);
  await $(selector).waitForDisplayed({ timeout: 10_000 });
  await expectOverlayIntact(selector);
  if (opts.keepOpen) return;
  await browser.keys("Escape");
  await $(selector).waitForExist({ reverse: true, timeout: 5_000 });
  const back = await browser.execute(
    (e) => document.activeElement === e || (e as HTMLElement).contains(document.activeElement),
    await opener,
  );
  if (!back) throw new Error(`focus did not return to the opener after closing ${selector}`);
}

/**
 * Page-object helpers: every overlay a test opens goes through one of these, so none can be
 * opened without the integrity check. Opting out (`keepOpen` skips only the Esc and focus step)
 * needs a reason, recorded in the call.
 */
export const Overlays = {
  openMenu: (opener: Opener, opts: { keepOpen?: boolean; reason?: string } = {}) =>
    open(opener, '[role="menu"]', opts),
  openDialog: (opener: Opener, opts: { keepOpen?: boolean; reason?: string } = {}) =>
    open(opener, '[role="dialog"]', opts),
  openPopover: (
    opener: Opener,
    selector: string,
    opts: { keepOpen?: boolean; reason?: string } = {},
  ) => open(opener, selector, opts),
};
