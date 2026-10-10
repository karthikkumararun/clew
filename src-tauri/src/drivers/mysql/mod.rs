//! The MySQL (8.0+) and MariaDB (10.6+) drivers, built on sqlx.

pub mod config;
pub mod decode;
pub mod error;
pub mod introspect;
pub mod session;

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use sqlx::{ConnectOptions, Connection};

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverFamily, DriverMeta, DriverResult, FormKind, MetaPool,
    NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, TreeNode,
};
use error::map_error;
use introspect::MyMeta;
use session::MySession;

const CAPS: Capabilities = Capabilities {
    transactions: true,
    cancel: true,
    explain: true,
    editable_results: true,
    schemas: false,
    multiple_databases: true,
};

const MYSQL: DriverMeta = DriverMeta {
    id: "mysql",
    name: "MySQL",
    badge: "MY",
    color_token: "--drv-mysql",
    family: DriverFamily::Sql,
    default_port: Some(3306),
    form: FormKind::Network,
    dialect: Some(Dialect::Mysql),
    capabilities: CAPS,
};

const MARIADB: DriverMeta = DriverMeta {
    id: "mariadb",
    name: "MariaDB",
    badge: "MA",
    color_token: "--drv-mariadb",
    family: DriverFamily::Sql,
    default_port: Some(3306),
    form: FormKind::Network,
    dialect: Some(Dialect::Mariadb),
    capabilities: CAPS,
};

#[derive(Debug)]
pub struct MysqlDriver {
    meta: DriverMeta,
}

impl MysqlDriver {
    pub fn mysql() -> Self {
        Self { meta: MYSQL }
    }

    pub fn mariadb() -> Self {
        Self { meta: MARIADB }
    }
}

/// `8.0.45` -> (`MySQL`, `8.0.45`); `11.8.2-MariaDB-ubu2404` -> (`MariaDB`, `11.8.2`);
/// `5.5.5-10.6.12-MariaDB` (the replication-compatibility prefix) -> (`MariaDB`, `10.6.12`).
pub fn parse_version(version: &str) -> (String, String) {
    let is_maria = version.to_ascii_lowercase().contains("mariadb");
    let v = version.strip_prefix("5.5.5-").unwrap_or(version);
    let number = v.split('-').next().unwrap_or(v).to_string();
    (
        if is_maria { "MariaDB" } else { "MySQL" }.to_string(),
        number,
    )
}

async fn server_version(
    conn: &mut sqlx::mysql::MySqlConnection,
    target: &str,
) -> DriverResult<ServerInfo> {
    let v: String = sqlx::query_scalar("SELECT CAST(VERSION() AS CHAR)")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| map_error(e, target, None))?;
    let (product, version) = parse_version(&v);
    Ok(ServerInfo {
        product,
        version,
        round_trip_ms: 0,
    })
}

#[async_trait]
impl Driver for MysqlDriver {
    fn meta(&self) -> &DriverMeta {
        &self.meta
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let target = cfg.describe_target();
        let opts = config::connect_options(cfg)?;
        let mut conn = opts
            .connect()
            .await
            .map_err(|e| map_error(e, &target, None))?;
        let mut info = server_version(&mut conn, &target).await?;
        let started = Instant::now();
        sqlx::query("SELECT 1")
            .execute(&mut conn)
            .await
            .map_err(|e| map_error(e, &target, None))?;
        info.round_trip_ms = started.elapsed().as_millis() as u64;
        let _ = conn.close().await;
        Ok(info)
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let target = cfg.describe_target();
        let opts = config::connect_options(cfg)?;
        let mut probe = opts
            .clone()
            .connect()
            .await
            .map_err(|e| map_error(e, &target, None))?;
        let server = server_version(&mut probe, &target).await?;
        let _ = probe.close().await;
        let session = MySession::connect(opts, server, cfg.read_only, target).await?;
        Ok(Box::new(session))
    }

    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        let target = cfg.describe_target();
        let opts = config::connect_options(cfg)?;
        Ok(MetaPool::new(Arc::new(MyMeta::open(opts, target).await?)))
    }

    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        introspect::children(pool.downcast::<Arc<MyMeta>>()?, path).await
    }

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        introspect::snapshot(pool.downcast::<Arc<MyMeta>>()?, db).await
    }

    async fn ddl(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<String> {
        introspect::ddl(pool.downcast::<Arc<MyMeta>>()?, path).await
    }

    async fn count_rows(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<i64> {
        introspect::count_rows(pool.downcast::<Arc<MyMeta>>()?, path).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_parsed_for_both_flavors() {
        assert_eq!(parse_version("8.0.45"), ("MySQL".into(), "8.0.45".into()));
        assert_eq!(
            parse_version("8.4.3-commercial"),
            ("MySQL".into(), "8.4.3".into())
        );
        assert_eq!(
            parse_version("11.8.2-MariaDB-ubu2404"),
            ("MariaDB".into(), "11.8.2".into())
        );
        assert_eq!(
            parse_version("5.5.5-10.6.12-MariaDB"),
            ("MariaDB".into(), "10.6.12".into())
        );
    }

    #[test]
    fn both_flavors_are_registered_with_their_own_metadata() {
        assert_eq!(MysqlDriver::mysql().meta().badge, "MY");
        assert_eq!(
            MysqlDriver::mariadb().meta().dialect,
            Some(Dialect::Mariadb)
        );
    }
}
