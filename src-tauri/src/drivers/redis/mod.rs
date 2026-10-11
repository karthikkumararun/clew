//! The Redis driver (standalone servers; cluster is detected and refused). Keys are only ever
//! listed with an incremental `SCAN`, never `KEYS`.

pub mod commands;
pub mod session;

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use redis::{ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo};

use crate::drivers::introspect::{NodeKind, NodePath, SchemaSnapshot, TreeNode};
use crate::drivers::{
    Capabilities, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, ErrorCode, FormKind,
    MetaPool, ResolvedConfig, ServerInfo, Session, Target, TlsMode,
};
use session::RedisSession;

const META: DriverMeta = DriverMeta {
    id: "redis",
    name: "Redis",
    badge: "RD",
    color_token: "--drv-redis",
    family: DriverFamily::Keyvalue,
    default_port: Some(6379),
    form: FormKind::Keyvalue,
    dialect: None,
    capabilities: Capabilities {
        transactions: false,
        cancel: false,
        explain: false,
        editable_results: false,
        schemas: false,
        multiple_databases: true,
    },
};

#[derive(Debug, Default)]
pub struct RedisDriver;

impl RedisDriver {
    pub fn new() -> Self {
        Self
    }
}

pub(crate) fn map_err(e: redis::RedisError) -> DriverError {
    use redis::ErrorKind as K;
    let code = match e.kind() {
        K::AuthenticationFailed => ErrorCode::AuthFailed,
        K::Io => ErrorCode::ConnectionLost,
        _ => match e.code() {
            Some("NOAUTH" | "WRONGPASS") => ErrorCode::AuthFailed,
            Some("NOPERM") => ErrorCode::AccessDenied,
            _ => ErrorCode::QueryFailed,
        },
    };
    let msg = match e.detail() {
        Some(d) => format!("{} {d}", e.code().unwrap_or("ERR")),
        None => e.to_string(),
    };
    // Never echo the password, even if a server error message did.
    DriverError::new(code, msg)
}

/// Everything needed to open a connection to one logical database.
#[derive(Clone)]
pub(crate) struct Endpoint {
    addr: ConnectionAddr,
    user: Option<String>,
    password: Option<String>,
    timeout: Duration,
}

impl Endpoint {
    pub fn from_config(cfg: &ResolvedConfig) -> DriverResult<Self> {
        let Target::Network { host, port } = &cfg.target else {
            return Err(DriverError::internal("Redis connections are host and port"));
        };
        let addr = if cfg.tls.mode == TlsMode::Disable {
            ConnectionAddr::Tcp(host.clone(), *port)
        } else {
            ConnectionAddr::TcpTls {
                host: host.clone(),
                port: *port,
                insecure: matches!(cfg.tls.mode, TlsMode::Prefer | TlsMode::Require),
                tls_params: None,
            }
        };
        Ok(Self {
            addr,
            user: cfg.user.clone().filter(|u| !u.is_empty()),
            password: cfg.password.as_ref().map(|p| p.expose().to_string()),
            timeout: Duration::from_secs(cfg.connect_timeout_secs),
        })
    }

    pub async fn connect(&self, db: u32) -> DriverResult<MultiplexedConnection> {
        let mut settings = RedisConnectionInfo::default().set_db(db as i64);
        if let Some(u) = &self.user {
            settings = settings.set_username(u);
        }
        if let Some(p) = &self.password {
            settings = settings.set_password(p);
        }
        let info = self
            .addr
            .clone()
            .into_connection_info()
            .map_err(map_err)?
            .set_redis_settings(settings);
        let client = redis::Client::open(info).map_err(map_err)?;
        // Commands may legitimately take a while (BLPOP with a timeout, SLOWLOG, DEBUG SLEEP):
        // only connecting is bounded here.
        let config = redis::AsyncConnectionConfig::new()
            .set_connection_timeout(Some(self.timeout))
            .set_response_timeout(None);
        match tokio::time::timeout(
            self.timeout,
            client.get_multiplexed_async_connection_with_config(&config),
        )
        .await
        {
            Ok(r) => r.map_err(map_err),
            Err(_) => Err(DriverError::new(
                ErrorCode::Timeout,
                "Timed out connecting to Redis",
            )),
        }
    }
}

pub(crate) async fn server_info(conn: &mut MultiplexedConnection) -> DriverResult<ServerInfo> {
    let started = Instant::now();
    let info: String = redis::cmd("INFO")
        .arg("server")
        .query_async(conn)
        .await
        .map_err(map_err)?;
    let round_trip_ms = started.elapsed().as_millis() as u64;
    let field = |name: &str| {
        info.lines()
            .find_map(|l| l.strip_prefix(name).and_then(|r| r.strip_prefix(':')))
            .map(|v| v.trim().to_string())
    };
    // Valkey and Redis-compatible servers announce themselves; show what the server says.
    let product = if field("valkey_version").is_some() {
        "Valkey"
    } else {
        "Redis"
    };
    let version = field("valkey_version")
        .or_else(|| field("redis_version"))
        .unwrap_or_default();
    // Cluster mode is not supported in v1.
    let cluster: String = redis::cmd("INFO")
        .arg("cluster")
        .query_async(conn)
        .await
        .unwrap_or_default();
    if cluster.lines().any(|l| l.trim() == "cluster_enabled:1") {
        return Err(DriverError::new(
            ErrorCode::Unsupported,
            "Redis Cluster isn't supported yet",
        ));
    }
    Ok(ServerInfo {
        product: product.into(),
        version,
        round_trip_ms,
    })
}

#[async_trait]
impl Driver for RedisDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let ep = Endpoint::from_config(cfg)?;
        let mut conn = ep.connect(db_index(cfg)).await?;
        server_info(&mut conn).await
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let ep = Endpoint::from_config(cfg)?;
        let db = db_index(cfg);
        let mut conn = ep.connect(db).await?;
        let info = server_info(&mut conn).await?;
        Ok(Box::new(RedisSession::new(
            ep,
            db,
            conn,
            info,
            cfg.read_only,
        )))
    }

    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        let ep = Endpoint::from_config(cfg)?;
        let mut conn = ep.connect(db_index(cfg)).await?;
        server_info(&mut conn).await?;
        Ok(MetaPool::new(Arc::new(RedisMeta { ep })))
    }

    /// Redis has databases `0..N` and no tree below them: keys live in the browser side list.
    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        if path.last().is_some() {
            return Ok(vec![]);
        }
        let meta = pool.downcast::<Arc<RedisMeta>>()?;
        let mut conn = meta.ep.connect(0).await?;
        let (items, databases) = commands::keyspaces(&mut conn).await?;
        let mut nodes = Vec::new();
        for i in 0..databases {
            let count = items.iter().find(|(d, _)| *d == i).map_or(0, |(_, n)| *n);
            if i == 0 || count > 0 {
                nodes.push(
                    TreeNode::new(path, NodeKind::Database, format!("db{i}"), false)
                        .with_detail(count.to_string()),
                );
            }
        }
        Ok(nodes)
    }

    async fn completion_snapshot(
        &self,
        _pool: &MetaPool,
        _db: &str,
    ) -> DriverResult<SchemaSnapshot> {
        Ok(SchemaSnapshot::default())
    }
}

struct RedisMeta {
    ep: Endpoint,
}

fn db_index(cfg: &ResolvedConfig) -> u32 {
    cfg.options
        .get("db_index")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}
