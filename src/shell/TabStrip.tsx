import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ENV_COLORS } from "../components/Badge";
import { IconButton } from "../components/Button";
import { Close, Plus } from "../components/icons";
import { isTabDirty, useWorkspace } from "../stores/workspaceStore";
import { runCommand } from "./registry/commands";
import { getTabKind } from "./registry/tabKinds";
import type { Tab } from "./registry/tabKinds";
import styles from "./TabStrip.module.css";

const DRAG_THRESHOLD = 4;

interface DragState {
  id: string;
  startX: number;
  active: boolean;
}

export function TabStrip() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activateTab = useWorkspace((s) => s.activateTab);
  const requestClose = useWorkspace((s) => s.requestClose);
  const moveTab = useWorkspace((s) => s.moveTab);

  const refs = useRef(new Map<string, HTMLDivElement>());
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(
    null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Keep the active tab in view when the strip overflows.
  useEffect(() => {
    if (!activeTabId) return;
    refs.current.get(activeTabId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  const targetAt = (x: number, draggedId: string) => {
    for (const t of tabs) {
      if (t.id === draggedId) continue;
      const r = refs.current.get(t.id)?.getBoundingClientRect();
      if (!r) continue;
      if (x < r.left + r.width / 2) return { id: t.id, side: "before" as const };
    }
    const last = [...tabs].reverse().find((t) => t.id !== draggedId);
    return last ? { id: last.id, side: "after" as const } : null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, tab: Tab) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    activateTab(tab.id);
    drag.current = { id: tab.id, startX: e.clientX, active: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.active && Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD) return;
    d.active = true;
    setDraggingId(d.id);
    setDropTarget(targetAt(e.clientX, d.id));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    const target = targetAt(e.clientX, d.id);
    if (target) {
      const without = tabs.filter((t) => t.id !== d.id);
      const at = without.findIndex((t) => t.id === target.id);
      moveTab(d.id, target.side === "before" ? at : at + 1);
    }
    setDraggingId(null);
    setDropTarget(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, tab: Tab, index: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateTab(tab.id);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = tabs[(index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      activateTab(next.id);
      bodies.current.get(next.id)?.focus();
    }
  };

  return (
    <div className={styles.strip} data-metric="tab-strip">
      <div role="tablist" aria-label="Open editors" className={styles.list}>
        {tabs.map((tab, index) => {
          const kind = getTabKind(tab.kind);
          const Icon = kind?.icon;
          const env = kind?.env?.(tab.state);
          const subtitle = kind?.subtitle?.(tab.state);
          const dirty = isTabDirty(tab);
          const title = kind?.title(tab.state) ?? tab.key;
          const selected = tab.id === activeTabId;
          // The wrapper carries the pointer handling and the stripe; the tab itself holds only
          // the label, and the close button sits beside it, not inside it (an interactive
          // control must not be nested in a tab).
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) refs.current.set(tab.id, el);
                else refs.current.delete(tab.id);
              }}
              role="presentation"
              data-selected={selected}
              data-env={env}
              data-dragging={draggingId === tab.id}
              data-drop={dropTarget?.id === tab.id ? dropTarget.side : undefined}
              className={styles.tab}
              style={env ? ({ "--stripe": ENV_COLORS[env] } as React.CSSProperties) : undefined}
              onPointerDown={(e) => onPointerDown(e, tab)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onAuxClick={(e) => {
                if (e.button === 1) requestClose(tab.id);
              }}
            >
              <div
                ref={(el) => {
                  if (el) bodies.current.set(tab.id, el);
                  else bodies.current.delete(tab.id);
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                className={styles.tabBody}
                onKeyDown={(e) => onKeyDown(e, tab, index)}
              >
                {Icon ? (
                  <span className={styles.icon}>
                    <Icon size={13} />
                  </span>
                ) : null}
                <span>{title}</span>
                {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
                {dirty ? (
                  <span className={styles.dirty} role="img" aria-label="Unsaved changes" />
                ) : null}
              </div>
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${title}`}
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => requestClose(tab.id)}
              >
                <Close size={10} />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton
        aria-label="New console"
        className={styles.add}
        onClick={() => void runCommand("console.new")}
      >
        <Plus size={14} />
      </IconButton>
    </div>
  );
}
