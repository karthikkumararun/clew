export type Platform = "mac" | "windows";

function detect(): Platform {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const hint = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /Mac|iPhone|iPad/i.test(hint) ? "mac" : "windows";
}

let current: Platform | null = null;

export function getPlatform(): Platform {
  current ??= detect();
  return current;
}

/** Test helper: force a platform (or pass null to re-detect). */
export function setPlatformForTests(platform: Platform | null) {
  current = platform;
}

export const isMac = () => getPlatform() === "mac";
export const isWindows = () => getPlatform() === "windows";

const MAC_MODS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const MAC_KEYS: Record<string, string> = {
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Tab: "⇥",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const WIN_MODS: Record<string, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Mod: "Ctrl" };
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Mod"];
const WIN_ORDER = ["Mod", "Ctrl", "Shift", "Alt"];

export function parseKeys(keys: string): { mods: string[]; key: string } {
  const parts = keys.split("+");
  // "Mod++" style isn't supported; the key is always the last token.
  const key = parts[parts.length - 1];
  return { mods: parts.slice(0, -1), key };
}

/** Render a registry shortcut ("Mod+Shift+K") for the platform: ⇧⌘K on macOS, Ctrl+Shift+K on Windows. */
export function formatShortcut(keys: string, platform: Platform = getPlatform()): string {
  const { mods, key } = parseKeys(keys);
  if (platform === "mac") {
    const ordered = MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_MODS[m]);
    return [...ordered, MAC_KEYS[key] ?? key.toUpperCase()].join("");
  }
  const ordered = WIN_ORDER.filter((m) => mods.includes(m)).map((m) => WIN_MODS[m]);
  const dedup = ordered.filter((m, i) => ordered.indexOf(m) === i);
  const winKey = key.length === 1 ? key.toUpperCase() : key.replace("Arrow", "") || key;
  return [...dedup, winKey].join("+");
}
