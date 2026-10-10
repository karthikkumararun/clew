import { registerCommand, runCommand } from "../shell/registry/commands";
import { setRecentConnections } from "../shell/registry/recents";
import { registerSlotItem } from "../shell/registry/slots";
import { useLayout } from "../stores/layoutStore";
import { connectionsParseUrl } from "./api";
import type { Connection } from "./api";
import { ConnectionChip } from "./ConnectionChip";
import { useConnections } from "./connectionsStore";
import { BADGE_ENV, badgeDriver, relativeTime, shortAddress } from "./display";
import { applySettings, newDraft } from "./draft";
import { pickFile } from "./files";

const RECENT_LIMIT = 5;

/** The five most recently used connections, formatted for the Welcome screen. */
export function recentsOf(connections: Connection[], now = Date.now()) {
  return connections
    .filter((c) => c.lastUsedAt)
    .sort((a, b) => Date.parse(b.lastUsedAt ?? "") - Date.parse(a.lastUsedAt ?? ""))
    .slice(0, RECENT_LIMIT)
    .map((c) => ({
      id: c.id,
      name: c.name,
      driver: badgeDriver(c.driver),
      env: BADGE_ENV[c.environment],
      detail: `${shortAddress(c)}${c.ssh?.enabled ? ` · via ${c.ssh.host}` : ""}`,
      lastUsed: relativeTime(c.lastUsedAt, now),
    }));
}

/** Pasted-URL flow: parse in Rust, then open the dialog prefilled for the user to confirm. */
export async function openFromUrl(url: string): Promise<boolean> {
  const store = useConnections.getState();
  try {
    const parsed = await connectionsParseUrl(url);
    let draft = applySettings(newDraft(parsed.driver), parsed.settings);
    draft = {
      ...draft,
      tlsMode: parsed.tls.mode,
      password: parsed.password ?? "",
      portEdited: true,
    };
    store.setUrlError(null);
    store.openNew(draft);
    return true;
  } catch (e) {
    store.setUrlError((e as { message?: string }).message ?? "That isn't a valid connection URL");
    return false;
  }
}

/** File-picker flow for SQLite / DuckDB files. */
export async function openDatabaseFile(): Promise<void> {
  const path = await pickFile({
    title: "Open a database file",
    filters: [
      { name: "Database", extensions: ["db", "sqlite", "sqlite3", "db3", "duckdb", "ddb"] },
    ],
  });
  if (!path) return;
  const driver = /\.(duckdb|ddb)$/i.test(path) ? "duckdb" : "sqlite";
  const draft = applySettings(newDraft(driver), { kind: "file", path, createIfMissing: false });
  const stem =
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? driver;
  useConnections.getState().openNew({ ...draft, name: stem, nameEdited: true });
}

/** Commands, toolbar chip and Welcome data owned by connection management. Returns a disposer. */
export function registerConnectionCommands(): () => void {
  const store = () => useConnections.getState();
  const disposers = [
    registerCommand({
      id: "connection.new",
      title: "New connection",
      category: "Connection",
      shortcut: "Mod+N",
      run: () => store().openNew(),
    }),
    registerCommand({
      id: "connection.fromUrl",
      title: "New connection from URL",
      category: "Connection",
      run: (arg) => void openFromUrl(String(arg ?? "")),
    }),
    registerCommand({
      id: "file.openDatabase",
      title: "Open a database file",
      category: "File",
      shortcut: "Mod+O",
      run: () => openDatabaseFile(),
    }),
    registerCommand({
      id: "connection.open",
      title: "Connect",
      category: "Connection",
      run: async (arg) => {
        const id = String(arg ?? "");
        if (!id) return;
        store().select(id);
        if (await store().connect(id)) await runCommand("console.new", { connectionId: id });
      },
    }),
    registerCommand({
      id: "connection.disconnect",
      title: "Disconnect",
      category: "Connection",
      run: async (arg) => {
        const id = String(arg ?? store().selectedId ?? "");
        if (id) await store().requestDisconnect(id);
      },
    }),
    registerCommand({
      id: "connection.import",
      title: "Import connections",
      category: "Connection",
      run: () => store().setExchange({ tab: "import" }),
    }),
    registerCommand({
      id: "connection.export",
      title: "Export connections",
      category: "Connection",
      run: () => store().setExchange({ tab: "export" }),
    }),
    registerCommand({
      id: "connection.manage",
      title: "All connections",
      category: "Connection",
      run: () => {
        const layout = useLayout.getState();
        const shown = layout.narrow ? layout.overlayOpen : layout.sidebarOpen;
        if (!shown) layout.toggleSidebar();
      },
    }),
    registerSlotItem("toolbarCenter", { id: "connection.chip", render: () => <ConnectionChip /> }),
  ];
  const publishRecents = () => setRecentConnections(recentsOf(store().file.connections));
  publishRecents();
  const unsubscribe = useConnections.subscribe((s, prev) => {
    if (s.file !== prev.file) publishRecents();
  });
  return () => {
    unsubscribe();
    disposers.forEach((d) => d());
  };
}
