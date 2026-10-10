import { useWorkspace } from "../../stores/workspaceStore";
import { useNotices } from "../../stores/noticesStore";
import { pickConnection } from "./ConnectionPicker";
import { connectionInContext } from "./context";
import { fileOpenDialog, fileRead, fileSaveDialog, fileWrite } from "./fileIpc";
import type { OpenedFile } from "./fileIpc";
import { CONSOLE_KIND, baseName, fileKey } from "./state";
import type { ConsoleState } from "./state";

const say = (m: string) => useNotices.getState().push(m);
const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e);

function consoleTab(tabId: string) {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId && t.kind === CONSOLE_KIND);
  return tab ? { tab, state: tab.state as ConsoleState } : null;
}

/** Open a file in a console bound to it, or focus the console that already has it. */
export function openFileTab(file: OpenedFile, connectionId: string): string {
  const key = fileKey(file.path);
  const existing = useWorkspace
    .getState()
    .tabs.find((t) => t.kind === CONSOLE_KIND && t.key === key);
  if (existing) {
    useWorkspace.getState().activateTab(existing.id);
    return existing.id;
  }
  const state: ConsoleState = {
    connectionId,
    text: file.text,
    filePath: file.path,
    savedText: file.text,
    txMode: "auto",
  };
  return useWorkspace.getState().openTab({ kind: CONSOLE_KIND, key, state });
}

/** Mod+O: choose a `.sql` file and open it in a console (asking which connection if unclear). */
export async function openFileFromDialog(): Promise<string | null> {
  let file: OpenedFile | null;
  try {
    file = await fileOpenDialog();
  } catch (e) {
    say(`Couldn't open the file: ${messageOf(e)}`);
    return null;
  }
  if (!file) return null;
  const known = useWorkspace.getState().tabs.find((t) => t.key === fileKey(file.path));
  const connectionId = known
    ? (known.state as ConsoleState).connectionId
    : (connectionInContext() ?? (await pickConnection()));
  if (!connectionId) return null;
  return openFileTab(file, connectionId);
}

/** `script.open`: a file from a Scripts folder, in a console bound to its connection. */
export async function openScript(connectionId: string, path: string): Promise<string | null> {
  try {
    return openFileTab(await fileRead(path), connectionId);
  } catch (e) {
    say(`Couldn't open ${baseName(path)}: ${messageOf(e)}`);
    return null;
  }
}

/** Save As: choose a file (starting in the connection's Scripts folder) and bind the console to it. */
export async function saveConsoleAs(tabId: string): Promise<boolean> {
  const c = consoleTab(tabId);
  if (!c) return false;
  const text = c.state.text;
  try {
    const path = await fileSaveDialog(
      c.state.connectionId,
      c.state.filePath ? baseName(c.state.filePath) : "script.sql",
      text,
    );
    if (!path) return false;
    useWorkspace
      .getState()
      .updateTabState<Partial<ConsoleState>>(tabId, { filePath: path, savedText: text });
    return true;
  } catch (e) {
    say(`Couldn't save: ${messageOf(e)}`);
    return false;
  }
}

/** Save: write to the console's file, or ask for one when it has none yet. */
export async function saveConsole(tabId: string): Promise<boolean> {
  const c = consoleTab(tabId);
  if (!c) return false;
  if (!c.state.filePath) return saveConsoleAs(tabId);
  const text = c.state.text;
  try {
    await fileWrite(c.state.filePath, text);
    useWorkspace.getState().updateTabState<Partial<ConsoleState>>(tabId, { savedText: text });
    return true;
  } catch (e) {
    say(`Couldn't save ${baseName(c.state.filePath)}: ${messageOf(e)}`);
    return false;
  }
}
