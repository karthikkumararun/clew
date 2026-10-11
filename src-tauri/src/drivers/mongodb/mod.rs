//! The MongoDB driver (official `mongodb` crate, rustls). A session is one client with a pool of
//! its own; documents travel as canonical Extended JSON (see [`ejson`]). Queries are written in a
//! relaxed shell syntax that a small Rust parser understands ([`shell`]): there is no JavaScript
//! engine anywhere.

pub mod ejson;
pub mod schema;
pub mod session;
pub mod shell;
pub mod tabular;
pub mod uri;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mongodb::bson::doc;
use mongodb::options::{ClientOptions, Credential, Tls, TlsOptions};
use mongodb::Client;

use crate::drivers::introspect::{
    NodeKind, NodePath, SchemaSnapshot, SnapshotSchema, SnapshotTable, TreeNode,
};
use crate::drivers::postgres::introspect::format_count;
use crate::drivers::{
    Capabilities, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, ErrorCode, FormKind,
    MetaPool, ResolvedConfig, ServerInfo, Session, Target, TlsMode,
};
use session::MongoSession;

const META: DriverMeta = DriverMeta {
    id: "mongodb",
    name: "MongoDB",
    badge: "MG",
    color_token: "--drv-mongodb",
    family: DriverFamily::Document,
    default_port: Some(27017),
    form: FormKind::Uri,
    dialect: None,
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
pub struct MongoDriver;

impl MongoDriver {
    pub fn new() -> Self {
        Self
    }
}

pub(crate) fn map_err(e: mongodb::error::Error) -> DriverError {
    use mongodb::error::ErrorKind as K;
    let text = e.to_string();
    let code = match e.kind.as_ref() {
        K::Authentication { .. } => ErrorCode::AuthFailed,
        K::ServerSelection { .. } | K::DnsResolve { .. } | K::Io(_) => ErrorCode::ConnectionLost,
        K::Command(c) if c.code == 13 || c.code == 18 => ErrorCode::AuthFailed,
        K::Command(c) if c.code == 50 => ErrorCode::Timeout,
        K::Command(c) if c.code == 11601 || c.code == 11602 => ErrorCode::Cancelled,
        _ => ErrorCode::QueryFailed,
    };
    DriverError::new(code, text)
}

/// Build the client for a resolved config. The password is never put in the URI text.
pub(crate) async fn connect(cfg: &ResolvedConfig) -> DriverResult<Client> {
    let Target::Uri { uri } = &cfg.target else {
        return Err(DriverError::internal(
            "MongoDB connections are described by a URI",
        ));
    };
    let mut opts = ClientOptions::parse(uri).await.map_err(|e| {
        DriverError::new(ErrorCode::QueryFailed, format!("Invalid MongoDB URI: {e}"))
    })?;
    opts.app_name = Some("Clew".into());
    let timeout = Duration::from_secs(cfg.connect_timeout_secs);
    opts.connect_timeout = Some(timeout);
    opts.server_selection_timeout = Some(timeout);
    opts.max_pool_size = Some(4);
    if let (Some(user), None) = (&cfg.user, &opts.credential) {
        opts.credential = Some(
            Credential::builder()
                .username(user.clone())
                .password(cfg.password.as_ref().map(|p| p.expose().to_string()))
                .source(cfg.database.clone())
                .build(),
        );
    } else if let (Some(cred), Some(pw)) = (opts.credential.as_mut(), &cfg.password) {
        if cred.password.is_none() {
            cred.password = Some(pw.expose().to_string());
        }
    }
    if opts.tls.is_none() && cfg.tls.mode != TlsMode::Disable {
        let o = TlsOptions::builder()
            .ca_file_path(cfg.tls.ca_file.as_deref().map(PathBuf::from))
            .cert_key_file_path(cfg.tls.client_cert.as_deref().map(PathBuf::from))
            .allow_invalid_certificates(matches!(cfg.tls.mode, TlsMode::Prefer | TlsMode::Require))
            .build();
        opts.tls = Some(Tls::Enabled(o));
    }
    Client::with_options(opts).map_err(map_err)
}

pub(crate) async fn server_info(client: &Client) -> DriverResult<ServerInfo> {
    let started = Instant::now();
    let admin = client.database("admin");
    let build = admin
        .run_command(doc! {"buildInfo": 1})
        .await
        .map_err(map_err)?;
    let round_trip_ms = started.elapsed().as_millis() as u64;
    let mut version = build.get_str("version").unwrap_or_default().to_string();
    if let Ok(hello) = admin.run_command(doc! {"hello": 1}).await {
        if let Ok(set) = hello.get_str("setName") {
            version = format!("{version} · replica set {set}");
        }
    }
    Ok(ServerInfo {
        product: "MongoDB".into(),
        version,
        round_trip_ms,
    })
}

#[async_trait]
impl Driver for MongoDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let client = connect(cfg).await?;
        server_info(&client).await
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let client = connect(cfg).await?;
        let info = server_info(&client).await?;
        let default_db = cfg
            .database
            .clone()
            .or_else(|| client.default_database().map(|d| d.name().to_string()));
        Ok(Box::new(MongoSession::new(
            client,
            info,
            default_db,
            cfg.read_only,
            cfg.query_timeout_secs.map(Duration::from_secs),
        )))
    }

    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        let client = connect(cfg).await?;
        server_info(&client).await?;
        Ok(MetaPool::new(Arc::new(client)))
    }

    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        let client = pool.downcast::<Arc<Client>>()?;
        let Some(last) = path.last() else {
            let mut names = client
                .list_database_names()
                .authorized_databases(true)
                .await
                .map_err(map_err)?;
            names.sort();
            return Ok(names
                .into_iter()
                .map(|n| TreeNode::new(path, NodeKind::Database, n, true))
                .collect());
        };
        if last.kind != NodeKind::Database {
            return Ok(vec![]);
        }
        let db = client.database(&last.name);
        let mut cursor = db.list_collections().await.map_err(map_err)?;
        let mut out = Vec::new();
        while cursor.advance().await.map_err(map_err)? {
            let spec = cursor.deserialize_current().map_err(map_err)?;
            let is_view = matches!(spec.collection_type, mongodb::results::CollectionType::View);
            if spec.name.starts_with("system.") {
                continue;
            }
            let kind = if is_view {
                NodeKind::View
            } else {
                NodeKind::Table
            };
            let mut node = TreeNode::new(path, kind, spec.name.clone(), false);
            if !is_view {
                if let Ok(n) = db
                    .collection::<mongodb::bson::Document>(&spec.name)
                    .estimated_document_count()
                    .await
                {
                    node = node.with_detail(format_count(n as i64));
                }
            }
            out.push(node);
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        let nodes = self
            .introspect(pool, &NodePath::root().child(NodeKind::Database, db))
            .await?;
        Ok(SchemaSnapshot {
            schemas: vec![SnapshotSchema {
                name: db.to_string(),
                tables: nodes
                    .into_iter()
                    .map(|n| SnapshotTable {
                        name: n.name,
                        kind: n.kind,
                        columns: vec![],
                    })
                    .collect(),
                functions: vec![],
            }],
        })
    }
}
