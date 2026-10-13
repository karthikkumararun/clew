import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { clamp } from "../lib/clamp";
import { getUiNumber, setUiState } from "../lib/uiState";
import { useLayout } from "../stores/layoutStore";
import { useSlots } from "./registry/slots";
import styles from "./BottomDock.module.css";

export const BOTTOM_DOCK = {
  default: 300,
  min: 160,
  key: "layout.bottomPanelHeight",
} as const;

const KEY_STEP = 16;

/** The tallest the dock may be: it never squeezes the editor below 160px. */
const maxHeight = () => Math.max(BOTTOM_DOCK.min, Math.round(window.innerHeight * 0.7));

/** A resizable dock under the editor area, filled by whatever registered a bottom panel. */
export function BottomDock() {
  const def = useSlots((s) => s.bottomPanel);
  const open = useLayout((s) => s.bottomPanelOpen);
  const [height, setHeight] = useState(() =>
    clamp(getUiNumber(BOTTOM_DOCK.key, BOTTOM_DOCK.default), BOTTOM_DOCK.min, maxHeight()),
  );
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  const resize = useCallback((next: number, persist = true) => {
    const clamped = clamp(Math.round(next), BOTTOM_DOCK.min, maxHeight());
    setHeight(clamped);
    if (persist) setUiState(BOTTOM_DOCK.key, String(clamped));
  }, []);

  if (!def || !open) return null;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: height };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(drag.current.startHeight - (e.clientY - drag.current.startY), false);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    resize(drag.current.startHeight - (e.clientY - drag.current.startY));
    drag.current = null;
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") resize(height + KEY_STEP);
    else if (e.key === "ArrowDown") resize(height - KEY_STEP);
    else if (e.key === "Home") resize(BOTTOM_DOCK.min);
    else if (e.key === "End") resize(maxHeight());
    else return;
    e.preventDefault();
  };

  return (
    <section
      className={styles.dock}
      style={{ height }}
      aria-label={def.title}
      data-metric="bottom-panel"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${def.title}`}
        aria-valuemin={BOTTOM_DOCK.min}
        aria-valuenow={height}
        tabIndex={0}
        className={styles.handle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      />
      {def.render()}
    </section>
  );
}
