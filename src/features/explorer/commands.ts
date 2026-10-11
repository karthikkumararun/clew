import { registerCommand, runCommand } from "../../shell/registry/commands";
import { registerShortcut } from "../../shell/registry/shortcuts";
import { useConnections } from "../../connections/connectionsStore";
import { introspectDdl } from "../../lib/ipc/drivers";
import { useNotices } from "../../stores/noticesStore";
import { explorerCountRows, scriptsNew, scriptsReveal } from "./api";
import { useExplorer } from "./explorerStore";
import { isTableLike, namespaceOf, qualifiedName } from "./names";
import { connOfId, scriptsNodeId } from "./tree";

const say = (message: string) => useNotices.getState().push(message);

function fail(what: string, e: unknown) {
  const m = typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e);
  say(`${what}: ${m}`);
}

/** The node an action applies to: the id passed in, else the selected row. */
function target(arg: unknown) {
  const ex = useExplorer.getState();
  const id = typeof arg === "string" && arg ? arg : ex.selectedId;
  if (!id) return null;
  const connId = connOfId(id);
  const conn = useConnections.getState().file.connections.find((c) => c.id === connId);
  if (!conn) return null;
  return { id, conn, entry: ex.nodes[id] ?? null };
}

async function clipboard(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    say(done);
  } catch {
    say("Couldn't copy to the clipboard");
  }
}

/** Run a command another change registers (consoles, table editor); say so when it's absent. */
async function delegate(id: string, arg: unknown, missing = "That action isn't available yet") {
  if (!(await runCommand(id, arg))) say(missing);
}

export function selectedTargetIsInExplorer(): boolean {
  return !!document.activeElement?.closest("[data-explorer-tree]");
}

/** Explorer actions as commands, so the context menu and the palette share them. */
export function registerExplorerCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "explorer.refresh",
      title: "Refresh schema",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (t) {
          await useExplorer.getState().refresh(t.id);
          return;
        }
        // Nothing selected: refresh every connected tree.
        const ex = useExplorer.getState();
        await Promise.all(
          Object.keys(useConnections.getState().connected)
            .filter((id) => ex.nodes[id])
            .map((id) => ex.refresh(id)),
        );
      },
    }),
    registerCommand({
      id: "explorer.collapseAll",
      title: "Collapse all in explorer",
      category: "Explorer",
      run: () => useExplorer.getState().collapseAll(),
    }),
    registerCommand({
      id: "explorer.copyName",
      title: "Copy name",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        const name = t?.entry?.name ?? t?.conn.name;
        if (name) await clipboard(name, `Copied ${name}`);
      },
    }),
    registerCommand({
      id: "explorer.copyQualifiedName",
      title: "Copy qualified name",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t?.entry) return;
        const q = qualifiedName(t.conn.driver, t.entry.path);
        await clipboard(q, `Copied ${q}`);
      },
    }),
    registerCommand({
      id: "explorer.openData",
      title: "Open table data",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (t?.entry && t.conn.driver === "mongodb" && isTableLike(t.entry.kind)) {
          await delegate("collection.open", {
            connectionId: t.conn.id,
            database: namespaceOf(t.entry.path).database,
            collection: t.entry.name,
          });
        } else if (t?.entry && isTableLike(t.entry.kind)) {
          await delegate("table.open", { connectionId: t.conn.id, path: t.entry.path });
        }
      },
    }),
    registerCommand({
      id: "explorer.openInConsole",
      title: "Open table in console",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t?.entry || !isTableLike(t.entry.kind)) return;
        await delegate("console.new", {
          connectionId: t.conn.id,
          ...namespaceOf(t.entry.path),
          sql:
            t.conn.driver === "mongodb"
              ? `db.${t.entry.name}.find({})`
              : `SELECT * FROM ${qualifiedName(t.conn.driver, t.entry.path)} LIMIT 100;`,
        });
      },
    }),
    registerCommand({
      id: "explorer.newConsoleHere",
      title: "New console here",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t) return;
        await delegate("console.new", {
          connectionId: t.conn.id,
          ...(t.entry ? namespaceOf(t.entry.path) : {}),
        });
      },
    }),
    registerCommand({
      id: "explorer.generateDdl",
      title: "Generate DDL",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t?.entry) return;
        let ddl: string;
        try {
          ddl = await introspectDdl(t.conn.id, t.entry.path);
        } catch (e) {
          fail("Couldn't generate DDL", e);
          return;
        }
        const opened = await runCommand("console.new", {
          connectionId: t.conn.id,
          ...namespaceOf(t.entry.path),
          sql: ddl,
        });
        if (!opened) await clipboard(ddl, "DDL copied to the clipboard");
      },
    }),
    registerCommand({
      id: "explorer.countRows",
      title: "Count rows",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t?.entry || !isTableLike(t.entry.kind)) return;
        try {
          const n = await explorerCountRows(t.conn.id, t.entry.path);
          useExplorer.getState().setCount(t.id, n);
        } catch (e) {
          fail(`Couldn't count rows of ${t.entry.name}`, e);
        }
      },
    }),
    registerCommand({
      id: "explorer.filterByColumn",
      title: "Filter table by this column",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t?.entry || t.entry.kind !== "column") return;
        const table = t.entry.path.slice(0, -1);
        await delegate("table.filterByColumn", {
          connectionId: t.conn.id,
          path: table,
          column: t.entry.name,
        });
      },
    }),
    registerCommand({
      id: "explorer.openScript",
      title: "Open script",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (t?.entry?.kind !== "script" || !t.entry.file) return;
        await delegate("script.open", { connectionId: t.conn.id, path: t.entry.file.path });
      },
    }),
    registerCommand({
      id: "explorer.newScript",
      title: "New script",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t) return;
        try {
          const path = await scriptsNew(t.conn.id, "script");
          const ex = useExplorer.getState();
          await ex.expand(scriptsNodeId(t.conn.id));
          await ex.refresh(scriptsNodeId(t.conn.id));
          await delegate("script.open", { connectionId: t.conn.id, path }, `Created ${path}`);
        } catch (e) {
          fail("Couldn't create the script", e);
        }
      },
    }),
    registerCommand({
      id: "explorer.revealScript",
      title: "Reveal in file manager",
      category: "Explorer",
      run: async (arg) => {
        const t = target(arg);
        if (!t) return;
        try {
          await scriptsReveal(t.conn.id, t.entry?.file?.relPath);
        } catch (e) {
          fail("Couldn't open the file manager", e);
        }
      },
    }),
    registerCommand({
      id: "connection.edit",
      title: "Edit connection",
      category: "Connection",
      run: (arg) => {
        const t = target(arg);
        if (t) useConnections.getState().openEdit(t.conn.id);
      },
    }),
    registerCommand({
      id: "connection.duplicate",
      title: "Duplicate connection",
      category: "Connection",
      run: async (arg) => {
        const t = target(arg);
        if (t) await useConnections.getState().duplicate(t.conn.id);
      },
    }),
    registerCommand({
      id: "connection.rename",
      title: "Rename connection",
      category: "Connection",
      run: (arg) => {
        const t = target(arg);
        if (t) useConnections.getState().setModal({ kind: "rename", id: t.conn.id });
      },
    }),
    registerCommand({
      id: "connection.delete",
      title: "Delete connection",
      category: "Connection",
      run: (arg) => {
        const t = target(arg);
        if (t) useConnections.getState().setModal({ kind: "delete", id: t.conn.id });
      },
    }),
    // Mod+R refreshes the selected node, but only while the explorer has focus.
    registerShortcut({
      id: "explorer.refresh",
      keys: "Mod+R",
      scope: "global",
      when: selectedTargetIsInExplorer,
      run: (e) => {
        e.preventDefault();
        void runCommand("explorer.refresh");
      },
    }),
  ];
  return () => disposers.forEach((d) => d());
}
