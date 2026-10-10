import { formatShortcut } from "../../lib/platform";
import { registerShortcut } from "./shortcuts";

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Registry keys, e.g. "Mod+N". Bound in the global scope. */
  shortcut?: string;
  run: () => void | Promise<void>;
}

const commands = new Map<string, { command: Command; unbind: () => void }>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerCommand(command: Command): () => void {
  if (commands.has(command.id)) {
    if (import.meta.env.DEV) console.error(`Command "${command.id}" is already registered.`);
    return () => {};
  }
  const unbind = command.shortcut
    ? registerShortcut({
        id: `command:${command.id}`,
        keys: command.shortcut,
        scope: "global",
        run: () => void runCommand(command.id),
      })
    : () => {};
  const entry = { command, unbind };
  commands.set(command.id, entry);
  notify();
  return () => {
    if (commands.get(command.id) === entry) {
      entry.unbind();
      commands.delete(command.id);
      notify();
    }
  };
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id)?.command;
}

export function listCommands(): Command[] {
  return [...commands.values()].map((e) => e.command);
}

/** Run a command by id. Unknown ids are a no-op (later changes register them). */
export async function runCommand(id: string): Promise<boolean> {
  const c = commands.get(id)?.command;
  if (!c) return false;
  await c.run();
  return true;
}

export function commandShortcutLabel(id: string): string | undefined {
  const keys = commands.get(id)?.command.shortcut;
  return keys ? formatShortcut(keys) : undefined;
}

/** Test helper. */
export function clearCommands() {
  commands.forEach((e) => e.unbind());
  commands.clear();
  notify();
}
