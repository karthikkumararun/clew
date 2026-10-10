import { connOfId } from "../explorer/tree";
import { useExplorer } from "../explorer/explorerStore";
import { useConnections } from "../../connections/connectionsStore";
import { registerCommand } from "../../shell/registry/commands";
import { registerShortcut } from "../../shell/registry/shortcuts";
import { useNoticesStore } from "./notices";
import { formatSql } from "./editor/format";
import { splitDialect } from "./editor/dialects";
import { splitStatements, statementAt } from "./editor/statements";
import { getRuntime } from "./runtime";
import { submitExplain, submitRun } from "./run";
import { isWrite } from "./explain";
import { askChoice } from "./prompts";
import { ConsoleToolbar } from "./ConsoleToolbar";
import { registerSlotItem } from "../../shell/registry/slots";
import { getView } from "./editor/views";
import { useWorkspace } from "../../stores/workspaceStore";
import { pickConnection } from "./ConnectionPicker";
import { CONSOLE_KIND, newConsoleKey } from "./state";
import type { ConsoleState } from "./state";
import type { Tab } from "../../shell/registry/tabKinds";

/** Arguments of `console.new`. */
export interface NewConsoleArgs {
  connectionId?: string;
  database?: string;
  schema?: string;
  /** Initial text; not run. */
  sql?: string;
}

/** The connection a new console should use: the explorer's selection, else the active tab's. */
export function connectionInContext(): string | null {
  const known = new Set(useConnections.getState().file.connections.map((c) => c.id));
  const selected = useExplorer.getState().selectedId;
  if (selected && known.has(connOfId(selected)) && !selected.startsWith("group:")) {
    return connOfId(selected);
  }
  const { tabs, activeTabId } = useWorkspace.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  const bound = (active?.state as { connectionId?: string } | undefined)?.connectionId;
  return bound && known.has(bound) ? bound : null;
}

/** Open a console tab (always a new one). Returns its tab id, or null if nothing was chosen. */
export async function openConsole(args: NewConsoleArgs = {}): Promise<string | null> {
  const connectionId = args.connectionId ?? connectionInContext() ?? (await pickConnection());
  if (!connectionId) return null;
  const state: ConsoleState = {
    connectionId,
    database: args.database,
    schema: args.schema,
    text: args.sql ?? "",
    txMode: "auto",
  };
  return useWorkspace.getState().openTab({ kind: CONSOLE_KIND, key: newConsoleKey(), state });
}

/** The active tab when it is a console, with its live editor. */
export function activeConsole() {
  const { tabs, activeTabId } = useWorkspace.getState();
  const tab = tabs.find((t) => t.id === activeTabId && t.kind === CONSOLE_KIND);
  const view = tab ? getView(tab.id) : undefined;
  return tab && view ? { tab: tab as Tab<ConsoleState>, view } : null;
}

/** What a run command would execute for the active editor, or why there is nothing to run. */
export function sqlToRun(
  mode: "current" | "script",
): { tab: Tab<ConsoleState>; sql: string; script: boolean; offset: number } | null {
  const active = activeConsole();
  if (!active) return null;
  const { tab, view } = active;
  const driver = useConnections
    .getState()
    .file.connections.find((c) => c.id === tab.state.connectionId)?.driver;
  const dialect = splitDialect(driver ?? "");
  const sel = view.state.selection.main;
  if (mode === "script") {
    const sql = view.state.doc.toString();
    return sql.trim() ? { tab, sql, script: true, offset: 0 } : null;
  }
  if (!sel.empty) {
    const sql = view.state.sliceDoc(sel.from, sel.to);
    if (!sql.trim()) return null;
    return { tab, sql, script: splitStatements(sql, dialect).length > 1, offset: sel.from };
  }
  const ranges = splitStatements(view.state.doc.toString(), dialect, {
    blankLines: true,
    skipLeadingComments: true,
  });
  const current = statementAt(ranges, sel.head);
  return current ? { tab, sql: current.text, script: false, offset: current.from } : null;
}

/** Run the selection or current statement (`current`), or the whole script. */
export async function runActive(mode: "current" | "script"): Promise<void> {
  const what = sqlToRun(mode);
  if (!what) {
    if (activeConsole()) useNoticesStore.push("Nothing to run at the cursor");
    return;
  }
  await submitRun(what.tab, { sql: what.sql, script: what.script, offset: what.offset });
}

/**
 * Explain the selection or current statement. ANALYZE executes it, so a write needs the user's
 * confirmation (it runs inside a transaction that is rolled back) and is refused outright on a
 * read-only connection.
 */
export async function explainActive(analyze: boolean): Promise<void> {
  const what = sqlToRun("current");
  if (!what) {
    if (activeConsole()) useNoticesStore.push("Nothing to explain at the cursor");
    return;
  }
  if (analyze && isWrite(what.sql)) {
    const connection = useConnections
      .getState()
      .file.connections.find((c) => c.id === what.tab.state.connectionId);
    if (connection?.safeguards.readOnlyByDefault) {
      useNoticesStore.push(
        "Explain Analyze would execute a write, and this connection is read-only",
      );
      return;
    }
    const answer = await askChoice({
      title: "Explain Analyze runs the statement",
      body: (
        <p>
          ANALYZE executes the statement to measure it. It runs inside a transaction that is rolled
          back afterwards, but triggers and sequences may still have side effects.
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "run", label: "Run Explain Analyze", variant: "primary" },
      ],
    });
    if (answer !== "run") return;
  }
  await submitExplain(what.tab, { sql: what.sql, offset: what.offset, analyze });
}

export async function rerunActive(): Promise<void> {
  const active = activeConsole();
  if (!active) return;
  const last = getRuntime(active.tab.id, active.tab.state.connectionId).store.getState().lastRun;
  if (last) await submitRun(active.tab, last);
}

/** Cancel the active console's running statement. */
export async function cancelActive(): Promise<void> {
  const tab = useWorkspace
    .getState()
    .tabs.find((t) => t.id === useWorkspace.getState().activeTabId && t.kind === CONSOLE_KIND);
  if (!tab) return;
  await getRuntime(tab.id, (tab.state as ConsoleState).connectionId).cancel();
}

const activeIsBusy = () => {
  const { tabs, activeTabId } = useWorkspace.getState();
  const tab = tabs.find((t) => t.id === activeTabId && t.kind === CONSOLE_KIND);
  return !!tab && getRuntime(tab.id, (tab.state as ConsoleState).connectionId).busy;
};

/** Format the selection, or the whole script when nothing is selected. */
export function formatActiveEditor(): void {
  const active = activeConsole();
  if (!active) return;
  const { tab, view } = active;
  const driver = useConnections
    .getState()
    .file.connections.find((c) => c.id === tab.state.connectionId)?.driver;
  const sel = view.state.selection.main;
  const from = sel.empty ? 0 : sel.from;
  const to = sel.empty ? view.state.doc.length : sel.to;
  try {
    const formatted = formatSql(view.state.sliceDoc(from, to), driver ?? "");
    view.dispatch({ changes: { from, to, insert: formatted } });
  } catch (e) {
    useNoticesStore.push(`Couldn't format: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Commands owned by the SQL console. Returns a disposer. */
export function registerConsoleCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "console.new",
      title: "New console",
      category: "Console",
      shortcut: "Mod+T",
      run: async (arg) => {
        const a = (arg && typeof arg === "object" ? arg : {}) as NewConsoleArgs;
        await openConsole(a);
      },
    }),
    registerCommand({
      id: "console.run",
      title: "Run statement",
      category: "Console",
      run: () => runActive("current"),
    }),
    registerCommand({
      id: "console.runScript",
      title: "Run script",
      category: "Console",
      run: () => runActive("script"),
    }),
    registerCommand({
      id: "console.explain",
      title: "Explain plan",
      category: "Console",
      run: () => explainActive(false),
    }),
    registerCommand({
      id: "console.explainAnalyze",
      title: "Explain Analyze",
      category: "Console",
      run: () => explainActive(true),
    }),
    registerShortcut({
      id: "console.explain",
      keys: "Mod+Shift+E",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        void explainActive(false);
      },
    }),
    registerCommand({
      id: "console.rerun",
      title: "Re-run last query",
      category: "Console",
      run: () => rerunActive(),
    }),
    registerCommand({
      id: "console.cancel",
      title: "Cancel running query",
      category: "Console",
      run: () => cancelActive(),
    }),
    registerShortcut({
      id: "console.run",
      keys: "Mod+Enter",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        void runActive("current");
      },
    }),
    registerShortcut({
      id: "console.runScript",
      keys: "Mod+Shift+Enter",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        void runActive("script");
      },
    }),
    registerShortcut({
      id: "console.cancel",
      keys: "Mod+.",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        void cancelActive();
      },
    }),
    registerShortcut({
      id: "console.cancel.escape",
      keys: "Escape",
      scope: "editor",
      when: activeIsBusy,
      run: (e) => {
        e.preventDefault();
        void cancelActive();
      },
    }),
    registerSlotItem("toolbarCenter", {
      id: "console.toolbar",
      order: 10,
      render: () => <ConsoleToolbar />,
    }),
    registerCommand({
      id: "console.format",
      title: "Format SQL",
      category: "Console",
      run: () => formatActiveEditor(),
    }),
    registerShortcut({
      id: "console.format",
      keys: "Mod+Shift+F",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        formatActiveEditor();
      },
    }),
  ];
  return () => disposers.forEach((d) => d());
}
