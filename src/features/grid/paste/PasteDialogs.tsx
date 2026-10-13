import { useState } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Menu } from "../../../components/Menu";
import { FORMAT_LABELS } from "./detect";
import type { InterpretFormat } from "./detect";
import type { PasteError } from "./plan";
import styles from "./Paste.module.css";

const n = (v: number) => v.toLocaleString();
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/** Spec: data-grid › Large paste (confirm above 10,000 cells). */
export function ConfirmLargeDialog(p: { cells: number; onPaste(): void; onCancel(): void }) {
  return (
    <Dialog
      title={`Paste ${n(p.cells)} cells?`}
      maxWidth={460}
      onClose={p.onCancel}
      footer={
        <>
          <Button variant="default" onClick={p.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={p.onPaste}>
            Paste {n(p.cells)} cells
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        This paste changes {n(p.cells)} cells. You can undo it in one step.
      </div>
    </Dialog>
  );
}

/** Spec: data-grid › More rows than fit. */
export function AddRowsDialog(p: {
  extra: number;
  fit: number;
  onFit(): void;
  onAdd(): void;
  onCancel(): void;
}) {
  return (
    <Dialog
      title={`Add ${plural(p.extra, "new row", "new rows")}?`}
      maxWidth={460}
      onClose={p.onCancel}
      footer={
        <>
          <Button variant="default" onClick={p.onCancel}>
            Cancel
          </Button>
          <Button variant="default" onClick={p.onFit}>
            Paste {plural(p.fit, "row", "rows")} only
          </Button>
          <Button variant="primary" onClick={p.onAdd}>
            Add {plural(p.extra, "row", "rows")}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        Only {plural(p.fit, "row fits", "rows fit")} below the selection. The other{" "}
        {plural(p.extra, "row", "rows")} can be added as new rows.
      </div>
    </Dialog>
  );
}

const MAX_LISTED = 50;

/** Spec: data-grid › Value that doesn't fit. */
export function InvalidValuesDialog(p: {
  errors: PasteError[];
  /** Values that can still be pasted. */
  valid: number;
  onPasteOthers(): void;
  onCancel(): void;
}) {
  const listed = p.errors.slice(0, MAX_LISTED);
  return (
    <Dialog
      title={`${plural(p.errors.length, "value doesn't", "values don't")} fit`}
      maxWidth={560}
      onClose={p.onCancel}
      footer={
        <>
          <Button variant="default" onClick={p.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={p.onPasteOthers} disabled={p.valid === 0}>
            Paste the other values
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <div>Nothing has been pasted yet.</div>
        <ul className={styles.errors} aria-label="Values that can't be pasted">
          {listed.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
          {p.errors.length > listed.length ? (
            <li className={styles.more}>and {n(p.errors.length - listed.length)} more</li>
          ) : null}
        </ul>
      </div>
    </Dialog>
  );
}

/** The notice after a paste, with Interpret as and Undo (spec: data-grid › Paste external data). */
export function PasteNotice(p: {
  text: string;
  onInterpret(format: InterpretFormat): void;
  onUndo(): void;
  onDismiss(): void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className={styles.notice} role="status" aria-label="Paste result">
      <span className={styles.noticeText}>{p.text}</span>
      <span className={styles.menuAnchor}>
        <Button
          variant="ghost"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          Interpret as
        </Button>
        {menu ? (
          <div className={styles.menu}>
            <Menu
              aria-label="Interpret as"
              items={(Object.keys(FORMAT_LABELS) as InterpretFormat[]).map((f) => ({
                id: f,
                label: FORMAT_LABELS[f],
              }))}
              onSelect={(id) => {
                setMenu(false);
                p.onInterpret(id as InterpretFormat);
              }}
              onClose={() => setMenu(false)}
            />
          </div>
        ) : null}
      </span>
      <Button variant="ghost" onClick={p.onUndo}>
        Undo
      </Button>
      <Button variant="ghost" aria-label="Dismiss paste notice" onClick={p.onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
