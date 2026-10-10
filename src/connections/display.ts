import type { DriverId, Environment as BadgeEnv } from "../components/Badge";
import { DRIVER_BADGES } from "../components/Badge";
import type { Connection, Environment } from "./api";

export const BADGE_ENV: Record<Environment, BadgeEnv> = {
  local: "local",
  development: "dev",
  staging: "staging",
  production: "production",
};

export function badgeDriver(driver: string): DriverId {
  return (driver in DRIVER_BADGES ? driver : "postgres") as DriverId;
}

/** `db.internal:5432/analytics`, a file path, or `localhost:6379 · db 0`. */
export function shortAddress(c: Connection): string {
  const s = c.settings;
  switch (s.kind) {
    case "network":
      return `${s.host}:${s.port}${s.database ? `/${s.database}` : ""}`;
    case "oracle":
      return `${s.host}:${s.port}${s.connectBy.value ? `/${s.connectBy.value}` : ""}`;
    case "file":
      return s.path;
    case "uri": {
      const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^?]*)/i.exec(s.uri);
      return m ? m[1] : s.uri;
    }
    case "keyvalue":
      return `${s.host}:${s.port} · db ${s.dbIndex}`;
    case "neo4j":
      return `${s.host}:${s.port}${s.database ? `/${s.database}` : ""}`;
  }
}

/** `just now`, `2 min ago`, `3 h ago`, `yesterday`, `5 d ago`, then a date. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
