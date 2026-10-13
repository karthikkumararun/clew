/**
 * Contract: the "View as" toolbar group (spec: data-grid › View as): a Table | Tree | Text
 * radiogroup named "View as", a Transpose toggle (aria-pressed) and, in Tree and Text, an
 * "Extractor options" button that opens `ExtractorOptionsDialog` (spec: data-grid › Extractor
 * options). Controlled: the parent owns `mode`, `transpose` and the extractor options (use
 * `useExtractorOptions`). Arrow keys move the radio selection.
 */
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { Settings } from "../../../components/icons";
import { makeIcon } from "../../../components/icons/Icon";
import { ExtractorOptionsDialog } from "./ExtractorOptionsDialog";
import type { ExtractorController } from "./useExtractorOptions";
import styles from "./ResultTools.module.css";

export type ViewMode = "table" | "tree" | "text";

const MODES: { value: ViewMode; label: string }[] = [
  { value: "table", label: "Table" },
  { value: "tree", label: "Tree" },
  { value: "text", label: "Text" },
];

// Canvas icon for Transpose (design/canvas/ResultEditing.dc.html).
const TransposeIcon = makeIcon(<path d="M3 3h4v10H3zM9 3h4v4H9z" />);

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export interface ViewAsProps {
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  transpose: boolean;
  onTranspose: (on: boolean) => void;
  extractor: ExtractorController;
}

export function ViewAs({ mode, onMode, transpose, onTranspose, extractor }: ViewAsProps) {
  const [dialog, setDialog] = useState(false);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[e.key];
    if (!step) return;
    e.preventDefault();
    const i = MODES.findIndex((m) => m.value === mode);
    const n = (i + step + MODES.length) % MODES.length;
    onMode(MODES[n].value);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[n]?.focus();
  };

  return (
    <div className={styles.viewAs}>
      <div
        role="radiogroup"
        aria-label="View as"
        className={styles.segmented}
        onKeyDown={onKeyDown}
      >
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={m.value === mode}
            tabIndex={m.value === mode ? 0 : -1}
            className={styles.segment}
            onClick={() => onMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={styles.iconBtn}
        aria-label="Transpose"
        aria-pressed={transpose}
        title="Transpose: rows become columns"
        onClick={() => onTranspose(!transpose)}
      >
        <TransposeIcon />
      </button>
      {mode === "table" ? null : (
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Extractor options"
          aria-haspopup="dialog"
          title="Extractor options"
          onClick={() => setDialog(true)}
        >
          <Settings />
        </button>
      )}
      {dialog ? (
        <ExtractorOptionsDialog
          options={extractor.options}
          store={extractor.store}
          hideFormat={mode === "tree"}
          onApply={(o) => {
            extractor.setOptions(o);
            setDialog(false);
          }}
          onClose={() => setDialog(false)}
        />
      ) : null}
    </div>
  );
}
