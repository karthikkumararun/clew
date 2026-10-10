export interface Settings {
  /** Editor font size in px (11–20). */
  editorFontSize: number;
  /** Rows fetched per page in the data grid. */
  gridPageSize: 100 | 500 | 1000;
  /** Ask Save / Discard / Cancel before closing a tab with unsaved changes. */
  confirmCloseUnsaved: boolean;
  /** Opt-in update check. */
  checkForUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 13,
  gridPageSize: 500,
  confirmCloseUnsaved: true,
  checkForUpdates: false,
};
