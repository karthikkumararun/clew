import { useId } from "react";
import type { ReactNode } from "react";
import styles from "./ConnectionDialog.module.css";

/** Label + control + inline error. The render prop receives the ids to wire up. */
export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (p: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div className={styles.fld}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? errId : undefined,
      })}
      {error ? (
        <span id={errId} role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
