import { create } from "zustand";
import { getTabKind } from "../shell/registry/tabKinds";
import type { Tab } from "../shell/registry/tabKinds";
import { useSettings } from "./settingsStore";

let counter = 0;
const newId = () => `tab-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export interface OpenTabInput<S = unknown> {
  kind: string;
  key: string;
  state: S;
  activate?: boolean;
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Tab awaiting the Save / Discard / Cancel decision. */
  closeRequest: string | null;
  /** Open an editor, or focus the existing one with the same kind + key. Returns the tab id. */
  openTab: <S>(input: OpenTabInput<S>) => string;
  activateTab: (id: string) => void;
  /** Close without asking. */
  closeTab: (id: string) => void;
  /** Close, asking first when the tab is dirty and confirmation is enabled. */
  requestClose: (id: string) => void;
  /** The unsaved-changes part of closing, without the editor's own confirmation. */
  requestCloseUnguarded: (id: string) => void;
  resolveCloseRequest: (decision: "save" | "discard" | "cancel") => Promise<void>;
  moveTab: (id: string, toIndex: number) => void;
  activateRelative: (delta: 1 | -1) => void;
  updateTabState: <S>(id: string, update: Partial<S> | ((s: S) => S)) => void;
  /** Replace all tabs (session restore). */
  restoreTabs: (tabs: Tab[], activeTabId: string | null) => void;
}

export function isTabDirty(tab: Tab): boolean {
  return getTabKind(tab.kind)?.isDirty?.(tab.state) ?? false;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  closeRequest: null,

  openTab: (input) => {
    const existing = get().tabs.find((t) => t.kind === input.kind && t.key === input.key);
    if (existing) {
      if (input.activate !== false) set({ activeTabId: existing.id });
      return existing.id;
    }
    const tab: Tab = { id: newId(), kind: input.kind, key: input.key, state: input.state };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: input.activate === false ? s.activeTabId : tab.id,
    }));
    return tab.id;
  },

  activateTab: (id) => {
    if (get().tabs.some((t) => t.id === id)) set({ activeTabId: id });
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    getTabKind(tabs[index].kind)?.onClose?.(tabs[index]);
    const remaining = tabs.filter((t) => t.id !== id);
    let next = activeTabId;
    if (activeTabId === id) {
      // The tab to the left becomes active, or the first remaining tab.
      next = remaining[Math.max(0, index - 1)]?.id ?? null;
    }
    set((s) => ({
      tabs: remaining,
      activeTabId: next,
      closeRequest: s.closeRequest === id ? null : s.closeRequest,
    }));
  },

  requestClose: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const confirm = getTabKind(tab.kind)?.confirmClose;
    if (confirm) {
      // The editor has its own question first (e.g. an open transaction); then the usual flow.
      set({ activeTabId: id });
      void confirm(tab).then((ok) => {
        if (ok) get().requestCloseUnguarded(id);
      });
      return;
    }
    get().requestCloseUnguarded(id);
  },

  requestCloseUnguarded: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    if (isTabDirty(tab) && useSettings.getState().settings.confirmCloseUnsaved) {
      set({ closeRequest: id, activeTabId: id });
      return;
    }
    get().closeTab(id);
  },

  resolveCloseRequest: async (decision) => {
    const id = get().closeRequest;
    if (!id) return;
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || decision === "cancel") {
      set({ closeRequest: null });
      return;
    }
    if (decision === "save") {
      try {
        const saved = (await getTabKind(tab.kind)?.save?.(tab)) ?? false;
        if (!saved) {
          set({ closeRequest: null }); // save aborted: keep the tab open
          return;
        }
      } catch {
        set({ closeRequest: null });
        return;
      }
    }
    get().closeTab(id);
  },

  moveTab: (id, toIndex) => {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.min(Math.max(toIndex, 0), tabs.length), 0, tab);
    set({ tabs });
  },

  activateRelative: (delta) => {
    const { tabs, activeTabId } = get();
    if (tabs.length === 0) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(i + delta + tabs.length) % tabs.length];
    set({ activeTabId: next.id });
  },

  updateTabState: (id, update) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const state =
          typeof update === "function"
            ? (update as (x: unknown) => unknown)(t.state)
            : { ...(t.state as object), ...(update as object) };
        return { ...t, state };
      }),
    })),

  restoreTabs: (tabs, activeTabId) =>
    set({
      tabs,
      activeTabId: tabs.some((t) => t.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null),
      closeRequest: null,
    }),
}));
