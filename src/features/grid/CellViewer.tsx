import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { useNotices } from "../../stores/noticesStore";
import { isTruncated } from "./cellStyle";
import { valueText } from "../console/valueFormat";
import styles from "./CellViewer.module.css";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Hex dump: offset, up to 16 bytes as hex, then their ASCII. */
export function hexDump(hex: string): { offset: string; bytes: string; ascii: string }[] {
  const lines = [];
  for (let i = 0; i < hex.length; i += 32) {
    const chunk = hex.slice(i, i + 32);
    const pairs = chunk.match(/.{1,2}/g) ?? [];
    const ascii = pairs
      .map((p) => {
        const b = parseInt(p, 16);
        return b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
      })
      .join("");
    lines.push({
      offset: (i / 2).toString(16).padStart(8, "0"),
      bytes: pairs.join(" "),
      ascii,
    });
  }
  return lines;
}

function JsonNode({ name, value, depth }: { name?: string; value: Json; depth: number }) {
  const isContainer = typeof value === "object" && value !== null;
  const [open, setOpen] = useState(depth < 3);
  const label =
    name !== undefined ? <span className={styles.jKey}>{JSON.stringify(name)}: </span> : null;
  if (!isContainer) {
    const cls =
      typeof value === "string"
        ? styles.jString
        : typeof value === "number"
          ? styles.jNumber
          : typeof value === "boolean"
            ? styles.jBool
            : styles.jNull;
    return (
      <div className={styles.jLine}>
        {label}
        <span className={cls}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  const [openCh, closeCh] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <div className={styles.jLine}>
        <button
          type="button"
          className={styles.fold}
          aria-expanded={open}
          aria-label={`${open ? "Fold" : "Unfold"} ${name ?? "root"}`}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "▾" : "▸"}
        </button>
        {label}
        <span className={styles.jPunct}>{openCh}</span>
        {!open ? (
          <span className={styles.jNull}>
            {" "}
            {entries.length} {entries.length === 1 ? "item" : "items"}{" "}
          </span>
        ) : null}
        {!open ? <span className={styles.jPunct}>{closeCh}</span> : null}
      </div>
      {open ? (
        <>
          <div className={styles.jChildren}>
            {entries.map(([k, v]) => (
              <JsonNode
                key={k}
                name={Array.isArray(value) ? undefined : k}
                value={v}
                depth={depth + 1}
              />
            ))}
          </div>
          <div className={styles.jLine}>
            <span className={styles.jPunct}>{closeCh}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

export interface CellViewerProps {
  value: Value;
  column?: ColumnMeta;
  /** For a truncated value: fetch the whole thing. */
  fetchFull?: Promise<Value>;
  onClose: () => void;
}

/** A value viewer: pretty JSON with folding, a hex dump for bytes, wrapped text with a count. */
export function CellViewer({ value, column, fetchFull, onClose }: CellViewerProps) {
  const [shown, setShown] = useState<Value>(value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShown(value);
    if (!isTruncated(value) || !fetchFull) return;
    let live = true;
    setLoading(true);
    fetchFull
      .then((full) => live && setShown(full))
      .catch(
        (e) =>
          live && setError((e as { message?: string }).message ?? "Couldn't load the full value"),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [value, fetchFull]);

  const text = valueText(shown);
  const copy = async (what: string) => {
    try {
      await navigator.clipboard.writeText(what);
      useNotices.getState().push("Copied the value");
    } catch {
      useNotices.getState().push("Couldn't copy to the clipboard");
    }
  };

  let body;
  let copyText = text ?? "";
  if (shown.kind === "null") {
    body = <p className={styles.nullNote}>NULL</p>;
  } else if (shown.kind === "json") {
    copyText = JSON.stringify(shown.value, null, 2);
    body = (
      <div className={styles.json} role="tree" aria-label="JSON">
        <JsonNode value={shown.value as Json} depth={0} />
      </div>
    );
  } else if (shown.kind === "bytes") {
    copyText = shown.value;
    body = (
      <>
        <p className={styles.meta}>
          {shown.len.toLocaleString()} {shown.len === 1 ? "byte" : "bytes"}
        </p>
        <pre className={styles.hex} aria-label="Hex dump">
          {hexDump(shown.value).map((l) => (
            <div key={l.offset}>
              <span className={styles.hexOffset}>{l.offset}</span>
              {"  "}
              <span>{l.bytes.padEnd(47)}</span>
              {"  "}
              <span className={styles.hexAscii}>{l.ascii}</span>
            </div>
          ))}
        </pre>
      </>
    );
  } else {
    body = (
      <>
        <p className={styles.meta}>{[...(text ?? "")].length.toLocaleString()} characters</p>
        <pre className={styles.text}>{text}</pre>
      </>
    );
  }

  return (
    <Dialog
      title={column ? `${column.name} · ${column.type_name || shown.kind}` : "Value"}
      maxWidth={760}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" onClick={() => void copy(copyText)}>
            Copy
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {isTruncated(shown) ? (
          <p className={styles.notice} role="status">
            {loading
              ? "Loading the full value…"
              : error
                ? error
                : "Only the start of this value was loaded."}
          </p>
        ) : loading ? (
          <p className={styles.notice} role="status">
            Loading the full value…
          </p>
        ) : null}
        {body}
      </div>
    </Dialog>
  );
}
