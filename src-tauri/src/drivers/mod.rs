//! The driver contract. Every database backend implements [`Driver`] and [`Session`]; the UI only
//! ever talks to these types (through the Tauri commands in `commands/`).

pub mod batch;
pub mod error;
pub mod introspect;
pub mod mysql;
pub mod paging;
pub mod postgres;
pub mod registry;
pub mod split;
pub mod sqlite;
pub mod table_meta;
pub mod value;

use std::any::Any;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub use error::{DriverError, DriverResult, ErrorCode};
pub use introspect::{NodePath, SchemaSnapshot, TreeNode};
pub use value::{Value, ValueKind};

// ---------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverFamily {
    Sql,
    Document,
    Keyvalue,
    Graph,
}

/// Which connection form the UI shows for the driver.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormKind {
    Network,
    File,
    Uri,
    Keyvalue,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dialect {
    Postgresql,
    Mysql,
    Mariadb,
    Sqlite,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub transactions: bool,
    pub cancel: bool,
    pub explain: bool,
    pub editable_results: bool,
    pub schemas: bool,
    pub multiple_databases: bool,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DriverMeta {
    pub id: &'static str,
    pub name: &'static str,
    /// Two-letter badge shown in trees and tabs (`PG`, `MY`, ...).
    pub badge: &'static str,
    /// CSS custom property for the badge colour, e.g. `--drv-postgres`.
    pub color_token: &'static str,
    pub family: DriverFamily,
    pub default_port: Option<u16>,
    pub form: FormKind,
    pub dialect: Option<Dialect>,
    pub capabilities: Capabilities,
}

// ---------------------------------------------------------------------------------------------
// Configuration (fully resolved: secrets are already filled in by the caller)
// ---------------------------------------------------------------------------------------------

/// A secret string. Redacted in `Debug`, never serialized: it can come in over IPC but never
/// goes back out, and never appears in logs or error messages.
#[derive(ts_rs::TS)]
#[ts(type = "string")]
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Drop for Secret {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.0);
    }
}

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Target {
    Network {
        host: String,
        port: u16,
    },
    File {
        path: String,
        #[serde(default)]
        create_if_missing: bool,
        #[serde(default)]
        read_only: bool,
    },
    /// A driver-specific connection URI, with any password already embedded or separate.
    Uri {
        uri: String,
    },
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum SshAuth {
    Agent,
    KeyFile {
        path: String,
        passphrase: Option<Secret>,
    },
    Password {
        password: Secret,
    },
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    #[default]
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct TlsConfig {
    #[serde(default)]
    pub mode: TlsMode,
    /// PEM CA bundle. When absent the OS trust store is used.
    pub ca_file: Option<String>,
    pub client_cert: Option<String>,
    pub client_key: Option<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ResolvedConfig {
    pub driver: String,
    pub target: Target,
    pub user: Option<String>,
    pub password: Option<Secret>,
    /// Default database / schema to open.
    pub database: Option<String>,
    pub ssh: Option<SshConfig>,
    #[serde(default)]
    pub tls: TlsConfig,
    #[serde(default = "default_connect_timeout")]
    #[ts(type = "number")]
    pub connect_timeout_secs: u64,
    /// Cancel statements running longer than this. `None` = no timeout.
    #[ts(type = "number | null")]
    pub query_timeout_secs: Option<u64>,
    /// Open sessions read-only (production connections default to this).
    #[serde(default)]
    pub read_only: bool,
    /// Driver-specific extras (e.g. `application_name`).
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    /// Statements to run on every new session (a saved connection's "on connect" list).
    #[serde(default)]
    pub on_connect: Vec<String>,
}

fn default_connect_timeout() -> u64 {
    10
}

impl ResolvedConfig {
    /// `host:port` for error messages, or the file path.
    pub fn describe_target(&self) -> String {
        match &self.target {
            Target::Network { host, port } => format!("{host}:{port}"),
            Target::File { path, .. } => path.clone(),
            Target::Uri { .. } => "the configured URI".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

pub const DEFAULT_PAGE_SIZE: usize = 500;
/// A batch is flushed at this many serialized bytes even if it has fewer rows than the page size.
pub const BATCH_BYTE_CAP: usize = 2 * 1024 * 1024;

pub type ResultId = u64;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct ExecRequest {
    pub sql: String,
    #[serde(default = "default_page_size")]
    pub page_size: usize,
    /// Script mode: split into statements and run each in order.
    #[serde(default)]
    pub script: bool,
    #[serde(default)]
    pub continue_on_error: bool,
}

fn default_page_size() -> usize {
    DEFAULT_PAGE_SIZE
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    /// The database's own type name, e.g. `int8`, `numeric`, `VARCHAR`.
    pub type_name: String,
    pub kind: ValueKind,
    pub nullable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_column: Option<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExecSummary {
    /// `None` for statements that return a result set.
    #[ts(type = "number | null")]
    pub rows_affected: Option<u64>,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub has_more: bool,
}

/// Streamed to the frontend over a Tauri `Channel`.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ResultEvent {
    /// A statement started producing a result. `statement` is the 0-based index in script mode.
    Columns {
        #[ts(type = "number")]
        result_id: ResultId,
        statement: usize,
        columns: Vec<ColumnMeta>,
    },
    Rows {
        #[ts(type = "number")]
        result_id: ResultId,
        rows: Vec<Vec<Value>>,
    },
    Done {
        #[ts(type = "number")]
        result_id: ResultId,
        summary: ExecSummary,
    },
    Error {
        #[ts(type = "number | null")]
        result_id: Option<ResultId>,
        statement: usize,
        error: DriverError,
    },
    Cancelled {
        #[ts(type = "number | null")]
        result_id: Option<ResultId>,
    },
    /// Informational message about the session itself (e.g. it was re-established).
    Notice { message: String },
}

/// Where a session sends result events. Dropping the receiver (window closed) makes sends fail,
/// which the session treats as "stop streaming".
#[derive(Debug, Clone)]
pub struct ResultSink(mpsc::Sender<ResultEvent>);

impl ResultSink {
    pub fn channel(capacity: usize) -> (Self, mpsc::Receiver<ResultEvent>) {
        let (tx, rx) = mpsc::channel(capacity);
        (Self(tx), rx)
    }

    /// Returns false when the receiver is gone.
    pub async fn send(&self, event: ResultEvent) -> bool {
        self.0.send(event).await.is_ok()
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServerInfo {
    /// e.g. `PostgreSQL`
    pub product: String,
    /// e.g. `16.2`
    pub version: String,
    /// Round-trip time of the trivial test query.
    #[ts(type = "number")]
    pub round_trip_ms: u64,
}

impl ServerInfo {
    pub fn display(&self) -> String {
        format!("{} {}", self.product, self.version)
    }
}

/// Usable from any task while `execute` is running, so cancel never waits on the session lock.
#[derive(Clone)]
pub struct CancelHandle(Arc<dyn CancelFn>);

#[async_trait]
pub trait CancelFn: Send + Sync {
    async fn cancel(&self) -> DriverResult<()>;
}

impl CancelHandle {
    pub fn new(f: impl CancelFn + 'static) -> Self {
        Self(Arc::new(f))
    }

    pub async fn cancel(&self) -> DriverResult<()> {
        self.0.cancel().await
    }
}

impl fmt::Debug for CancelHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CancelHandle")
    }
}

/// Identifies one cell for fetching its untruncated value.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct FullValueRequest {
    pub table: NodePath,
    pub column: String,
    /// Primary-key column values identifying the row.
    pub key: Vec<(String, Value)>,
}

/// Shared pool used for metadata and introspection (max 3 connections). Opaque to callers;
/// each driver downcasts to its own pool type.
#[derive(Clone)]
pub struct MetaPool(Arc<dyn Any + Send + Sync>);

impl MetaPool {
    pub fn new<T: Any + Send + Sync>(pool: T) -> Self {
        Self(Arc::new(pool))
    }

    pub fn downcast<T: Any + Send + Sync>(&self) -> DriverResult<&T> {
        self.0
            .downcast_ref::<T>()
            .ok_or_else(|| DriverError::internal("metadata pool belongs to a different driver"))
    }
}

impl fmt::Debug for MetaPool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MetaPool")
    }
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn meta(&self) -> &DriverMeta;

    /// Connect, run a trivial round-trip, report the server and the elapsed time, disconnect.
    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo>;

    /// Open a dedicated session (one physical connection).
    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>>;

    /// Open the shared metadata pool (max 3 connections).
    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool>;

    /// Children of `path` (the empty path is the connection root).
    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>>;

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot>;

    /// The `CREATE` statement for the object at `path` (e.g. via `SHOW CREATE TABLE`).
    async fn ddl(&self, _pool: &MetaPool, _path: &NodePath) -> DriverResult<String> {
        Err(DriverError::unsupported("showing DDL"))
    }

    /// Columns, indexes, foreign keys and statistics of the table at `path`.
    async fn table_meta(
        &self,
        _pool: &MetaPool,
        _path: &NodePath,
    ) -> DriverResult<table_meta::TableMeta> {
        Err(DriverError::unsupported("showing table structure"))
    }

    /// Exact `SELECT count(*)` of the table or view at `path`, on the metadata pool.
    async fn count_rows(&self, _pool: &MetaPool, _path: &NodePath) -> DriverResult<i64> {
        Err(DriverError::unsupported("counting rows"))
    }
}

#[async_trait]
pub trait Session: Send {
    /// Run exactly one statement (the session manager splits scripts). `Columns`, `Rows` and
    /// `Done` events stream into `sink`; the summary is also returned. Failures are returned as
    /// `Err` (use `ErrorCode::Cancelled` for a cancelled statement); the manager turns them into
    /// `Error` / `Cancelled` events, so drivers must not send those themselves. Result ids must
    /// increase over the session's lifetime so they stay unique across statements.
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary>;

    /// Pull up to `n` more rows of an open result. Returns whether more rows remain.
    async fn fetch_more(
        &mut self,
        result_id: ResultId,
        n: usize,
        sink: ResultSink,
    ) -> DriverResult<bool>;

    fn cancel_handle(&self) -> CancelHandle;

    /// Re-fetch one cell without truncation.
    async fn fetch_full_value(&mut self, _req: FullValueRequest) -> DriverResult<Value> {
        Err(DriverError::unsupported("fetching full values"))
    }

    /// Server identification for the status bar.
    fn server_info(&self) -> ServerInfo;

    async fn close(self: Box<Self>) -> DriverResult<()>;
}
