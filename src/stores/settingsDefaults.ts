export interface Settings {
  /** Editor font size in px (11–20). */
  editorFontSize: number;
  /** Rows fetched per page in the data grid. */
  gridPageSize: 100 | 500 | 1000;
  /** Ask Save / Discard / Cancel before closing a tab with unsaved changes. */
  confirmCloseUnsaved: boolean;
  /** Opt-in update check. */
  checkForUpdates: boolean;
  /** Folder of the Oracle Instant Client, when it isn't in a place Clew looks. */
  oracleClientDir: string;
  /** How console results are browsed: rows load on scroll, or page by page. */
  resultBrowse: "scroll" | "pages";
  /** Rows per page in page mode. */
  resultPageSize: number;
  /** Run a result's statement again after a submit when it has at most 1,000 rows. */
  resultAutoRerun: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 13,
  gridPageSize: 500,
  confirmCloseUnsaved: true,
  checkForUpdates: false,
  oracleClientDir: "",
  resultBrowse: "scroll",
  resultPageSize: 500,
  resultAutoRerun: false,
};
