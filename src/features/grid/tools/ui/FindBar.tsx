/**
 * Contract: the find bar over the grid (spec: data-grid › Find on page). The lead opens it on
 * Mod+F (grid scope) and mounts it while open; it focuses its field on mount.
 *
 * Props:
 *  - `source`: the VIEW (visible rows), so a match's `row` is the display row.
 *  - `columns`: source columns to search (hidden columns left out); default all.
 *  - `from`: cell to start from (the grid's active cell), so the first match is at or after it.
 *  - `onNavigate(displayRow, col)`: move the selection / scroll to the current match.
 *  - `onMatches(lookup, current)`: `lookup(displayRow, col)` tells the grid which cells to
 *    highlight; null when there is nothing to highlight (empty query, invalid pattern, closed).
 *    `current` is the active match (draw it stronger) or null.
 *  - `onClose`: Esc or the close button; focus belongs back on the grid.
 * Enter / Shift+Enter step to the next / previous match (wrapping); Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GridSource } from "../../source";
import {
  currentMatch,
  findLabel,
  findMatches,
  matchLookup,
  nextMatch,
  prevMatch,
  startFind,
} from "../find";
import type { FindMatch, FindState } from "../find";
import styles from "./tools.module.css";

const MAX_MATCHES = 100_000;

export interface FindBarProps {
  source: GridSource;
  columns?: number[];
  from?: { row: number; col: number };
  onNavigate: (displayRow: number, col: number) => void;
  onMatches?: (
    lookup: ((row: number, col: number) => boolean) | null,
    current: FindMatch | null,
  ) => void;
  onClose: () => void;
}

export function FindBar({ source, columns, from, onNavigate, onMatches, onClose }: FindBarProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [index, setIndex] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const fromRef = useRef(from);
  fromRef.current = from;
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;
  const matchesRef = useRef(onMatches);
  matchesRef.current = onMatches;

  const colsKey = columns?.join(",");
  const result = useMemo(
    () =>
      findMatches(
        source,
        null,
        query,
        { caseSensitive, wholeWord, regex },
        { columns, maxMatches: MAX_MATCHES },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, source.version, source.rowCount, query, caseSensitive, wholeWord, regex, colsKey],
  );
  const state: FindState = { result, index: Math.min(index, result.matches.length - 1) };
  const current = currentMatch(state);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // A new result list starts at the first match at or after the active cell.
  useEffect(() => {
    const s = startFind(result, fromRef.current);
    setIndex(s.index);
    const m = currentMatch(s);
    if (m) navRef.current(m.row, m.col);
  }, [result]);

  useEffect(() => {
    matchesRef.current?.(result.matches.length > 0 ? matchLookup(result) : null, current);
  }, [result, current]);
  useEffect(() => () => matchesRef.current?.(null, null), []);

  const step = (back: boolean) => {
    const s = back ? prevMatch(state) : nextMatch(state);
    setIndex(s.index);
    const m = currentMatch(s);
    if (m) onNavigate(m.row, m.col);
  };

  const label = findLabel(state, query);
  const invalid = result.error !== undefined;
  return (
    <div className={styles.find} role="search" aria-label="Find in results">
      <input
        ref={input}
        className={styles.findInput}
        aria-label="Find in results"
        aria-invalid={invalid}
        placeholder="Find"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <Toggle label="Match case" text="Aa" on={caseSensitive} set={setCase} />
      <Toggle label="Whole word" text="W" on={wholeWord} set={setWord} />
      <Toggle label="Regular expression" text=".*" on={regex} set={setRegex} />
      <span
        className={invalid ? styles.findError : styles.findCount}
        role="status"
        aria-label="Find result"
      >
        {label}
      </span>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Previous match"
        disabled={result.matches.length === 0}
        onClick={() => step(true)}
      >
        <Chevron up />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Next match"
        disabled={result.matches.length === 0}
        onClick={() => step(false)}
      >
        <Chevron />
      </button>
      <button type="button" className={styles.iconButton} aria-label="Close find" onClick={onClose}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>
    </div>
  );
}

function Toggle(p: { label: string; text: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-label={p.label}
      aria-pressed={p.on}
      title={p.label}
      onClick={() => p.set(!p.on)}
    >
      {p.text}
    </button>
  );
}

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d={up ? "M1.5 6.5L5 3l3.5 3.5" : "M1.5 3.5L5 7l3.5-3.5"}
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}
