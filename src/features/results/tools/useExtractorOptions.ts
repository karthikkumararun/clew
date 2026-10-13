/**
 * Contract: the extractor options of one result view, remembered per format (spec: data-grid ›
 * Extractor options). Wraps `defaultExtractorStore / optionsFor / rememberOptions` so the
 * options menu, the Text view and the Tree view share one state. Lift it to where the view mode
 * lives (or to a global store, to share it with Copy as and Export).
 */
import { useCallback, useMemo, useState } from "react";
import {
  defaultExtractorStore,
  optionsFor,
  rememberOptions,
} from "../../grid/tools/viewAs";
import type { ExtractorFormat, ExtractorOptions, ExtractorStore } from "../../grid/tools/viewAs";

export interface ExtractorController {
  /** Options of the current format. */
  options: ExtractorOptions;
  /** Options remembered for every format. */
  store: ExtractorStore;
  /** Switch format; that format's remembered options come back. */
  setFormat: (format: ExtractorFormat) => void;
  /** Store options under their own format and make it current. */
  setOptions: (options: ExtractorOptions) => void;
}

export function useExtractorOptions(
  initialFormat: ExtractorFormat = "csv",
  initialStore?: ExtractorStore,
): ExtractorController {
  const [store, setStore] = useState<ExtractorStore>(() => initialStore ?? defaultExtractorStore());
  const [format, setFormatState] = useState<ExtractorFormat>(initialFormat);
  const setOptions = useCallback((o: ExtractorOptions) => {
    setStore((s) => rememberOptions(s, o));
    setFormatState(o.format);
  }, []);
  return useMemo(
    () => ({ options: optionsFor(store, format), store, setFormat: setFormatState, setOptions }),
    [store, format, setOptions],
  );
}
