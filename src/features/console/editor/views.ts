import type { EditorView } from "@codemirror/view";

/** The live editor of each open console tab (only the active tab is mounted). */
const views = new Map<string, EditorView>();

export const registerView = (tabId: string, view: EditorView) => {
  views.set(tabId, view);
  return () => {
    if (views.get(tabId) === view) views.delete(tabId);
  };
};

export const getView = (tabId: string) => views.get(tabId);
