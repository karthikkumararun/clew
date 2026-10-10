/**
 * Small synchronous key/value store for UI state (pane sizes, open flags, ...).
 * Reads are served from an in-memory cache; writes go through to a pluggable backend.
 * The Tauri backend (`ui_state` table in clew.db) is installed in lib/ipc.ts at boot;
 * until then (and in tests) localStorage is used when available.
 */
export interface UiStateBackend {
  load(): Promise<Record<string, string>>;
  save(key: string, value: string): void;
}

const cache = new Map<string, string>();

const localBackend: UiStateBackend = {
  async load() {
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith("clew:")) out[k.slice(5)] = localStorage.getItem(k) ?? "";
      }
    } catch {
      /* storage unavailable */
    }
    return out;
  },
  save(key, value) {
    try {
      localStorage.setItem(`clew:${key}`, value);
    } catch {
      /* storage unavailable */
    }
  },
};

let backend: UiStateBackend = localBackend;

export function setUiStateBackend(next: UiStateBackend) {
  backend = next;
}

export async function hydrateUiState(): Promise<void> {
  const loaded = await backend.load();
  for (const [k, v] of Object.entries(loaded)) cache.set(k, v);
}

export function getUiState(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  // Fall back to the local backend synchronously so early reads (before hydrate) work.
  if (backend === localBackend) {
    try {
      return localStorage.getItem(`clew:${key}`);
    } catch {
      return null;
    }
  }
  return null;
}

export function setUiState(key: string, value: string): void {
  cache.set(key, value);
  backend.save(key, value);
}

export function getUiNumber(key: string, fallback: number): number {
  const raw = getUiState(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getUiBool(key: string, fallback: boolean): boolean {
  const raw = getUiState(key);
  return raw === null ? fallback : raw === "true";
}

/** Test helper. */
export function resetUiState() {
  cache.clear();
  backend = localBackend;
  try {
    for (const k of Object.keys(localStorage))
      if (k.startsWith("clew:")) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
