import { getPlatform, parseKeys } from "../../lib/platform";
import type { Platform } from "../../lib/platform";

export type ShortcutScope = "global" | "editor" | "documents" | "grid" | "dialog";

export interface ShortcutBinding {
  id: string;
  /** e.g. "Mod+Shift+K". Mod = Cmd on macOS, Ctrl on Windows. */
  keys: string;
  scope: ShortcutScope;
  when?: () => boolean;
  /** Global bindings are suppressed while a modal dialog is open unless this is set. */
  allowInDialog?: boolean;
  run: (event: KeyboardEvent) => void;
}

const SCOPE_PRIORITY: ShortcutScope[] = ["dialog", "editor", "documents", "grid", "global"];

const bindings = new Map<string, ShortcutBinding>(); // key: `${scope}|${canonical keys}`
const listeners = new Set<() => void>();

const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
};

/** Canonical form: modifiers in fixed order, key upper-cased. Mod stays symbolic. */
export function canonicalKeys(keys: string): string {
  const { mods, key } = parseKeys(keys);
  const order = ["Mod", "Ctrl", "Alt", "Shift"];
  const m = order.filter((x) => mods.includes(x));
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...m, k].join("+");
}

function eventKey(e: KeyboardEvent): string {
  const code = e.code ?? "";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (e.key === " ") return "Space";
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** Canonical combo for a keyboard event, resolving Mod for the platform. */
export function eventCombo(e: KeyboardEvent, platform: Platform = getPlatform()): string {
  const mac = platform === "mac";
  const mod = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac ? e.ctrlKey : false; // on Windows Ctrl *is* Mod
  const mods: string[] = [];
  if (mod) mods.push("Mod");
  if (ctrl) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, eventKey(e)].join("+");
}

function notify() {
  listeners.forEach((l) => l());
}

export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Register a binding. A second registration with the same keys in the same scope is rejected
 * (returns a no-op disposer and logs an error in development builds).
 */
export function registerShortcut(binding: ShortcutBinding): () => void {
  const key = `${binding.scope}|${canonicalKeys(binding.keys)}`;
  const existing = bindings.get(key);
  if (existing && existing.id !== binding.id) {
    if (import.meta.env.DEV) {
      console.error(
        `Shortcut conflict: "${binding.keys}" in scope "${binding.scope}" is already bound to "${existing.id}"; rejected "${binding.id}".`,
      );
    }
    return () => {};
  }
  bindings.set(key, binding);
  notify();
  return () => {
    if (bindings.get(key) === binding) {
      bindings.delete(key);
      notify();
    }
  };
}

export function listShortcuts(): ShortcutBinding[] {
  return [...bindings.values()];
}

export function findShortcut(id: string): ShortcutBinding | undefined {
  return [...bindings.values()].find((b) => b.id === id);
}

function activeScopes(target: EventTarget | null, forced?: ShortcutScope): Set<ShortcutScope> {
  const scopes = new Set<ShortcutScope>(["global"]);
  if (forced) scopes.add(forced);
  if (target instanceof Element) {
    const holder = target.closest("[data-shortcut-scope]");
    const attr = holder?.getAttribute("data-shortcut-scope");
    if (attr) attr.split(/\s+/).forEach((s) => scopes.add(s as ShortcutScope));
    if (target.closest("[role='dialog']")) scopes.add("dialog");
  }
  return scopes;
}

/**
 * Run the best matching binding for the event. Priority: dialog > editor > documents > grid > global.
 * Returns true when a binding handled the event (and it has been preventDefault-ed).
 */
export function dispatchShortcut(e: KeyboardEvent, forcedScope?: ShortcutScope): boolean {
  if (e.defaultPrevented) return false;
  const combo = eventCombo(e);
  const scopes = activeScopes(e.target, forcedScope);
  const modalOpen = !!document.querySelector("[data-dialog-root]");
  for (const scope of SCOPE_PRIORITY) {
    if (!scopes.has(scope)) continue;
    const b = bindings.get(`${scope}|${combo}`);
    if (!b) continue;
    if (scope === "global" && modalOpen && !b.allowInDialog) continue;
    if (b.when && !b.when()) continue;
    e.preventDefault();
    b.run(e);
    return true;
  }
  return false;
}

/** Called from CodeMirror keymaps so the editor wins inside the editor. */
export function runEditorShortcut(e: KeyboardEvent): boolean {
  return dispatchShortcut(e, "editor");
}

/** Install the single window keydown listener. Returns a disposer. */
export function installShortcutListener(target: Window = window): () => void {
  const handler = (e: KeyboardEvent) => {
    dispatchShortcut(e);
  };
  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}

/** Test helper. */
export function clearShortcuts() {
  bindings.clear();
  notify();
}
