import { browser } from "@wdio/globals";

/** The text the editor currently has selected, as the page reports it (what Copy would take). */
export async function selectedText(): Promise<string> {
  return browser.execute(() => window.getSelection()?.toString() ?? "");
}

/**
 * Whether a user can SEE the selection: some selection highlight is drawn, and nothing opaque is
 * painted over it. CodeMirror draws the selection in a layer behind the text, so a line with an
 * opaque background (for example the current-statement tint) hides it. jsdom has no painting, so
 * this needs the real app. Returns a reason when it is hidden.
 */
export async function selectionVisibility(): Promise<{ visible: boolean; reason: string }> {
  // The highlight is drawn on the next frame after the selection changes.
  await browser
    .waitUntil(
      async () => browser.execute(() => document.querySelector(".cm-selectionBackground") !== null),
      { timeout: 2_000 },
    )
    .catch(() => undefined);
  return browser.execute(() => {
    const bg = document.querySelector<HTMLElement>(".cm-selectionBackground");
    if (!bg) return { visible: false, reason: "no selection highlight is drawn" };
    const layer = bg.closest<HTMLElement>(".cm-selectionLayer");
    const old = layer?.style.pointerEvents ?? "";
    // Layers ignore the pointer, which hides them from hit testing; allow it for this check only.
    if (layer) layer.style.pointerEvents = "auto";
    bg.style.pointerEvents = "auto";
    const r = bg.getBoundingClientRect();
    const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (layer) layer.style.pointerEvents = old;
    bg.style.pointerEvents = "";
    const at = stack.indexOf(bg);
    if (at < 0)
      return { visible: false, reason: "the highlight is not painted at its own position" };
    const alpha = (css: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(css);
      if (!m) return css === "transparent" ? 0 : 1;
      const p = m[1].split(/[ ,/]+/).filter(Boolean);
      return p.length > 3 ? Number(p[3]) : 1;
    };
    for (const el of stack.slice(0, at)) {
      if (alpha(getComputedStyle(el).backgroundColor) >= 0.95) {
        return {
          visible: false,
          reason: `an opaque ${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, ".")} is painted over the selection`,
        };
      }
    }
    return { visible: true, reason: "" };
  });
}
