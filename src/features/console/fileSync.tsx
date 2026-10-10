import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { fileRead, fileUnwatch, fileWatch, onFileChanged } from "./fileIpc";
import { askChoice } from "./prompts";
import { CONSOLE_KIND, baseName } from "./state";
import type { ConsoleState } from "./state";

const DEBOUNCE_MS = 150;

const consoleFor = (path: string) =>
  useWorkspace
    .getState()
    .tabs.find((t) => t.kind === CONSOLE_KIND && (t.state as ConsoleState).filePath === path);

const asking = new Set<string>();

/**
 * A watched file changed on disk. A console with no unsaved edits reloads it; one with edits asks
 * which version to keep. Changes that match what the tab already holds (its own save) are ignored.
 */
export async function handleExternalChange(path: string): Promise<void> {
  const tab = consoleFor(path);
  if (!tab || asking.has(tab.id)) return;
  const name = baseName(path);
  let disk;
  try {
    disk = await fileRead(path);
  } catch (e) {
    if ((e as { code?: string }).code === "not_found") {
      useNotices.getState().push(`${name} was deleted on disk`);
    }
    return;
  }
  const cur = consoleFor(path);
  if (!cur) return;
  const s = cur.state as ConsoleState;
  const update = (patch: Partial<ConsoleState>) =>
    useWorkspace.getState().updateTabState<Partial<ConsoleState>>(cur.id, patch);

  if (disk.text === s.savedText) return; // our own save, or nothing really changed
  if (disk.text === s.text) {
    update({ savedText: disk.text }); // the edits happen to match the new file
    return;
  }
  if (s.text === s.savedText) {
    update({ text: disk.text, savedText: disk.text });
    useNotices.getState().push(`Reloaded ${name} from disk`);
    return;
  }
  asking.add(cur.id);
  try {
    const answer = await askChoice({
      title: "File changed on disk",
      body: (
        <p>
          <strong>{name}</strong> was changed outside Clew, and this console has unsaved edits. Keep
          your version or load the one on disk?
        </p>
      ),
      choices: [
        { id: "keep", label: "Keep my version" },
        { id: "disk", label: "Load from disk", variant: "primary" },
      ],
    });
    if (answer === "disk") update({ text: disk.text, savedText: disk.text });
    // Keeping: the disk version is now the baseline, so Save overwrites it knowingly.
    else update({ savedText: disk.text });
  } finally {
    asking.delete(cur.id);
  }
}

/**
 * Watch the files of open consoles and react when they change on disk. Returns a disposer.
 */
export function startFileSync(): () => void {
  const watched = new Set<string>();
  const sync = () => {
    const wanted = new Set<string>();
    for (const t of useWorkspace.getState().tabs) {
      const p = t.kind === CONSOLE_KIND ? (t.state as ConsoleState).filePath : undefined;
      if (p) wanted.add(p);
    }
    for (const p of wanted) {
      if (!watched.has(p)) {
        watched.add(p);
        void fileWatch(p).catch(() => watched.delete(p));
      }
    }
    for (const p of [...watched]) {
      if (!wanted.has(p)) {
        watched.delete(p);
        void fileUnwatch(p).catch(() => {});
      }
    }
  };
  sync();
  const unsubscribe = useWorkspace.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) sync();
  });

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopListening: () => void = () => {};
  let stopped = false;
  void onFileChanged((path) => {
    clearTimeout(timers.get(path));
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        void handleExternalChange(path);
      }, DEBOUNCE_MS),
    );
  }).then((off) => {
    if (stopped) off();
    else stopListening = off;
  });

  return () => {
    stopped = true;
    unsubscribe();
    stopListening();
    timers.forEach(clearTimeout);
    for (const p of watched) void fileUnwatch(p).catch(() => {});
    watched.clear();
  };
}
