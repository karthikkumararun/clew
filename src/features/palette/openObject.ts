import { useConnections } from "../../connections/connectionsStore";
import type { Connection } from "../../connections/api";
import { runCommand } from "../../shell/registry/commands";
import { useNotices } from "../../stores/noticesStore";
import { namespaceOf, qualifiedName } from "../explorer/names";
import { labelQuery, relTypeQuery } from "../graph/cypherText";
import type { PaletteHit } from "./api";

export type OpenMode = "open" | "console";

const connectionOf = (id: string): Connection | undefined =>
  useConnections.getState().file.connections.find((c) => c.id === id);

/**
 * Make sure a connection is up before something is opened on it: a connection that isn't
 * connected is connected first (the store asks for a missing password) and the open is dropped
 * when that fails or is cancelled (spec: command-palette › Object index › Disconnected connection).
 */
export async function ensureConnected(connectionId: string): Promise<boolean> {
  if (useConnections.getState().connected[connectionId]) return true;
  return useConnections.getState().connect(connectionId);
}

/** The text a console starts with for an object (spec: command-palette › Result actions). */
export function starterText(hit: PaletteHit, driver: string): string {
  const { entry } = hit;
  const table = entry.path[entry.path.length - 1]?.name ?? entry.name;
  switch (entry.kind) {
    case "collection":
    case "field":
      return `db.${table}.find({})`;
    case "label":
      return labelQuery(entry.name);
    case "relationship_type":
      return relTypeQuery(entry.name);
    case "key_prefix":
      return `SCAN 0 MATCH ${entry.name}* COUNT 100`;
    default:
      return `SELECT * FROM ${qualifiedName(driver, entry.path)} LIMIT 100;`;
  }
}

/** Enter opens the object; Alt+Enter opens a console holding a starter query (not run). */
export async function openHit(hit: PaletteHit, mode: OpenMode): Promise<void> {
  const { entry } = hit;
  const conn = connectionOf(entry.connectionId);
  if (!conn) {
    useNotices.getState().push("That connection no longer exists");
    return;
  }
  if (!(await ensureConnected(conn.id))) return;
  const ns = namespaceOf(entry.path);
  const database = ns.database ?? (entry.database || undefined);

  if (mode === "console") {
    await runCommand("console.new", {
      connectionId: conn.id,
      database,
      schema: ns.schema,
      sql: starterText(hit, conn.driver),
    });
    return;
  }
  switch (entry.kind) {
    case "collection":
    case "field":
      await runCommand("collection.open", {
        connectionId: conn.id,
        database,
        collection: entry.path[entry.path.length - 1]?.name ?? entry.name,
      });
      return;
    case "label":
    case "relationship_type":
      await runCommand("graph.open", {
        connectionId: conn.id,
        database,
        cypher: starterText(hit, conn.driver),
        run: true,
      });
      return;
    case "key_prefix":
      await runCommand("keys.open", { connectionId: conn.id, db: 0 });
      return;
    case "column":
      await runCommand("table.filterByColumn", {
        connectionId: conn.id,
        path: entry.path,
        column: entry.name.slice(entry.name.indexOf(".") + 1),
      });
      return;
    default:
      await runCommand("table.open", { connectionId: conn.id, path: entry.path });
  }
}
