/**
 * Contract: the Text view of a result (spec: data-grid › View as › Text view as CSV): every row
 * as text in the chosen extractor format, in a read-only monospaced view that can be selected,
 * with a Format select and a Copy button. Transpose lays columns out as lines. `onCopy` defaults
 * to the clipboard; pass the app's clipboard helper to share its error handling.
 */
import { useMemo, useState } from "react";
import { Button } from "../../../components/Button";
import { Select } from "../../../components/Input";
import { toText, EXTRACTOR_FORMATS } from "../../grid/tools/viewAs";
import type { ExtractorFormat } from "../../grid/tools/viewAs";
import { FORMAT_LABELS } from "./ExtractorOptionsDialog";
import { useResultData } from "./resultViewData";
import type { ResultViewProps } from "./resultViewData";
import styles from "./ResultTools.module.css";

export interface ResultTextViewProps extends ResultViewProps {
  onCopy?: (text: string) => void | Promise<void>;
}

export function ResultTextView(props: ResultTextViewProps) {
  const { data, options, shown, total } = useResultData(props);
  const text = useMemo(
    () => toText(data.rows, data.columns, { extractor: options, transpose: props.transpose }),
    [data, options, props.transpose],
  );
  const [status, setStatus] = useState<string | null>(null);

  const copy = async () => {
    try {
      await (props.onCopy ?? ((t: string) => navigator.clipboard.writeText(t)))(text);
      setStatus("Copied");
    } catch {
      setStatus("Could not copy");
    }
  };

  return (
    <div className={styles.view} role="region" aria-label="Result as text">
      <div className={styles.viewBar}>
        <label htmlFor="text-view-format">Format</label>
        <Select
          id="text-view-format"
          value={options.format}
          onChange={(e) => props.extractor.setFormat(e.target.value as ExtractorFormat)}
        >
          {EXTRACTOR_FORMATS.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABELS[f]}
            </option>
          ))}
        </Select>
        {shown < total ? (
          <span>
            First {shown} of {total} rows
          </span>
        ) : null}
        <span className={styles.grow} />
        <span role="status">{status}</span>
        <Button onClick={() => void copy()}>Copy</Button>
      </div>
      <div className={styles.viewBody}>
        <pre
          className={styles.text}
          role="textbox"
          aria-readonly="true"
          aria-multiline="true"
          aria-label="Result text"
          tabIndex={0}
        >
          {text}
        </pre>
      </div>
    </div>
  );
}
