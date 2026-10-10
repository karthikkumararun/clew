import { useEffect, useRef } from "react";
import type { OutputEntry } from "./runtime";
import styles from "./Console.module.css";

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** The append-only log of statements, timings, rows affected and errors. */
export function OutputLog({ entries }: { entries: OutputEntry[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <p className={styles.emptyPane}>Run a statement to see its timing and any messages here.</p>
    );
  }
  return (
    <div className={styles.output} role="log" aria-label="Output">
      {entries.map((e) => (
        <div key={e.id} className={styles.outputEntry} data-kind={e.kind}>
          <span className={styles.outputTime}>{time(e.at)}</span>
          <div className={styles.outputBody}>
            {e.statement ? <code className={styles.outputSql}>{e.statement}</code> : null}
            <div className={styles.outputMessage}>{e.message}</div>
            {e.hint ? <div className={styles.outputHint}>Hint: {e.hint}</div> : null}
            {e.detail ? <div className={styles.outputHint}>{e.detail}</div> : null}
          </div>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
