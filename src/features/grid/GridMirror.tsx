import { lookOf } from "./cellStyle";
import type { GridSource } from "./source";
import styles from "./GridMirror.module.css";

/** Rows mirrored at most: enough for any assertion, cheap for a 100,000-row result. */
export const MIRROR_ROWS = 300;

/** End-to-end builds only (`VITE_CLEW_E2E=1`); the bundler drops it from every other build. */
export const MIRROR_ENABLED = import.meta.env.VITE_CLEW_E2E === "1";

/**
 * The canvas grid is not DOM, so WebDriver cannot read it. This visually hidden table repeats the
 * first rows of the visible columns as text (`data-testid` rows and cells) for tests to read.
 */
export function GridMirror({
  source,
  visible,
  selected,
}: {
  source: GridSource;
  visible: number[];
  /** The selected cell as [visible column, row], for tests to wait on. */
  selected?: readonly [number, number] | null;
}) {
  const rows = Math.min(source.rowCount, MIRROR_ROWS);
  return (
    <table
      className={styles.mirror}
      aria-label="Result grid contents"
      data-testid="grid-mirror"
      data-row-count={source.rowCount}
      data-selected-cell={selected ? `${selected[0]}:${selected[1]}` : undefined}
    >
      <thead>
        <tr>
          {visible.map((c) => (
            <th key={c} scope="col">
              {source.columns[c]?.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          <tr key={r} data-testid="grid-row" data-row={r}>
            {visible.map((c) => (
              <td key={c} data-testid="grid-cell" data-col={source.columns[c]?.name}>
                {lookOf(source.get(c, r), {}).text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
