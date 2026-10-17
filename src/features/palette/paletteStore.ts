import { create } from "zustand";

export type PaletteScope = "all" | "objects" | "queries" | "actions";

export const SCOPES: { id: PaletteScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "objects", label: "Objects" },
  { id: "queries", label: "Queries" },
  { id: "actions", label: "Actions" },
];

interface PaletteState {
  open: boolean;
  scope: PaletteScope;
  /** `recent` is the Mod+E preset: recent files and saved queries only, newest first. */
  preset: "recent" | null;
  /** Where focus was when the palette opened, to put it back on close. */
  returnFocus: HTMLElement | null;
  show: (opts?: { scope?: PaletteScope; preset?: "recent" | null }) => void;
  close: () => void;
  setScope: (scope: PaletteScope) => void;
}

export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  scope: "all",
  preset: null,
  returnFocus: null,
  show: (opts = {}) =>
    set({
      open: true,
      scope: opts.scope ?? "all",
      preset: opts.preset ?? null,
      returnFocus: get().open ? get().returnFocus : (document.activeElement as HTMLElement | null),
    }),
  close: () => {
    const { returnFocus } = get();
    set({ open: false, preset: null, returnFocus: null });
    // After the overlay unmounts, so the focus isn't stolen back by its trap.
    queueMicrotask(() => returnFocus?.focus?.());
  },
  setScope: (scope) => set({ scope, preset: null }),
}));

export function cycleScope(current: PaletteScope, step: 1 | -1): PaletteScope {
  const i = SCOPES.findIndex((s) => s.id === current);
  return SCOPES[(i + step + SCOPES.length) % SCOPES.length].id;
}
