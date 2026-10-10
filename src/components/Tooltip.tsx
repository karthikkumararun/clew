import { useId, useState } from "react";
import type { ReactElement } from "react";
import { cloneElement } from "react";
import styles from "./Tooltip.module.css";

/** Lightweight hover/focus tooltip. The child receives aria-describedby while visible. */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className={styles.wrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {cloneElement(children, open ? { "aria-describedby": id } : {})}
      {open ? (
        <span role="tooltip" id={id} className={styles.tip}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
