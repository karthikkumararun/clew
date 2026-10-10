import { useCallback, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { clamp } from "../lib/clamp";
import { getUiNumber, setUiState } from "../lib/uiState";
import styles from "./SplitPane.module.css";

export interface SplitPaneProps {
  /** Which edge of the pane carries the drag handle. A left sidebar has its handle on the right. */
  edge: "left" | "right";
  defaultSize: number;
  min: number;
  max: number;
  /** ui_state key under which the size is persisted. */
  persistKey?: string;
  onSizeChange?: (size: number) => void;
  label: string;
  children: ReactNode;
}

const KEY_STEP = 16;

export function SplitPane({
  edge,
  defaultSize,
  min,
  max,
  persistKey,
  onSizeChange,
  label,
  children,
}: SplitPaneProps) {
  const [size, setSizeState] = useState(() =>
    clamp(persistKey ? getUiNumber(persistKey, defaultSize) : defaultSize, min, max),
  );
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startSize: number } | null>(null);

  const setSize = useCallback(
    (next: number, persist = true) => {
      const clamped = clamp(Math.round(next), min, max);
      setSizeState(clamped);
      onSizeChange?.(clamped);
      if (persist && persistKey) setUiState(persistKey, String(clamped));
    },
    [min, max, persistKey, onSizeChange],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startX: e.clientX, startSize: size };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = e.clientX - drag.current.startX;
    // A right-edge handle grows with the pointer; a left-edge handle grows against it.
    setSize(drag.current.startSize + (edge === "right" ? delta : -delta), false);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = e.clientX - drag.current.startX;
    setSize(drag.current.startSize + (edge === "right" ? delta : -delta));
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) setSize(size + KEY_STEP);
    else if (e.key === shrink) setSize(size - KEY_STEP);
    else if (e.key === "Home") setSize(min);
    else if (e.key === "End") setSize(max);
    else return;
    e.preventDefault();
  };

  return (
    <div className={styles.pane} style={{ width: size }}>
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={size}
        tabIndex={0}
        data-edge={edge}
        data-dragging={dragging}
        className={styles.handle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
