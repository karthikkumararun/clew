//! The ClickHouse driver, over the HTTP interface (port 8123 / 8443). Sessions are emulated with a
//! `session_id`; queries are cancelled by id with `KILL QUERY`. Result rows are read-only in the
//! grid: ClickHouse mutations are asynchronous and its sorting key is not a unique key.

pub mod client;
pub mod introspect;
pub mod session;
pub mod types;

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverFamily, DriverMeta, DriverResult, FormKind, MetaPool,
    NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, TreeNode,
};
use client::Client;
use session::ChSession;

const META: DriverMeta = DriverMeta {
    id: "clickhouse",
    name: "ClickHouse",
    badge: "CH",
    color_token: "--drv-clickhouse",
    family: DriverFamily::Sql,
    default_port: Some(8123),
    form: FormKind::Network,
    dialect: Some(Dialect::Clickhouse),
    capabilities: Capabilities {
        transactions: false,
        cancel: true,
        explain: true,
        editable_results: false,
        schemas: false,
        multiple_databases: true,
    },
};

#[derive(Debug, Default)]
pub struct ClickHouseDriver;

impl ClickHouseDriver {
    pub fn new() -> Self {
        Self
    }

    async fn server(client: &Client) -> DriverResult<ServerInfo> {
        let rows = client.rows("SELECT version()").await?;
        let version = rows
            .first()
            .and_then(|r| r.first())
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(ServerInfo {
            product: "ClickHouse".into(),
            version,
            round_trip_ms: 0,
        })
    }
}

#[async_trait]
impl Driver for ClickHouseDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let client = Client::new(cfg)?;
        let started = Instant::now();
        let mut info = Self::server(&client).await?;
        info.round_trip_ms = started.elapsed().as_millis() as u64;
        Ok(info)
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let client = Arc::new(Client::new(cfg)?);
        let server = Self::server(&client).await?;
        let mut session = ChSession::new(client, server);
        for sql in &cfg.on_connect {
            let (sink, _rx) = crate::drivers::ResultSink::channel(8);
            session
                .execute(
                    crate::drivers::ExecRequest {
                        sql: sql.clone(),
                        page_size: 1,
                        script: false,
                        continue_on_error: false,
                    },
                    sink,
                )
                .await?;
        }
        Ok(Box::new(session))
    }

    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        let client = Arc::new(Client::new(cfg)?);
        // Fail now if the server can't be reached or the credentials are wrong.
        Self::server(&client).await?;
        Ok(MetaPool::new(client))
    }

    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        introspect::children(pool.downcast::<Arc<Client>>()?, path).await
    }

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        introspect::snapshot(pool.downcast::<Arc<Client>>()?, db).await
    }

    async fn ddl(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<String> {
        introspect::ddl(pool.downcast::<Arc<Client>>()?, path).await
    }

    async fn table_meta(
        &self,
        pool: &MetaPool,
        path: &NodePath,
    ) -> DriverResult<crate::drivers::table_meta::TableMeta> {
        introspect::table_meta(pool.downcast::<Arc<Client>>()?, path).await
    }

    async fn count_rows(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<i64> {
        introspect::count_rows(pool.downcast::<Arc<Client>>()?, path).await
    }
}
