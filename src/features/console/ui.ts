import { create } from "zustand";

/** Per-tab, non-persisted UI facts the status bar and toolbar read. */
interface ConsoleUiState {
  cursor: Record<string, { line: number; col: number }>;
  setCursor: (tabId: string, line: number, col: number) => void;
  forget: (tabId: string) => void;
}

export const useConsoleUi = create<ConsoleUiState>((set) => ({
  cursor: {},
  setCursor: (tabId, line, col) =>
    set((s) => {
      const cur = s.cursor[tabId];
      return cur && cur.line === line && cur.col === col
        ? s
        : { cursor: { ...s.cursor, [tabId]: { line, col } } };
    }),
  forget: (tabId) =>
    set((s) => {
      const { [tabId]: _gone, ...rest } = s.cursor;
      void _gone;
      return { cursor: rest };
    }),
}));
