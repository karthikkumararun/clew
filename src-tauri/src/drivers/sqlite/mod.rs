//! The SQLite driver, built on sqlx. A connection is a database file; attached databases come
//! from `attach:<name>` options and appear next to `main` in the tree.

pub mod config;
pub mod decode;
pub mod error;
pub mod introspect;
pub mod metadata;
pub mod session;

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use sqlx::{ConnectOptions, Connection};

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, FormKind,
    MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, Target, TreeNode,
};
use error::map_error;
use introspect::SqliteMeta;
use session::SqliteSession;

const META: DriverMeta = DriverMeta {
    id: "sqlite",
    name: "SQLite",
    badge: "SQ",
    color_token: "--drv-sqlite",
    family: DriverFamily::Sql,
    default_port: None,
    form: FormKind::File,
    dialect: Some(Dialect::Sqlite),
    capabilities: Capabilities {
        transactions: true,
        cancel: true,
        explain: true,
        editable_results: true,
        schemas: false,
        multiple_databases: true,
    },
};

#[derive(Debug)]
pub struct SqliteDriver {
    meta: DriverMeta,
}

impl SqliteDriver {
    pub fn new() -> Self {
        Self { meta: META }
    }
}

impl Default for SqliteDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn file_path(cfg: &ResolvedConfig) -> DriverResult<String> {
    match &cfg.target {
        Target::File { path, .. } => Ok(path.clone()),
        _ => Err(DriverError::unsupported("A network target for SQLite")),
    }
}

async fn version(
    conn: &mut sqlx::sqlite::SqliteConnection,
    path: &str,
) -> DriverResult<ServerInfo> {
    let v: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| map_error(e, path, None))?;
    Ok(ServerInfo {
        product: "SQLite".into(),
        version: v,
        round_trip_ms: 0,
    })
}

#[async_trait]
impl Driver for SqliteDriver {
    fn meta(&self) -> &DriverMeta {
        &self.meta
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let path = file_path(cfg)?;
        let mut conn = config::connect_options(cfg)?
            .connect()
            .await
            .map_err(|e| map_error(e, &path, None))?;
        let mut info = version(&mut conn, &path).await?;
        let started = Instant::now();
        sqlx::query("SELECT 1")
            .execute(&mut conn)
            .await
            .map_err(|e| map_error(e, &path, None))?;
        info.round_trip_ms = started.elapsed().as_millis() as u64;
        let _ = conn.close().await;
        Ok(info)
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let path = file_path(cfg)?;
        let opts = config::connect_options(cfg)?;
        let mut probe = opts
            .clone()
            .connect()
            .await
            .map_err(|e| map_error(e, &path, None))?;
        let server = version(&mut probe, &path).await?;
        let _ = probe.close().await;
        let mut session =
            SqliteSession::connect(opts, &config::attachments(cfg), server, path).await?;
        if cfg.read_only {
            session.set_read_only(true).await?;
        }
        Ok(Box::new(session))
    }

    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        let path = file_path(cfg)?;
        let mut opts = config::connect_options(cfg)?;
        // Metadata never writes. A file that does not exist yet must still be creatable by the
        // pool's first connection, so only an existing file is opened read-only.
        if Path::new(&path).exists() {
            opts = opts.read_only(true).create_if_missing(false);
        }
        Ok(MetaPool::new(Arc::new(
            SqliteMeta::open(opts, config::attachments(cfg), path).await?,
        )))
    }

    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        introspect::children(pool.downcast::<Arc<SqliteMeta>>()?, path).await
    }

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        introspect::snapshot(pool.downcast::<Arc<SqliteMeta>>()?, db).await
    }

    async fn ddl(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<String> {
        introspect::ddl(pool.downcast::<Arc<SqliteMeta>>()?, path).await
    }

    async fn table_meta(
        &self,
        pool: &MetaPool,
        path: &NodePath,
    ) -> DriverResult<crate::drivers::table_meta::TableMeta> {
        metadata::table_meta(pool.downcast::<Arc<SqliteMeta>>()?, path).await
    }

    async fn count_rows(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<i64> {
        introspect::count_rows(pool.downcast::<Arc<SqliteMeta>>()?, path).await
    }
}
