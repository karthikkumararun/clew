import { useLayoutEffect } from "react";
import type { RefObject } from "react";

const MARGIN = 8;

/**
 * Keep a fixed-position overlay (a context menu opened at a click point) fully inside the window:
 * after it is laid out, shift it left and up by however much it overflows the right and bottom
 * edges (spec: app-shell › Menu near the edge).
 */
export function useKeepInWindow<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  key: unknown,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    el.style.translate = "";
    const r = el.getBoundingClientRect();
    const dx = Math.min(0, window.innerWidth - MARGIN - r.right);
    const dy = Math.min(0, window.innerHeight - MARGIN - r.bottom);
    // never push the left or top edge out of view
    const x = Math.max(dx, MARGIN - r.left);
    const y = Math.max(dy, MARGIN - r.top);
    if (x !== 0 || y !== 0) el.style.translate = `${x}px ${y}px`;
  }, [ref, active, key]);
}
