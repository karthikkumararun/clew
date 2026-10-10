import type { Tab } from "../../shell/registry/tabKinds";

export type TxMode = "auto" | "manual";

/** What a console tab keeps (and what survives a restart). */
export interface ConsoleState {
  connectionId: string;
  database?: string;
  schema?: string;
  /** The editor's text. Restored after a restart even when never saved. */
  text: string;
  /** Set when the console is bound to a `.sql` file. */
  filePath?: string;
  /** Text as last read from / written to `filePath`; the tab is dirty when `text` differs. */
  savedText?: string;
  txMode: TxMode;
  /** Height in px of the results panel (the splitter position). */
  resultsHeight?: number;
  /** The tab's open session; transient (the connection chip switches database / schema on it). */
  sessionId?: string;
}

export type ConsoleTab = Tab<ConsoleState>;

export const CONSOLE_KIND = "console";

let counter = 0;

/** A fresh, unique key: every Mod+T opens a new console. */
export const newConsoleKey = () => `console:${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const fileKey = (path: string) => `file:${path}`;

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isConsoleDirty(s: ConsoleState): boolean {
  return s.filePath !== undefined && s.text !== s.savedText;
}

export function serializeConsole(s: ConsoleState): ConsoleState {
  const { sessionId: _session, ...persisted } = s;
  void _session;
  return persisted;
}

/** Accept what an older or damaged session saved; unknown fields are dropped. */
export function deserializeConsole(raw: unknown): ConsoleState {
  const r = (raw ?? {}) as Partial<ConsoleState>;
  if (typeof r.connectionId !== "string") throw new Error("a console needs a connection");
  return {
    connectionId: r.connectionId,
    database: typeof r.database === "string" ? r.database : undefined,
    schema: typeof r.schema === "string" ? r.schema : undefined,
    text: typeof r.text === "string" ? r.text : "",
    filePath: typeof r.filePath === "string" ? r.filePath : undefined,
    savedText: typeof r.savedText === "string" ? r.savedText : undefined,
    txMode: r.txMode === "manual" ? "manual" : "auto",
    resultsHeight: typeof r.resultsHeight === "number" ? r.resultsHeight : undefined,
  };
}
