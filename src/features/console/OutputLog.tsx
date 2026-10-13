import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Menu } from "../../components/Menu";
import { useKeepInWindow } from "../../components/useKeepInWindow";
import { lineDiff } from "./lineDiff";
import type { OutputEntry } from "./runtime";
import styles from "./Console.module.css";

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** The entry as plain text (what Copy puts on the clipboard). */
export function entryText(e: OutputEntry): string {
  return [
    `${time(e.at)}${e.tx ? ` [${e.tx === "manual" ? "manual tx" : "auto-commit"}]` : ""}`,
    e.statement,
    e.message,
    e.hint ? `Hint: ${e.hint}` : "",
    e.detail ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The append-only log of statements, timings, rows affected and errors. */
export function OutputLog({
  entries,
  onAction,
  onClear,
}: {
  entries: OutputEntry[];
  /** The button on an entry was pressed. */
  onAction?: (entry: OutputEntry) => void;
  /** Empty the log for this console (the history is unaffected). */
  onClear?: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [menu, setMenu] = useState<{ entry: OutputEntry; x: number; y: number } | null>(null);
  const [compare, setCompare] = useState<{ left: string; right: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useKeepInWindow(menuRef, menu !== null, menu);

  // Pause stops the view from following new entries; they keep arriving.
  useEffect(() => {
    if (autoScroll && !paused) end.current?.scrollIntoView?.({ block: "end" });
  }, [entries.length, autoScroll, paused]);

  const writeClipboard = (text: string) => void navigator.clipboard.writeText(text);

  const pick = async (id: string) => {
    const entry = menu?.entry;
    setMenu(null);
    if (!entry) return;
    if (id === "copy") writeClipboard(entryText(entry));
    else if (id === "copy-statement") writeClipboard(entry.statement);
    else if (id === "compare") {
      let right = "";
      try {
        right = await navigator.clipboard.readText();
      } catch {
        /* an empty clipboard is compared */
      }
      setCompare({ left: entry.statement, right });
    }
  };

  return (
    <div className={styles.outputPane}>
      <div className={styles.outputTools} role="toolbar" aria-label="Output tools">
        <Button variant="toolbar" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>
          Soft wrap
        </Button>
        <Button
          variant="toolbar"
          aria-pressed={autoScroll}
          onClick={() => setAutoScroll((v) => !v)}
        >
          Auto-scroll
        </Button>
        <Button variant="toolbar" aria-pressed={paused} onClick={() => setPaused((v) => !v)}>
          {paused ? "Resume output" : "Pause output"}
        </Button>
        <span className={styles.grow} />
        <Button variant="toolbar" disabled={entries.length === 0} onClick={onClear}>
          Clear
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className={styles.emptyPane}>Run a statement to see its timing and any messages here.</p>
      ) : (
        <div className={styles.output} role="log" aria-label="Output" data-wrap={wrap}>
          {entries.map((e) => (
            <div
              key={e.id}
              className={styles.outputEntry}
              data-kind={e.kind}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setMenu({ entry: e, x: ev.clientX, y: ev.clientY });
              }}
            >
              <span className={styles.outputTime}>{time(e.at)}</span>
              <div className={styles.outputBody}>
                {e.statement ? <code className={styles.outputSql}>{e.statement}</code> : null}
                <div className={styles.outputMessage}>
                  {e.message}
                  {e.tx ? (
                    <span className={styles.outputTx}>
                      {" · "}
                      {e.tx === "manual" ? "manual transaction" : "auto-commit"}
                    </span>
                  ) : null}
                </div>
                {e.hint ? <div className={styles.outputHint}>Hint: {e.hint}</div> : null}
                {e.detail ? <div className={styles.outputHint}>{e.detail}</div> : null}
                {e.action === "switch-read-write" && onAction ? (
                  <button type="button" className={styles.outputAction} onClick={() => onAction(e)}>
                    Switch to read-write
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
      {menu ? (
        <>
          <div className={styles.menuScrim} onMouseDown={() => setMenu(null)} aria-hidden="true" />
          <div
            ref={menuRef}
            className={styles.outputMenuHost}
            style={{ left: menu.x, top: menu.y }}
          >
            <Menu
              aria-label="Output actions"
              items={[
                { id: "copy", label: "Copy" },
                { id: "copy-statement", label: "Copy statement", disabled: !menu.entry.statement },
                { id: "compare", label: "Compare with clipboard", disabled: !menu.entry.statement },
              ]}
              onClose={() => setMenu(null)}
              onSelect={(id) => void pick(id)}
            />
          </div>
        </>
      ) : null}
      {compare ? (
        <Dialog title="Compare with clipboard" onClose={() => setCompare(null)} maxWidth={720}>
          <pre className={styles.diff} aria-label="Differences">
            {lineDiff(compare.left, compare.right).map((l, i) => (
              <div key={i} data-kind={l.kind}>
                {l.kind === "added" ? "+ " : l.kind === "removed" ? "− " : "  "}
                {l.text}
              </div>
            ))}
          </pre>
        </Dialog>
      ) : null}
    </div>
  );
}
