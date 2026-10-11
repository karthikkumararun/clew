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
import { connectionInContext } from "./context";
import { openFileFromDialog, openScript, saveConsole, saveConsoleAs } from "./fileOps";
import { registerConsoleStatusItems } from "./statusItems";
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

/** Open a console tab (always a new one). Returns its tab id, or null if nothing was chosen. */
export async function openConsole(args: NewConsoleArgs = {}): Promise<string | null> {
  const connectionId = args.connectionId ?? connectionInContext() ?? (await pickConnection());
  if (!connectionId) return null;
  // "Manual commit" connections start every console in Manual transaction mode.
  const manual = useConnections.getState().file.connections.find((c) => c.id === connectionId)
    ?.safeguards.manualCommit;
  const state: ConsoleState = {
    connectionId,
    database: args.database,
    schema: args.schema,
    text: args.sql ?? "",
    txMode: manual ? "manual" : "auto",
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

/** The active tab when it is a console (its editor need not be on screen). */
export function activeConsoleTab(): Tab<ConsoleState> | null {
  const { tabs, activeTabId } = useWorkspace.getState();
  const tab = tabs.find((t) => t.id === activeTabId && t.kind === CONSOLE_KIND);
  return tab ? (tab as Tab<ConsoleState>) : null;
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
    if (getRuntime(what.tab.id, what.tab.state.connectionId).store.getState().readOnly) {
      useNoticesStore.push("Explain Analyze would execute a write, and this session is read-only");
      return;
    }
    // On a connection that confirms writes the guard asks next; once is enough.
    const answer = connection?.safeguards.confirmWrites
      ? "run"
      : await askChoice({
          title: "Explain Analyze runs the statement",
          body: (
            <p>
              ANALYZE executes the statement to measure it. It runs inside a transaction that is
              rolled back afterwards, but triggers and sequences may still have side effects.
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

/** Commit or roll back the active console's manual transaction. */
export async function endActiveTransaction(commit: boolean): Promise<void> {
  const active = activeConsole();
  const tab =
    active?.tab ??
    useWorkspace
      .getState()
      .tabs.find((t) => t.id === useWorkspace.getState().activeTabId && t.kind === CONSOLE_KIND);
  if (!tab) return;
  await getRuntime(tab.id, (tab.state as ConsoleState).connectionId).endTransaction(commit);
}

/** Switch a console between Auto-commit and Manual; leaving Manual settles the open transaction. */
export async function setTxMode(tabId: string, mode: "auto" | "manual"): Promise<boolean> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const state = tab.state as ConsoleState;
  if (state.txMode === mode) return true;
  const runtime = getRuntime(tab.id, state.connectionId);
  if (mode === "auto" && runtime.store.getState().txOpen) {
    const answer = await askChoice({
      title: "Uncommitted transaction",
      body: (
        <p>
          Switching to Auto-commit ends the open transaction. Commit its changes or roll them back?
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "rollback", label: "Roll back" },
        { id: "commit", label: "Commit", variant: "primary" },
      ],
    });
    if (answer !== "commit" && answer !== "rollback") return false;
    if (!(await runtime.endTransaction(answer === "commit"))) return false;
  }
  useWorkspace.getState().updateTabState<Partial<ConsoleState>>(tabId, { txMode: mode });
  return true;
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
      id: "console.commit",
      title: "Commit transaction",
      category: "Console",
      run: () => endActiveTransaction(true),
    }),
    registerCommand({
      id: "console.rollback",
      title: "Roll back transaction",
      category: "Console",
      run: () => endActiveTransaction(false),
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
      id: "console.openFile",
      title: "Open SQL file",
      category: "Console",
      run: async () => void (await openFileFromDialog()),
    }),
    registerCommand({
      id: "console.save",
      title: "Save SQL file",
      category: "Console",
      run: async () => {
        const tab = activeConsoleTab();
        if (tab) await saveConsole(tab.id);
      },
    }),
    registerCommand({
      id: "console.saveAs",
      title: "Save SQL file as…",
      category: "Console",
      run: async () => {
        const tab = activeConsoleTab();
        if (tab) await saveConsoleAs(tab.id);
      },
    }),
    registerCommand({
      id: "script.open",
      title: "Open script",
      category: "Console",
      run: async (arg) => {
        const a = (arg ?? {}) as { connectionId?: string; path?: string };
        if (a.connectionId && a.path) await openScript(a.connectionId, a.path);
      },
    }),
    // Mod+O / Mod+S in an editor are about SQL files; elsewhere Mod+O still opens a database file.
    registerShortcut({
      id: "console.openFile",
      keys: "Mod+O",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        void openFileFromDialog();
      },
    }),
    registerShortcut({
      id: "console.save",
      keys: "Mod+S",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        const tab = activeConsoleTab();
        if (tab) void saveConsole(tab.id);
      },
    }),
    registerShortcut({
      id: "console.saveAs",
      keys: "Mod+Shift+S",
      scope: "editor",
      run: (e) => {
        e.preventDefault();
        const tab = activeConsoleTab();
        if (tab) void saveConsoleAs(tab.id);
      },
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
  const offStatus = registerConsoleStatusItems();
  return () => {
    offStatus();
    disposers.forEach((d) => d());
  };
}
