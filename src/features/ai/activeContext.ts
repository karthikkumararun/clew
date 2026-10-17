import { useConnections } from "../../connections/connectionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { activeConsoleTab, sqlToRun } from "../console/commands";
import { connectionInContext } from "../console/context";
import { getView } from "../console/editor/views";
import { getRuntime } from "../console/runtime";
import { valueText } from "../console/valueFormat";
import type { RowsAttachment } from "./api";
import type { Attachment } from "./chatStore";

/** The connection the assistant talks about: the one in context, else the first one. */
export function assistantConnection(): string | null {
  return connectionInContext();
}

export interface ConsoleContext {
  tabId: string;
  tabName: string;
  connectionId: string;
  database: string;
  schema?: string;
  /** The whole editor text. */
  text: string;
  /** What is selected, or the statement at the cursor. */
  statement: string;
  selection: boolean;
  /** 1-based lines the statement covers. */
  lines: [number, number] | null;
}

/** The active console, when it belongs to `connectionId`. */
export function consoleContext(connectionId: string): ConsoleContext | null {
  const tab = activeConsoleTab();
  if (!tab || tab.state.connectionId !== connectionId) return null;
  const view = getView(tab.id);
  const text = view ? view.state.doc.toString() : tab.state.text;
  const sel = view?.state.selection.main;
  let statement = "";
  let selection = false;
  let lines: [number, number] | null = null;
  if (view && sel && !sel.empty) {
    statement = view.state.sliceDoc(sel.from, sel.to);
    selection = true;
    lines = [view.state.doc.lineAt(sel.from).number, view.state.doc.lineAt(sel.to).number];
  } else {
    const found = sqlToRun("current");
    if (found && found.tab.id === tab.id) {
      statement = found.sql;
      if (view) {
        lines = [
          view.state.doc.lineAt(found.offset).number,
          view.state.doc.lineAt(Math.min(found.offset + found.sql.length, view.state.doc.length))
            .number,
        ];
      }
    }
  }
  const connection = useConnections.getState().file.connections.find((c) => c.id === connectionId);
  const configured =
    connection && "database" in connection.settings && connection.settings.database
      ? String(connection.settings.database)
      : "";
  return {
    tabId: tab.id,
    tabName: tab.state.filePath
      ? (tab.state.filePath.split(/[\\/]/).pop() ?? "console")
      : `console · ${connection?.name ?? ""}`.trim(),
    connectionId,
    database: tab.state.database ?? configured,
    schema: tab.state.schema,
    text,
    statement,
    selection,
    lines,
  };
}

export const linesLabel = (lines: [number, number] | null) =>
  !lines
    ? "console"
    : lines[0] === lines[1]
      ? `console · line ${lines[0]}`
      : `console · lines ${lines[0]}–${lines[1]}`;

/** The database a request about `connectionId` concerns when no console says otherwise. */
export function defaultDatabase(connectionId: string): string {
  const c = useConnections.getState().file.connections.find((x) => x.id === connectionId);
  return c && "database" in c.settings && c.settings.database ? String(c.settings.database) : "";
}

export function serverVersionOf(connectionId: string): string | undefined {
  return useConnections.getState().connected[connectionId]?.server.version || undefined;
}

/** The latest error of the active console: its message and the statement that failed. */
export function lastError(connectionId: string): Attachment | null {
  const tab = activeConsoleTab();
  if (!tab || tab.state.connectionId !== connectionId) return null;
  const rt = getRuntime(tab.id, connectionId).store.getState();
  const entry = [...rt.output].reverse().find((e) => e.kind === "error");
  if (!entry) return null;
  const text = [entry.message, entry.hint ? `HINT: ${entry.hint}` : "", entry.detail ?? ""]
    .filter(Boolean)
    .join("\n");
  return { kind: "error", label: "error", text, statement: rt.lastRun?.sql };
}

/** Up to 20 rows of the result on screen, as the grid shows them. */
export function currentRows(connectionId: string): Attachment | null {
  const tab = activeConsoleTab();
  if (!tab || tab.state.connectionId !== connectionId) return null;
  const rt = getRuntime(tab.id, connectionId);
  const snap = rt.results.getSnapshot();
  const result =
    snap.results.find((r) => r.key === rt.store.getState().activeResult && r.columns.length > 0) ??
    snap.results.find((r) => r.columns.length > 0);
  if (!result || result.rows.length === 0) return null;
  const rows: RowsAttachment = {
    columns: result.columns.map((c) => c.name),
    rows: result.rows.slice(0, 20).map((r) => r.map((v) => valueText(v) ?? "NULL")),
  };
  return { kind: "rows", label: `${rows.rows.length} rows`, rows };
}

/** The EXPLAIN plan text of the active console, when one was produced there. */
export function explainPlanText(connectionId: string): string | null {
  const tab = activeConsoleTab();
  if (!tab || tab.state.connectionId !== connectionId) return null;
  const e = getRuntime(tab.id, connectionId).store.getState().explain;
  return e?.status === "done" && e.original ? e.original.text.slice(0, 6000) : null;
}

/** The tab that is showing, for "Edit mode without a console". */
export function activeTabId(): string | null {
  return useWorkspace.getState().activeTabId;
}
