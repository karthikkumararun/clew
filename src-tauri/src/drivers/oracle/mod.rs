//! The Oracle driver, on `oracle` (rust-oracle over ODPI-C). The Oracle Instant Client can't be
//! shipped with Clew; ODPI-C loads it at run time and [`client`] finds it.

pub mod client;
pub mod error;
pub mod introspect;
pub mod session;
pub mod types;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use oracle::{Connection, Connector, Privilege};

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, ErrorCode,
    FormKind, MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, Target,
    TreeNode,
};
use error::map_error;
use session::OraSession;

const META: DriverMeta = DriverMeta {
    id: "oracle",
    name: "Oracle",
    badge: "OR",
    color_token: "--drv-oracle",
    family: DriverFamily::Sql,
    default_port: Some(1521),
    form: FormKind::Network,
    dialect: Some(Dialect::Oracle),
    capabilities: Capabilities {
        transactions: true,
        cancel: true,
        explain: false,
        editable_results: true,
        schemas: true,
        multiple_databases: false,
    },
};

/// The connect string for the way the connection names its database.
pub fn connect_string(cfg: &ResolvedConfig) -> DriverResult<String> {
    let Target::Network { host, port } = &cfg.target else {
        return Err(DriverError::unsupported("A file target for Oracle"));
    };
    let by = cfg
        .options
        .get("oracle.connect_by")
        .map_or("service_name", String::as_str);
    let value = cfg
        .options
        .get("oracle.connect_value")
        .map(String::as_str)
        .or(cfg.database.as_deref())
        .unwrap_or_default();
    let secs = cfg.connect_timeout_secs.max(1);
    Ok(match by {
        "sid" => format!(
            "(DESCRIPTION=(TRANSPORT_CONNECT_TIMEOUT={secs})(ADDRESS=(PROTOCOL=TCP)(HOST={host})(PORT={port}))(CONNECT_DATA=(SID={value})))"
        ),
        "tns_alias" | "easy_connect" => value.to_string(),
        _ => format!("{host}:{port}/{value}?transport_connect_timeout={secs}"),
    })
}

/// Blocking: load the client, connect, and set the session up.
fn connect(cfg: &ResolvedConfig) -> DriverResult<Connection> {
    client::init(cfg.options.get("oracle.client_dir").map(String::as_str))?;
    if let Some(wallet) = cfg.options.get("oracle.wallet_dir") {
        std::env::set_var("TNS_ADMIN", wallet);
    }
    let target = cfg.describe_target();
    let mut connector = Connector::new(
        cfg.user.clone().unwrap_or_default(),
        cfg.password
            .as_ref()
            .map(|p| p.expose().to_string())
            .unwrap_or_default(),
        connect_string(cfg)?,
    );
    match cfg
        .options
        .get("oracle.role")
        .map(|r| r.to_ascii_uppercase())
        .as_deref()
    {
        Some("SYSDBA") => {
            connector.privilege(Privilege::Sysdba);
        }
        Some("SYSOPER") => {
            connector.privilege(Privilege::Sysoper);
        }
        _ => {}
    }
    let conn = connector
        .connect()
        .map_err(|e| map_error(e, &target, None))?;
    let setup = |sql: &str| conn.execute(sql, &[]).map(|_| ());
    // Plain strings convert to dates and timestamps in one fixed format (table edits bind text).
    for sql in [
        "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD\"T\"HH24:MI:SS'",
        "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD\"T\"HH24:MI:SS.FF'",
        "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD\"T\"HH24:MI:SS.FFTZH:TZM'",
        "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;",
    ] {
        setup(sql).map_err(|e| map_error(e, &target, None))?;
    }
    Ok(conn)
}

async fn connect_async(cfg: &ResolvedConfig) -> DriverResult<Connection> {
    let owned = cfg.clone();
    let timeout = Duration::from_secs(cfg.connect_timeout_secs.max(1) + 5);
    match tokio::time::timeout(
        timeout,
        tokio::task::spawn_blocking(move || connect(&owned)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err(DriverError::internal(
            "The connection attempt was interrupted",
        )),
        Err(_) => Err(DriverError::new(
            ErrorCode::Timeout,
            format!(
                "Could not reach {} within {}s",
                cfg.describe_target(),
                timeout.as_secs() - 5
            ),
        )),
    }
}

fn server_of(conn: &Connection) -> ServerInfo {
    let version = conn
        .server_version()
        .map(|(v, _)| v.to_string())
        .unwrap_or_default();
    ServerInfo {
        product: "Oracle Database".into(),
        version,
        round_trip_ms: 0,
    }
}

/// The metadata connection: opened lazily, reopened when it breaks.
pub struct Meta {
    cfg: ResolvedConfig,
    conn: Mutex<Option<Arc<Connection>>>,
    target: String,
}

impl Meta {
    /// Every row of `sql`, each column as text (`None` for NULL).
    pub async fn rows(&self, sql: &str) -> DriverResult<Vec<Vec<Option<String>>>> {
        for attempt in 0..2 {
            let existing = self.conn.lock().unwrap().clone();
            let conn = match existing {
                Some(c) => c,
                None => {
                    let c = Arc::new(connect_async(&self.cfg).await?);
                    *self.conn.lock().unwrap() = Some(c.clone());
                    c
                }
            };
            let (text, target) = (sql.to_string(), self.target.clone());
            let result =
                tokio::task::spawn_blocking(move || -> DriverResult<Vec<Vec<Option<String>>>> {
                    let mut out = Vec::new();
                    let rows = conn
                        .query(&text, &[])
                        .map_err(|e| map_error(e, &target, Some(&text)))?;
                    for row in rows {
                        let row = row.map_err(|e| map_error(e, &target, Some(&text)))?;
                        out.push(
                            (0..row.sql_values().len())
                                .map(|i| row.get::<_, Option<String>>(i).ok().flatten())
                                .collect(),
                        );
                    }
                    Ok(out)
                })
                .await
                .map_err(|_| DriverError::internal("The metadata query was interrupted"))?;
            match result {
                Err(e) if e.code == ErrorCode::ConnectionLost && attempt == 0 => {
                    *self.conn.lock().unwrap() = None;
                }
                other => return other,
            }
        }
        Err(DriverError::internal(
            "The metadata connection could not be used",
        ))
    }
}

#[derive(Debug, Default)]
pub struct OracleDriver;

impl OracleDriver {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Driver for OracleDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let started = Instant::now();
        let conn = connect_async(cfg).await?;
        let mut info = server_of(&conn);
        info.round_trip_ms = started.elapsed().as_millis() as u64;
        let _ = tokio::task::spawn_blocking(move || conn.close()).await;
        Ok(info)
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let conn = connect_async(cfg).await?;
        let server = server_of(&conn);
        let mut session = OraSession::new(conn, server, cfg.describe_target(), cfg.read_only);
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
        let conn = Arc::new(connect_async(cfg).await?);
        Ok(MetaPool::new(Arc::new(Meta {
            cfg: cfg.clone(),
            conn: Mutex::new(Some(conn)),
            target: cfg.describe_target(),
        })))
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
