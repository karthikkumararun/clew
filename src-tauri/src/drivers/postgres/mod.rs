//! The PostgreSQL driver (12+), built on sqlx.

pub mod config;
pub mod ddl;
pub mod decode;
pub mod error;
pub mod introspect;
pub mod session;

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use sqlx::{ConnectOptions, Connection};

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, ErrorCode,
    FormKind, MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, TreeNode,
};
use error::map_error;
use introspect::PgMeta;
use session::PgSession;

const META: DriverMeta = DriverMeta {
    id: "postgres",
    name: "PostgreSQL",
    badge: "PG",
    color_token: "--drv-postgres",
    family: DriverFamily::Sql,
    default_port: Some(5432),
    form: FormKind::Network,
    dialect: Some(Dialect::Postgresql),
    capabilities: Capabilities {
        transactions: true,
        cancel: true,
        explain: true,
        editable_results: true,
        schemas: true,
        multiple_databases: true,
    },
};

#[derive(Debug)]
pub struct PostgresDriver {
    meta: DriverMeta,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self { meta: META }
    }
}

impl Default for PostgresDriver {
    fn default() -> Self {
        Self::new()
    }
}

/// `16.15 (Debian 16.15-1.pgdg13+1)` -> `16.15`
pub fn parse_server_version(show: &str) -> String {
    show.split_whitespace().next().unwrap_or(show).to_string()
}

#[async_trait]
impl Driver for PostgresDriver {
    fn meta(&self) -> &DriverMeta {
        &self.meta
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let target = cfg.describe_target();
        let opts = config::connect_options(cfg)?;
        let mut conn = opts.connect().await.map_err(|e| map_error(e, &target))?;
        let version: String = sqlx::query_scalar("SHOW server_version")
            .fetch_one(&mut conn)
            .await
            .map_err(|e| map_error(e, &target))?;
        // a trivial round trip, timed on its own
        let started = Instant::now();
        sqlx::query("SELECT 1")
            .execute(&mut conn)
            .await
            .map_err(|e| map_error(e, &target))?;
        let round_trip_ms = started.elapsed().as_millis() as u64;
        let _ = conn.close().await;
        Ok(ServerInfo {
            product: "PostgreSQL".into(),
            version: parse_server_version(&version),
            round_trip_ms,
        })
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let target = cfg.describe_target();
        let opts = config::connect_options(cfg)?;
        // Read the server version on a throwaway query before wiring the session.
        let mut probe = opts
            .clone()
            .connect()
            .await
            .map_err(|e| map_error(e, &target))?;
        let version: String = sqlx::query_scalar("SHOW server_version")
            .fetch_one(&mut probe)
            .await
            .map_err(|e| map_error(e, &target))?;
        let _ = probe.close().await;
        let server = ServerInfo {
            product: "PostgreSQL".into(),
            version: parse_server_version(&version),
            round_trip_ms: 0,
        };
        let session = PgSession::connect(opts, server, cfg.read_only, target).await?;
        Ok(Box::new(session))
    }

    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        let target = cfg.describe_target();
        let opts = config::connect_options(cfg)?;
        Ok(MetaPool::new(Arc::new(PgMeta::open(opts, target).await?)))
    }

    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        let meta = pool.downcast::<Arc<PgMeta>>()?;
        introspect::children(meta, path).await
    }

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        let meta = pool.downcast::<Arc<PgMeta>>()?;
        introspect::snapshot(meta, db).await
    }

    async fn ddl(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<String> {
        introspect::ddl(pool.downcast::<Arc<PgMeta>>()?, path).await
    }

    async fn count_rows(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<i64> {
        introspect::count_rows(pool.downcast::<Arc<PgMeta>>()?, path).await
    }
}

impl From<ErrorCode> for DriverError {
    fn from(code: ErrorCode) -> Self {
        DriverError::new(code, code.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_version_is_the_leading_number() {
        assert_eq!(
            parse_server_version("16.15 (Debian 16.15-1.pgdg13+1)"),
            "16.15"
        );
        assert_eq!(parse_server_version("17beta1"), "17beta1");
        assert_eq!(parse_server_version("12.4"), "12.4");
    }
}
