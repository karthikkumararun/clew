import { create } from "zustand";
import { isTauri } from "../lib/ipc";
import { useNotices } from "../stores/noticesStore";
import { connectionsList, connectionsSave, groupsSave } from "./api";
import type { Connection, ConnectionsFile } from "./api";
import { draftFromConnection, newDraft, toSaveRequest } from "./draft";
import type { Draft } from "./draft";

export interface DialogRequest {
  /** What the dialog starts with. */
  initial: Draft;
  /** Password parsed out of a pasted URL; shown in the field, not saved until Save. */
  title: string;
}

interface ConnectionsState {
  file: ConnectionsFile;
  loaded: boolean;
  dialog: DialogRequest | null;
  load: () => Promise<void>;
  openNew: (initial?: Draft) => void;
  openEdit: (id: string) => void;
  closeDialog: () => void;
  /** Save a draft (creating its new group first). Returns the saved connection. */
  save: (draft: Draft, newGroupName?: string) => Promise<Connection>;
}

const EMPTY: ConnectionsFile = { version: 1, groups: [], connections: [] };

export const useConnections = create<ConnectionsState>((set, get) => ({
  file: EMPTY,
  loaded: false,
  dialog: null,
  load: async () => {
    if (!isTauri()) {
      set({ loaded: true });
      return;
    }
    try {
      set({ file: await connectionsList(), loaded: true });
    } catch (e) {
      set({ loaded: true });
      useNotices
        .getState()
        .push(`Couldn't load connections: ${(e as { message?: string }).message ?? String(e)}`);
    }
  },
  openNew: (initial) =>
    set({ dialog: { initial: initial ?? newDraft(), title: "New connection" } }),
  openEdit: (id) => {
    const c = get().file.connections.find((x) => x.id === id);
    if (c) set({ dialog: { initial: draftFromConnection(c), title: "Edit connection" } });
  },
  closeDialog: () => set({ dialog: null }),
  save: async (draft, newGroupName) => {
    let groupId = draft.groupId;
    if (newGroupName?.trim()) {
      const group = await groupsSave({
        id: "",
        name: newGroupName.trim(),
        order: get().file.groups.length,
      });
      groupId = group.id;
    }
    const outcome = await connectionsSave(toSaveRequest({ ...draft, groupId }));
    for (const warning of outcome.warnings) {
      useNotices.getState().push(warning);
    }
    await get().load();
    return outcome.connection;
  },
}));
