import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "production";
  children: ReactNode;
}) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

export type DriverId =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "sqlserver"
  | "oracle"
  | "clickhouse"
  | "sqlite"
  | "duckdb"
  | "mongodb"
  | "redis"
  | "neo4j";

export const DRIVER_BADGES: Record<DriverId, { code: string; color: string }> = {
  postgres: { code: "PG", color: "var(--drv-postgres)" },
  mysql: { code: "MY", color: "var(--drv-mysql)" },
  mariadb: { code: "MA", color: "var(--drv-mariadb)" },
  sqlserver: { code: "MS", color: "var(--drv-sqlserver)" },
  oracle: { code: "OR", color: "var(--drv-oracle)" },
  clickhouse: { code: "CH", color: "var(--drv-clickhouse)" },
  sqlite: { code: "SQ", color: "var(--drv-sqlite)" },
  duckdb: { code: "DK", color: "var(--drv-duckdb)" },
  mongodb: { code: "MG", color: "var(--drv-mongodb)" },
  redis: { code: "RD", color: "var(--drv-redis)" },
  neo4j: { code: "N4", color: "var(--drv-neo4j)" },
};

export function DriverBadge({ driver }: { driver: DriverId }) {
  const d = DRIVER_BADGES[driver];
  return (
    <span className={styles.driver} style={{ background: d.color }} title={driver}>
      {d.code}
    </span>
  );
}

export type Environment = "local" | "dev" | "staging" | "production";

export const ENV_COLORS: Record<Environment, string> = {
  local: "var(--env-local)",
  dev: "var(--env-dev)",
  staging: "var(--env-staging)",
  production: "var(--env-prod)",
};

export function EnvDot({ env, size = 6 }: { env: Environment; size?: number }) {
  return (
    <span
      className={styles.dot}
      style={{ width: size, height: size, background: ENV_COLORS[env] }}
      role="img"
      aria-label={`${env} environment`}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={styles.kbd}>{children}</kbd>;
}
