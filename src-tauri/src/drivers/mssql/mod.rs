//! The SQL Server driver, on tiberius (a pure-Rust TDS client). SQL authentication everywhere,
//! Windows integrated authentication on Windows builds. SQL Server has no session-level
//! read-only mode, so read-only is enforced by Clew's guard only.

pub mod error;
pub mod introspect;
pub mod session;
pub mod types;

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tiberius::{AuthMethod, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, ErrorCode,
    FormKind, MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, Target,
    TlsMode, TreeNode,
};
use error::map_error;
use session::{MsSession, TdsClient};

const META: DriverMeta = DriverMeta {
    id: "sqlserver",
    name: "SQL Server",
    badge: "MS",
    color_token: "--drv-sqlserver",
    family: DriverFamily::Sql,
    default_port: Some(1433),
    form: FormKind::Network,
    dialect: Some(Dialect::Tsql),
    capabilities: Capabilities {
        transactions: true,
        cancel: true,
        explain: false,
        editable_results: true,
        schemas: true,
        multiple_databases: true,
    },
};

fn target_of(cfg: &ResolvedConfig) -> DriverResult<(String, u16)> {
    match &cfg.target {
        Target::Network { host, port } => Ok((host.clone(), *port)),
        _ => Err(DriverError::unsupported("A file target for SQL Server")),
    }
}

pub fn build_config(cfg: &ResolvedConfig) -> DriverResult<Config> {
    let (host, port) = target_of(cfg)?;
    let mut config = Config::new();
    config.host(host);
    config.port(port);
    if let Some(db) = cfg.database.as_deref().filter(|d| !d.is_empty()) {
        config.database(db);
    }
    config.application_name("Clew");
    config.authentication(match cfg.user.as_deref().filter(|u| !u.is_empty()) {
        Some(user) => AuthMethod::sql_server(
            user,
            cfg.password
                .as_ref()
                .map(|p| p.expose())
                .unwrap_or_default(),
        ),
        None => integrated()?,
    });
    match cfg.tls.mode {
        // SQL Server always runs a TLS handshake to protect the login, even when the data is
        // not encrypted, and its auto-generated certificate can't be verified. With encryption
        // off there is nothing to protect by verifying it, so it is accepted (as `Encrypt=false;
        // TrustServerCertificate=true` would).
        TlsMode::Disable => {
            config.encryption(EncryptionLevel::Off);
            config.trust_cert();
        }
        TlsMode::Prefer | TlsMode::Require => {
            config.encryption(EncryptionLevel::Required);
            config.trust_cert();
        }
        TlsMode::VerifyCa | TlsMode::VerifyFull => {
            config.encryption(EncryptionLevel::Required);
            if let Some(ca) = &cfg.tls.ca_file {
                config.trust_cert_ca(ca);
            }
        }
    }
    Ok(config)
}

#[cfg(windows)]
fn integrated() -> DriverResult<AuthMethod> {
    Ok(AuthMethod::Integrated)
}

#[cfg(not(windows))]
fn integrated() -> DriverResult<AuthMethod> {
    Err(DriverError::new(
        ErrorCode::AuthFailed,
        "Enter a user name: Windows integrated authentication is only available on Windows",
    ))
}

pub async fn connect(cfg: &ResolvedConfig) -> DriverResult<TdsClient> {
    let config = build_config(cfg)?;
    let (host, port) = target_of(cfg)?;
    let target = format!("{host}:{port}");
    let timeout = Duration::from_secs(cfg.connect_timeout_secs.max(1));
    let tcp = match tokio::time::timeout(timeout, TcpStream::connect(config.get_addr())).await {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(e)) => {
            return Err(DriverError::new(
                ErrorCode::ConnectionLost,
                format!("Could not reach {target}: {e}"),
            ))
        }
        Err(_) => {
            return Err(DriverError::new(
                ErrorCode::Timeout,
                format!("Could not reach {target} within {}s", timeout.as_secs()),
            ))
        }
    };
    let _ = tcp.set_nodelay(true);
    match tokio::time::timeout(
        timeout,
        tiberius::Client::connect(config, tcp.compat_write()),
    )
    .await
    {
        Ok(r) => r.map_err(|e| map_error(e, &target)),
        Err(_) => Err(DriverError::new(
            ErrorCode::Timeout,
            format!(
                "{target} didn't finish the login within {}s",
                timeout.as_secs()
            ),
        )),
    }
}

async fn server_info(client: &mut TdsClient, target: &str) -> DriverResult<ServerInfo> {
    let rows = client
        .simple_query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50))")
        .await
        .map_err(|e| map_error(e, target))?
        .into_first_result()
        .await
        .map_err(|e| map_error(e, target))?;
    let version = rows
        .first()
        .and_then(|r| r.get::<&str, _>(0))
        .unwrap_or_default()
        .to_string();
    Ok(ServerInfo {
        product: "SQL Server".into(),
        version,
        round_trip_ms: 0,
    })
}

/// The metadata connection: one lazily opened client behind a lock, reopened when it breaks.
pub struct Meta {
    cfg: ResolvedConfig,
    client: Mutex<Option<TdsClient>>,
    target: String,
}

impl Meta {
    pub async fn rows(&self, sql: &str) -> DriverResult<Vec<Vec<tiberius::ColumnData<'static>>>> {
        let mut guard = self.client.lock().await;
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(connect(&self.cfg).await?);
            }
            let client = guard.as_mut().expect("connected");
            let result = match client.simple_query(sql).await {
                Ok(stream) => stream.into_first_result().await,
                Err(e) => Err(e),
            };
            match result {
                Ok(rows) => return Ok(rows.into_iter().map(|r| r.into_iter().collect()).collect()),
                Err(e) => {
                    let err = map_error(e, &self.target);
                    if err.code == ErrorCode::ConnectionLost && attempt == 0 {
                        *guard = None; // reconnect and try once more
                        continue;
                    }
                    return Err(err);
                }
            }
        }
        Err(DriverError::internal(
            "The metadata connection could not be used",
        ))
    }
}

#[derive(Debug, Default)]
pub struct MsSqlDriver;

impl MsSqlDriver {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Driver for MsSqlDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let (host, port) = target_of(cfg)?;
        let target = format!("{host}:{port}");
        let started = Instant::now();
        let mut client = connect(cfg).await?;
        let mut info = server_info(&mut client, &target).await?;
        info.round_trip_ms = started.elapsed().as_millis() as u64;
        let _ = client.close().await;
        Ok(info)
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let (host, port) = target_of(cfg)?;
        let target = format!("{host}:{port}");
        let mut client = connect(cfg).await?;
        let server = server_info(&mut client, &target).await?;
        let mut session = MsSession::new(client, server, target);
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
        let (host, port) = target_of(cfg)?;
        let meta = Meta {
            cfg: cfg.clone(),
            client: Mutex::new(Some(connect(cfg).await?)),
            target: format!("{host}:{port}"),
        };
        Ok(MetaPool::new(Arc::new(meta)))
    }

    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        introspect::children(pool.downcast::<Arc<Meta>>()?, path).await
    }

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        introspect::snapshot(pool.downcast::<Arc<Meta>>()?, db).await
    }

    async fn ddl(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<String> {
        introspect::ddl(pool.downcast::<Arc<Meta>>()?, path).await
    }

    async fn table_meta(
        &self,
        pool: &MetaPool,
        path: &NodePath,
    ) -> DriverResult<crate::drivers::table_meta::TableMeta> {
        introspect::table_meta(pool.downcast::<Arc<Meta>>()?, path).await
    }

    async fn count_rows(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<i64> {
        introspect::count_rows(pool.downcast::<Arc<Meta>>()?, path).await
    }
}
