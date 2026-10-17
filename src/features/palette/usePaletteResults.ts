import { useEffect, useMemo, useRef, useState } from "react";
import { useConnections } from "../../connections/connectionsStore";
import { runCommand } from "../../shell/registry/commands";
import { scriptsList } from "../explorer/api";
import { allActions } from "./actions";
import { paletteRecentQueries, paletteSearch, paletteStats } from "./api";
import type { PaletteHit, PaletteStats } from "./api";
import { actionItems, objectItems, queryItems } from "./items";
import type { PaletteItem, QuerySources } from "./items";
import { openHit } from "./openObject";
import { readRecentFiles } from "./recentFiles";
import type { PaletteScope } from "./paletteStore";

export interface ResultGroup {
  id: PaletteItem["group"];
  label: string;
  items: PaletteItem[];
}

/** Rows per section on the All tab; a single-section tab shows up to 50. */
const ALL_LIMITS = { objects: 8, queries: 5, actions: 6 };
const FULL_LIMIT = 50;

const EMPTY_SOURCES: QuerySources = { recent: [], scripts: [], files: [] };

/** Saved scripts of every connection, recent files and recent statements, read when the palette opens. */
async function loadSources(): Promise<QuerySources> {
  const connections = useConnections.getState().file.connections;
  const [recent, scripts] = await Promise.all([
    paletteRecentQueries().catch(() => []),
    Promise.all(
      connections.map((c) =>
        scriptsList(c.id)
          .then((files) => files.map((f) => ({ connectionId: c.id, name: f.name, path: f.path })))
          .catch(() => []),
      ),
    ),
  ]);
  return { recent, scripts: scripts.flat(), files: readRecentFiles() };
}

const openFile = (connectionId: string, path: string) =>
  void runCommand("script.open", { connectionId, path });
const openConsole = (connectionId: string, database: string, sql: string) =>
  void runCommand("console.new", { connectionId, database: database || undefined, sql });

/**
 * What the palette shows for a query: object hits from Rust (the latest request wins), plus
 * queries and actions scored here (spec: command-palette › Fuzzy search).
 */
export function usePaletteResults(
  query: string,
  scope: PaletteScope,
  preset: "recent" | null,
  refreshKey: number,
) {
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [sources, setSources] = useState<QuerySources>(EMPTY_SOURCES);
  const [stats, setStats] = useState<PaletteStats>({ connections: 0, objects: 0 });
  const [searched, setSearched] = useState(false);
  const seq = useRef(0);
  const connections = useConnections((s) => s.file.connections);

  useEffect(() => {
    let live = true;
    void loadSources().then((s) => live && setSources(s));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const wantsObjects = !preset && (scope === "all" || scope === "objects");
  useEffect(() => {
    const mine = ++seq.current;
    void paletteStats()
      .then((s) => mine === seq.current && setStats(s))
      .catch(() => {});
    if (!wantsObjects) {
      setHits([]);
      setSearched(true);
      return;
    }
    void paletteSearch(query, "all")
      .then((h) => {
        if (mine !== seq.current) return;
        setHits(h);
        setSearched(true);
      })
      .catch(() => mine === seq.current && (setHits([]), setSearched(true)));
  }, [query, wantsObjects, refreshKey]);

  const groups = useMemo<ResultGroup[]>(() => {
    const full = scope !== "all";
    const limit = (k: keyof typeof ALL_LIMITS) => (full ? FULL_LIMIT : ALL_LIMITS[k]);
    const out: ResultGroup[] = [];
    if (preset === "recent") {
      const items = queryItems(
        query,
        sources,
        connections,
        { openConsole, openFile },
        {
          recentOnly: true,
          limit: FULL_LIMIT,
        },
      );
      return items.length ? [{ id: "queries", label: "RECENT FILES & SAVED QUERIES", items }] : [];
    }
    if (scope === "all" || scope === "objects") {
      const items = objectItems(hits, connections, openHit).slice(0, limit("objects"));
      if (items.length) out.push({ id: "objects", label: "TABLES & COLLECTIONS", items });
    }
    if (scope === "all" || scope === "queries") {
      const items = queryItems(
        query,
        sources,
        connections,
        { openConsole, openFile },
        {
          limit: limit("queries"),
        },
      );
      if (items.length) out.push({ id: "queries", label: "SAVED & RECENT QUERIES", items });
    }
    if (scope === "all" || scope === "actions") {
      const items = actionItems(query, allActions(), limit("actions"));
      if (items.length) out.push({ id: "actions", label: "ACTIONS", items });
    }
    return out;
  }, [hits, sources, connections, query, scope, preset]);

  return { groups, stats, searched };
}
