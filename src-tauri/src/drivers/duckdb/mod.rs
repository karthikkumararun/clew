//! The DuckDB driver (bundled library, no system dependency): local `.duckdb` files and
//! in-memory databases. A connection of the app is one database instance; every session and the
//! metadata pool are connections cloned from it, so they all see the same data.

pub mod error;
pub mod introspect;
pub mod session;
pub mod types;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

use async_trait::async_trait;
use duckdb::{AccessMode, Config, Connection};

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, ErrorCode,
    FormKind, MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, Target,
    TreeNode,
};
use error::map_error;
use session::DuckSession;

const META: DriverMeta = DriverMeta {
    id: "duckdb",
    name: "DuckDB",
    badge: "DK",
    color_token: "--drv-duckdb",
    family: DriverFamily::Sql,
    default_port: None,
    form: FormKind::File,
    dialect: Some(Dialect::Duckdb),
    capabilities: Capabilities {
        transactions: true,
        cancel: true,
        explain: true,
        editable_results: true,
        schemas: true,
        multiple_databases: true,
    },
};

pub const MEMORY: &str = ":memory:";

/// One open database. Connections are cloned from `root`.
pub struct Shared {
    root: Mutex<Connection>,
    pub path: String,
}

impl Shared {
    pub fn conn(&self) -> DriverResult<Connection> {
        self.root
            .lock()
            .unwrap()
            .try_clone()
            .map_err(|e| map_error(e, &self.path, None))
    }

    /// Run a query on a cloned connection and return every row as DuckDB values.
    pub async fn rows(
        self: &Arc<Self>,
        sql: String,
    ) -> DriverResult<Vec<Vec<duckdb::types::Value>>> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.conn()?;
            let map = |e| map_error(e, &this.path, Some(&sql));
            let mut stmt = conn.prepare(&sql).map_err(map)?;
            let mut rows = stmt.query([]).map_err(map)?;
            let n = rows.as_ref().map_or(0, |s| s.column_count());
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(map)? {
                out.push(
                    (0..n)
                        .map(|i| {
                            row.get::<_, duckdb::types::Value>(i)
                                .unwrap_or(duckdb::types::Value::Null)
                        })
                        .collect(),
                );
            }
            Ok(out)
        })
        .await
        .map_err(|_| DriverError::internal("The metadata query was interrupted"))?
    }
}

#[derive(Default)]
pub struct DuckDbDriver {
    open: Mutex<HashMap<String, Weak<Shared>>>,
}

impl DuckDbDriver {
    pub fn new() -> Self {
        Self::default()
    }

    /// The database for this configuration, shared with whatever else has it open.
    async fn shared(&self, cfg: &ResolvedConfig) -> DriverResult<Arc<Shared>> {
        let (path, create, target_ro) = match &cfg.target {
            Target::File {
                path,
                create_if_missing,
                read_only,
            } => (path.trim().to_string(), *create_if_missing, *read_only),
            _ => return Err(DriverError::unsupported("A network target for DuckDB")),
        };
        let memory = path.is_empty() || path == MEMORY;
        let path = if memory { MEMORY.to_string() } else { path };
        let read_only = !memory && (target_ro || cfg.read_only);
        let key = format!("{path}|{read_only}");
        if let Some(existing) = self.open.lock().unwrap().get(&key).and_then(Weak::upgrade) {
            return Ok(existing);
        }
        if !memory && !create && !Path::new(&path).exists() {
            return Err(DriverError::new(
                ErrorCode::FileNotFound,
                format!("The database file {path} does not exist"),
            ));
        }
        let opened = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || -> DriverResult<Connection> {
                if path == MEMORY {
                    return Connection::open_in_memory().map_err(|e| map_error(e, &path, None));
                }
                let mode = if read_only {
                    AccessMode::ReadOnly
                } else {
                    AccessMode::ReadWrite
                };
                let config = Config::default()
                    .access_mode(mode)
                    .map_err(|e| map_error(e, &path, None))?;
                Connection::open_with_flags(&path, config).map_err(|e| map_error(e, &path, None))
            })
            .await
            .map_err(|_| DriverError::internal("Opening the database was interrupted"))??
        };
        let shared = Arc::new(Shared {
            root: Mutex::new(opened),
            path,
        });
        let mut open = self.open.lock().unwrap();
        open.retain(|_, w| w.strong_count() > 0);
        open.insert(key, Arc::downgrade(&shared));
        Ok(shared)
    }

    async fn server(shared: &Arc<Shared>) -> DriverResult<ServerInfo> {
        let rows = shared.rows("SELECT version()".into()).await?;
        let version = match rows.first().and_then(|r| r.first()) {
            Some(duckdb::types::Value::Text(v)) => v.trim_start_matches('v').to_string(),
            _ => String::new(),
        };
        Ok(ServerInfo {
            product: "DuckDB".into(),
            version,
            round_trip_ms: 0,
        })
    }
}

#[async_trait]
impl Driver for DuckDbDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let shared = self.shared(cfg).await?;
        let started = Instant::now();
        let mut info = Self::server(&shared).await?;
        info.round_trip_ms = started.elapsed().as_millis() as u64;
        Ok(info)
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let shared = self.shared(cfg).await?;
        let server = Self::server(&shared).await?;
        let conn = shared.conn()?;
        let path = shared.path.clone();
        let mut session = DuckSession::new(shared, conn, server, path);
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
        Ok(MetaPool::new(self.shared(cfg).await?))
    }

    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        introspect::children(pool.downcast::<Arc<Shared>>()?, path).await
    }

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        introspect::snapshot(pool.downcast::<Arc<Shared>>()?, db).await
    }

    async fn ddl(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<String> {
        introspect::ddl(pool.downcast::<Arc<Shared>>()?, path).await
    }

    async fn table_meta(
        &self,
        pool: &MetaPool,
        path: &NodePath,
    ) -> DriverResult<crate::drivers::table_meta::TableMeta> {
        introspect::table_meta(pool.downcast::<Arc<Shared>>()?, path).await
    }

    async fn count_rows(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<i64> {
        introspect::count_rows(pool.downcast::<Arc<Shared>>()?, path).await
    }
}
