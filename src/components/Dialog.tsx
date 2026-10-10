import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Close } from "./icons";
import styles from "./Dialog.module.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Max width in px. Dialogs are at most 960px wide; Settings uses 1120. */
  maxWidth?: number;
  /** Hide the standard header (caller renders its own). */
  hideHeader?: boolean;
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  maxWidth = 960,
  hideHeader,
}: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  // Move focus in on open, restore it on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className={styles.backdrop} data-dialog-root>
      <div className={styles.scrim} onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.dialog}
        style={{ maxWidth }}
        onKeyDown={onKeyDown}
      >
        <div className={styles.header} hidden={hideHeader}>
          <h1 id={titleId} className={styles.title}>
            {title}
          </h1>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
