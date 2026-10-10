import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import styles from "./Menu.module.css";

export interface MenuItem {
  id: string;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  "aria-label": string;
  style?: CSSProperties;
}

/** Keyboard-navigable menu: Arrow keys / Home / End move, Enter/Space select, Esc closes. */
export function Menu({ items, onSelect, onClose, style, "aria-label": ariaLabel }: MenuProps) {
  const enabled = items.filter((i) => !i.disabled);
  const [active, setActive] = useState(0);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const target = enabled[active];
    if (target) refs.current[target.id]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const move = (delta: number) => setActive((a) => (a + delta + enabled.length) % enabled.length);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(enabled.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case "Tab":
        onClose();
        break;
    }
  };

  return (
    <div
      role="menu"
      aria-label={ariaLabel}
      className={styles.menu}
      style={style}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          ref={(el) => {
            refs.current[item.id] = el;
          }}
          type="button"
          role="menuitem"
          className={styles.item}
          disabled={item.disabled}
          tabIndex={enabled[active]?.id === item.id ? 0 : -1}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
          {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
