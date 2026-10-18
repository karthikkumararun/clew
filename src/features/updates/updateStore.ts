import { create } from "zustand";

/** What the Updates section and the update dialog show. */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate"; checkedAt: number }
  | { kind: "available"; version: string; notes: string; date?: string }
  | { kind: "installing"; percent: number | null }
  | { kind: "error"; message: string };

interface UpdateState {
  status: UpdateStatus;
  /** The update dialog (version, notes, Install and restart) is open. */
  dialogOpen: boolean;
  /** Installed with Homebrew: `brew upgrade` updates the app, not the in-app updater. */
  homebrew: boolean;
  setHomebrew: (homebrew: boolean) => void;
  set: (status: UpdateStatus) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useUpdates = create<UpdateState>((set) => ({
  status: { kind: "idle" },
  dialogOpen: false,
  homebrew: false,
  setHomebrew: (homebrew) => set({ homebrew }),
  set: (status) => set({ status }),
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));
