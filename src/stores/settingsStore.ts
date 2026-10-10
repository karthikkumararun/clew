import { create } from "zustand";
import { settingsGet, settingsSet } from "../lib/ipc";
import { clamp } from "../lib/clamp";
import { useNotices } from "./noticesStore";
import { DEFAULT_SETTINGS } from "./settingsDefaults";
import type { Settings } from "./settingsDefaults";

export { DEFAULT_SETTINGS };
export type { Settings };

export const FONT_SIZE_RANGE = { min: 11, max: 20 } as const;
export const PAGE_SIZES = [100, 500, 1000] as const;

interface SettingsState {
  settings: Settings;
  dialogOpen: boolean;
  /** Section shown in the Settings dialog. */
  section: string;
  openDialog: (section?: string) => void;
  closeDialog: () => void;
  setSection: (section: string) => void;
  /** Apply immediately, persist shortly after. */
  set: (patch: Partial<Settings>) => void;
  load: () => Promise<void>;
}

export function normalize(raw: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  return {
    editorFontSize: clamp(
      Math.round(Number(merged.editorFontSize) || DEFAULT_SETTINGS.editorFontSize),
      FONT_SIZE_RANGE.min,
      FONT_SIZE_RANGE.max,
    ),
    gridPageSize: (PAGE_SIZES as readonly number[]).includes(merged.gridPageSize)
      ? merged.gridPageSize
      : DEFAULT_SETTINGS.gridPageSize,
    confirmCloseUnsaved: Boolean(merged.confirmCloseUnsaved),
    checkForUpdates: Boolean(merged.checkForUpdates),
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  dialogOpen: false,
  section: "General",
  openDialog: (section) => set((s) => ({ dialogOpen: true, section: section ?? s.section })),
  closeDialog: () => set({ dialogOpen: false }),
  setSection: (section) => set({ section }),

  set: (patch) => {
    set((s) => ({ settings: normalize({ ...s.settings, ...patch }) }));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      settingsSet(get().settings).catch(() =>
        useNotices.getState().push("Settings could not be saved."),
      );
    }, 300);
  },

  load: async () => {
    try {
      const { settings, notice } = await settingsGet();
      set({ settings: normalize(settings) });
      if (notice) useNotices.getState().push(notice);
    } catch {
      useNotices.getState().push("Settings could not be loaded; using defaults.");
    }
  },
}));

/** Apply settings that affect the whole UI. Editors read `--fs-code`. */
export function applySettingsToDocument(
  settings: Settings,
  root: HTMLElement = document.documentElement,
) {
  root.style.setProperty("--fs-code", `${settings.editorFontSize}px`);
}
