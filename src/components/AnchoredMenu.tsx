import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useKeepInWindow } from "./useKeepInWindow";

/**
 * A menu panel placed under (or above) a trigger, in a portal on the page itself. Toolbars and
 * panels clip anything positioned inside them (`overflow: hidden`), and a toolbar that wraps puts
 * its buttons near the bottom edge of the window; a portal with fixed coordinates is neither
 * clipped nor covered, and `useKeepInWindow` pulls it back when it would leave the window.
 */
export function AnchoredMenu({
  anchor,
  align = "left",
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    setPos(
      align === "right"
        ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }
        : { top: r.bottom + 4, left: Math.max(8, r.left) },
    );
  }, [anchor, align]);

  useKeepInWindow(host, pos !== null, pos);
  if (!pos) return null;
  return createPortal(
    <div ref={host} style={{ position: "fixed", zIndex: 60, ...pos }}>
      {children}
    </div>,
    document.body,
  );
}
