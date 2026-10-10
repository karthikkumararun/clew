import { create } from "zustand";
import { isTauri } from "../lib/ipc";
import { useNotices } from "../stores/noticesStore";
import { useWorkspace } from "../stores/workspaceStore";
import {
  connectionsConnect,
  connectionsDelete,
  connectionsDisconnect,
  connectionsDuplicate,
  connectionsList,
  connectionsOpenTransactions,
  connectionsSave,
  groupsDelete,
  groupsSave,
} from "./api";
import type { ConnectedInfo, Connection, ConnectionsFile, Environment } from "./api";
import { defaultSafeguards, draftFromConnection, newDraft, toSaveRequest } from "./draft";
import type { Draft } from "./draft";

export interface DialogRequest {
  /** What the dialog starts with. */
  initial: Draft;
  title: string;
}

/** Confirmations and name prompts shown over the explorer. */
export type Modal =
  | { kind: "delete"; id: string }
  | { kind: "transactions"; id: string; sessions: number }
  | { kind: "rename"; id: string }
  | { kind: "newGroup"; moveConnectionId?: string }
  | { kind: "renameGroup"; id: string }
  | { kind: "deleteGroup"; id: string };

interface ConnectionsState {
  file: ConnectionsFile;
  loaded: boolean;
  dialog: DialogRequest | null;
  modal: Modal | null;
  /** Connected connections and what the status bar shows for them. */
  connected: Record<string, ConnectedInfo>;
  busy: Record<string, "connecting" | "disconnecting">;
  selectedId: string | null;
  /** The Import / Export dialog, when open. */
  exchange: { tab: "export" | "import" } | null;
  setExchange: (exchange: { tab: "export" | "import" } | null) => void;
  /** Shown under the Welcome URL field when a pasted URL can't be used. */
  urlError: string | null;
  setUrlError: (message: string | null) => void;

  load: () => Promise<void>;
  openNew: (initial?: Draft) => void;
  openEdit: (id: string) => void;
  closeDialog: () => void;
  /** Save a draft (creating its new group first). Returns the saved connection. */
  save: (draft: Draft, newGroupName?: string) => Promise<Connection>;

  select: (id: string | null) => void;
  setModal: (modal: Modal | null) => void;
  connect: (id: string) => Promise<boolean>;
  /** Disconnect, asking first when a session has an uncommitted transaction. */
  requestDisconnect: (id: string) => Promise<void>;
  disconnect: (id: string, endTransactions?: "commit" | "rollback") => Promise<void>;
  confirmDelete: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  move: (id: string, groupId: string | null) => Promise<void>;
  setEnvironment: (id: string, environment: Environment) => Promise<void>;
  createGroup: (name: string, moveConnectionId?: string) => Promise<void>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
}

const EMPTY: ConnectionsFile = { version: 1, groups: [], connections: [] };

function messageOf(e: unknown): string {
  return typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

/** Save a connection without touching any of its secrets. */
function saveKeepingSecrets(connection: Connection) {
  return connectionsSave({
    connection,
    password: { action: "keep" },
    sshPassphrase: { action: "keep" },
    sshPassword: { action: "keep" },
  });
}

/** Tabs bound to a connection carry its id in their state. */
function tabsOf(connectionId: string) {
  return useWorkspace
    .getState()
    .tabs.filter(
      (t) => (t.state as { connectionId?: string } | null)?.connectionId === connectionId,
    );
}

export const useConnections = create<ConnectionsState>((set, get) => {
  const fail = (what: string, e: unknown) => useNotices.getState().push(`${what}: ${messageOf(e)}`);

  const find = (id: string) => get().file.connections.find((c) => c.id === id);

  return {
    file: EMPTY,
    loaded: false,
    dialog: null,
    modal: null,
    connected: {},
    busy: {},
    selectedId: null,
    exchange: null,
    setExchange: (exchange) => set({ exchange }),
    urlError: null,
    setUrlError: (urlError) => set({ urlError }),

    load: async () => {
      if (!isTauri()) {
        set({ loaded: true });
        return;
      }
      try {
        set({ file: await connectionsList(), loaded: true });
      } catch (e) {
        set({ loaded: true });
        fail("Couldn't load connections", e);
      }
    },

    openNew: (initial) =>
      set({ dialog: { initial: initial ?? newDraft(), title: "New connection" } }),
    openEdit: (id) => {
      const c = find(id);
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
      for (const warning of outcome.warnings) useNotices.getState().push(warning);
      await get().load();
      return outcome.connection;
    },

    select: (id) => set({ selectedId: id }),
    setModal: (modal) => set({ modal }),

    connect: async (id) => {
      if (get().connected[id]) return true;
      if (get().busy[id]) return false;
      set((s) => ({ busy: { ...s.busy, [id]: "connecting" } }));
      try {
        const info = await connectionsConnect(id);
        set((s) => ({ connected: { ...s.connected, [id]: info } }));
        await get().load(); // last-used time changed
        return true;
      } catch (e) {
        const name = find(id)?.name ?? "the connection";
        const code = (e as { code?: string }).code;
        if (code !== "cancelled") fail(`Couldn't connect to ${name}`, e);
        return false;
      } finally {
        set((s) => {
          const busy = { ...s.busy };
          delete busy[id];
          return { busy };
        });
      }
    },

    requestDisconnect: async (id) => {
      try {
        const sessions = (await connectionsOpenTransactions(id)).length;
        if (sessions > 0) {
          set({ modal: { kind: "transactions", id, sessions } });
          return;
        }
      } catch {
        /* not connected: nothing to ask */
      }
      await get().disconnect(id);
    },

    disconnect: async (id, endTransactions) => {
      set((s) => ({ modal: null, busy: { ...s.busy, [id]: "disconnecting" } }));
      try {
        await connectionsDisconnect(id, endTransactions);
        set((s) => {
          const connected = { ...s.connected };
          delete connected[id];
          return { connected };
        });
      } catch (e) {
        fail("Couldn't disconnect", e);
      } finally {
        set((s) => {
          const busy = { ...s.busy };
          delete busy[id];
          return { busy };
        });
      }
    },

    confirmDelete: async (id) => {
      set({ modal: null });
      try {
        const warnings = await connectionsDelete(id);
        for (const w of warnings) useNotices.getState().push(w);
      } catch (e) {
        fail("Couldn't delete the connection", e);
        return;
      }
      set((s) => {
        const connected = { ...s.connected };
        delete connected[id];
        return { connected, selectedId: s.selectedId === id ? null : s.selectedId };
      });
      // Tabs for the connection close, asking about unsaved changes first.
      for (const tab of tabsOf(id)) useWorkspace.getState().requestClose(tab.id);
      await get().load();
    },

    rename: async (id, name) => {
      const c = find(id);
      if (!c || !name.trim()) return;
      try {
        await saveKeepingSecrets({ ...c, name: name.trim() });
        set({ modal: null });
        await get().load();
      } catch (e) {
        fail("Couldn't rename the connection", e);
      }
    },

    duplicate: async (id) => {
      try {
        const outcome = await connectionsDuplicate(id);
        for (const w of outcome.warnings) useNotices.getState().push(w);
        await get().load();
        get().openEdit(outcome.connection.id);
      } catch (e) {
        fail("Couldn't duplicate the connection", e);
      }
    },

    move: async (id, groupId) => {
      const c = find(id);
      if (!c) return;
      try {
        await saveKeepingSecrets({ ...c, groupId: groupId ?? undefined });
        await get().load();
      } catch (e) {
        fail("Couldn't move the connection", e);
      }
    },

    setEnvironment: async (id, environment) => {
      const c = find(id);
      if (!c || c.environment === environment) return;
      const untouched =
        JSON.stringify(c.safeguards) === JSON.stringify(defaultSafeguards(c.environment));
      try {
        await saveKeepingSecrets({
          ...c,
          environment,
          safeguards: untouched ? defaultSafeguards(environment) : c.safeguards,
        });
        await get().load();
      } catch (e) {
        fail("Couldn't change the environment", e);
      }
    },

    createGroup: async (name, moveConnectionId) => {
      try {
        const group = await groupsSave({
          id: "",
          name,
          order: get().file.groups.length,
        });
        set({ modal: null });
        if (moveConnectionId) await get().move(moveConnectionId, group.id);
        else await get().load();
      } catch (e) {
        fail("Couldn't create the group", e);
      }
    },

    renameGroup: async (id, name) => {
      const g = get().file.groups.find((x) => x.id === id);
      if (!g || !name.trim()) return;
      try {
        await groupsSave({ ...g, name: name.trim() });
        set({ modal: null });
        await get().load();
      } catch (e) {
        fail("Couldn't rename the group", e);
      }
    },

    deleteGroup: async (id) => {
      set({ modal: null });
      try {
        await groupsDelete(id);
        await get().load();
      } catch (e) {
        fail("Couldn't delete the group", e);
      }
    },
  };
});
