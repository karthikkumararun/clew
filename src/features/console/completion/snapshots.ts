import { completionSnapshot } from "../../../lib/ipc/drivers";
import type { SchemaSnapshot } from "../../../lib/ipc/drivers";

/**
 * The completion snapshot of a connection's database, fetched once and kept until a statement
 * changes the schema. One request at a time per database; failures aren't cached.
 */
interface Entry {
  snapshot?: SchemaSnapshot;
  pending?: Promise<SchemaSnapshot>;
  /** Bumped by `invalidate`, so an answer that raced a DDL statement is discarded. */
  epoch: number;
}

const cache = new Map<string, Entry>();
const listeners = new Set<(connectionId: string) => void>();

const keyOf = (connectionId: string, database: string) => `${connectionId}\u0000${database}`;

export function peekSnapshot(connectionId: string, database: string): SchemaSnapshot | null {
  return cache.get(keyOf(connectionId, database))?.snapshot ?? null;
}

export function loadSnapshot(connectionId: string, database: string): Promise<SchemaSnapshot> {
  const key = keyOf(connectionId, database);
  let entry = cache.get(key);
  if (entry?.snapshot) return Promise.resolve(entry.snapshot);
  if (entry?.pending) return entry.pending;
  if (!entry) {
    entry = { epoch: 0 };
    cache.set(key, entry);
  }
  const mine = entry;
  const epoch = mine.epoch;
  const pending = completionSnapshot(connectionId, database).then(
    (snapshot) => {
      if (mine.epoch !== epoch) return loadSnapshot(connectionId, database); // went stale meanwhile
      mine.snapshot = snapshot;
      mine.pending = undefined;
      listeners.forEach((l) => l(connectionId));
      return snapshot;
    },
    (error) => {
      if (mine.pending === pending) mine.pending = undefined;
      throw error;
    },
  );
  mine.pending = pending;
  return pending;
}

/** Forget what was loaded for a connection (its schema changed, or it disconnected). */
export function invalidateSnapshots(connectionId: string): void {
  for (const [key, entry] of cache) {
    if (!key.startsWith(`${connectionId}\u0000`)) continue;
    entry.epoch += 1;
    entry.snapshot = undefined;
    entry.pending = undefined;
  }
  listeners.forEach((l) => l(connectionId));
}

/** Called whenever a snapshot arrives or is invalidated. */
export function onSnapshotChange(listener: (connectionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SCHEMA_CHANGING =
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*)(create|alter|drop|truncate|rename|comment\s+on)\b/i;

/** Whether a statement changes the schema (and so makes a snapshot stale). */
export function changesSchema(sql: string): boolean {
  return SCHEMA_CHANGING.test(sql);
}

/** Test helper. */
export function clearSnapshots(): void {
  cache.clear();
  listeners.clear();
}
