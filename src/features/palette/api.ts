import { invoke } from "../../lib/ipc";
import type { HistoryEntry } from "../../lib/ipc/generated/HistoryEntry";
import type { PaletteHit } from "../../lib/ipc/generated/PaletteHit";
import type { PaletteStats } from "../../lib/ipc/generated/PaletteStats";
import type { Scope } from "../../lib/ipc/generated/Scope";

export type { HistoryEntry, PaletteHit, PaletteStats, Scope };

/** Fuzzy-search the object index (at most 50 hits, best first). */
export const paletteSearch = (query: string, scope: Scope) =>
  invoke<PaletteHit[]>("palette_search", { query, scope });

export const paletteStats = () => invoke<PaletteStats>("palette_stats");

/** The newest successful statements across connections. */
export const paletteRecentQueries = (limit = 200) =>
  invoke<HistoryEntry[]>("palette_recent_queries", { limit });

export const paletteClear = () => invoke<void>("palette_clear");
