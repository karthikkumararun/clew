import type { Environment as BadgeEnv } from "../../components/Badge";
import { BADGE_ENV } from "../../connections/display";
import type { Connection } from "../../connections/api";
import { baseName } from "../console/state";
import type { ActionEntry } from "./actions";
import type { HistoryEntry, PaletteHit } from "./api";
import { fuzzyMatch } from "./fuzzy";
import type { RecentFile } from "./recentFiles";

export type ItemIcon = "table" | "column" | "field" | "graph" | "history" | "file" | "action";

export interface PaletteItem {
  id: string;
  group: "objects" | "queries" | "actions";
  icon: ItemIcon;
  label: string;
  /** Matched characters of `label`, for the accent highlight. */
  indices: number[];
  /** Code-like text (identifiers, SQL) is set in the mono face. */
  mono: boolean;
  connection?: { name: string; env: BadgeEnv };
  /** Next to the connection: `analytics.public`. */
  detail?: string;
  /** Right-aligned text: `field`, `12 min ago`, `saved`. */
  meta?: string;
  shortcut?: string;
  /** Shown on the highlighted row only, e.g. `↵ open data · ⌥↵ console`. */
  hint?: string;
  run: () => void | Promise<void>;
  /** Alt+Enter; objects only. */
  alt?: () => void | Promise<void>;
}

export interface QuerySources {
  recent: HistoryEntry[];
  scripts: { connectionId: string; name: string; path: string }[];
  files: RecentFile[];
}

const byId = (connections: Connection[]) => new Map(connections.map((c) => [c.id, c]));

export function connectionTag(c: Connection | undefined) {
  return c ? { name: c.name, env: BADGE_ENV[c.environment] } : undefined;
}

const OBJECT_ICON: Record<string, ItemIcon> = {
  column: "column",
  field: "field",
  label: "graph",
  relationship_type: "graph",
};

const KIND_META: Record<string, string> = {
  column: "column",
  field: "field",
  label: "node label",
  relationship_type: "relationship type",
  view: "view",
  materialized_view: "materialized view",
  key_prefix: "key prefix",
};

export function objectItems(
  hits: PaletteHit[],
  connections: Connection[],
  open: (hit: PaletteHit, mode: "open" | "console") => void | Promise<void>,
): PaletteItem[] {
  const conns = byId(connections);
  return hits.flatMap((hit): PaletteItem[] => {
    const conn = conns.get(hit.entry.connectionId);
    if (!conn) return []; // its connection was deleted
    const { entry } = hit;
    return [
      {
        id: `object:${entry.connectionId}:${entry.database}:${entry.kind}:${entry.parentLabel}:${entry.name}`,
        group: "objects",
        icon: OBJECT_ICON[entry.kind] ?? "table",
        label: entry.name,
        indices: hit.indices,
        mono: true,
        connection: connectionTag(conn),
        detail: entry.parentLabel,
        meta: KIND_META[entry.kind],
        hint: "↵ open data · ⌥↵ console",
        run: () => open(hit, "open"),
        alt: () => open(hit, "console"),
      },
    ];
  });
}

/** `12 min ago`, `3 h ago`, `yesterday`. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

type Scored = { item: PaletteItem; score: number; at: number };

/** Saved scripts, recent files and recent statements that match, best first. */
export function queryItems(
  query: string,
  sources: QuerySources,
  connections: Connection[],
  actions: {
    openConsole: (connectionId: string, database: string, sql: string) => void | Promise<void>;
    openFile: (connectionId: string, path: string) => void | Promise<void>;
  },
  opts: { recentOnly?: boolean; limit: number; now?: number },
): PaletteItem[] {
  const conns = byId(connections);
  const scored: Scored[] = [];
  const seen = new Set<string>();
  const push = (item: PaletteItem, text: string, at: number) => {
    const m = fuzzyMatch(query, text);
    if (m) scored.push({ item: { ...item, indices: m.indices }, score: m.score, at });
  };

  for (const f of sources.files) {
    const conn = conns.get(f.connectionId);
    if (!conn || seen.has(f.path)) continue;
    seen.add(f.path);
    push(
      {
        id: `file:${f.path}`,
        group: "queries",
        icon: "file",
        label: baseName(f.path),
        indices: [],
        mono: false,
        connection: connectionTag(conn),
        meta: ago(f.openedAt, opts.now),
        run: () => actions.openFile(f.connectionId, f.path),
      },
      baseName(f.path),
      f.openedAt,
    );
  }
  for (const s of sources.scripts) {
    const conn = conns.get(s.connectionId);
    if (!conn || seen.has(s.path)) continue;
    seen.add(s.path);
    push(
      {
        id: `script:${s.path}`,
        group: "queries",
        icon: "file",
        label: s.name,
        indices: [],
        mono: false,
        connection: connectionTag(conn),
        meta: "saved",
        run: () => actions.openFile(s.connectionId, s.path),
      },
      s.name,
      0,
    );
  }
  if (!opts.recentOnly) {
    for (const h of sources.recent) {
      const conn = conns.get(h.connectionId);
      const text = oneLine(h.sql);
      if (!conn || !text) continue;
      push(
        {
          id: `query:${h.id}`,
          group: "queries",
          icon: "history",
          label: text.slice(0, 300),
          indices: [],
          mono: true,
          connection: connectionTag(conn),
          meta: ago(h.startedAt, opts.now),
          run: () => actions.openConsole(h.connectionId, h.database, h.sql),
        },
        text.slice(0, 300),
        h.startedAt,
      );
    }
  }
  // Best match first; with no query (or equal scores) the newest first.
  scored.sort((a, b) => b.score - a.score || b.at - a.at);
  return scored.slice(0, opts.limit).map((s) => s.item);
}

export function actionItems(query: string, entries: ActionEntry[], limit: number): PaletteItem[] {
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const a of entries) {
    const m = fuzzyMatch(query, a.title);
    if (!m) continue;
    scored.push({
      score: m.score,
      item: {
        id: `action:${a.id}`,
        group: "actions",
        icon: "action",
        label: a.title,
        indices: m.indices,
        mono: false,
        shortcut: a.shortcut,
        run: a.run,
      },
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
