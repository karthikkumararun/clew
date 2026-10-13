//! The Neo4j driver: Bolt 5.x and 4.4 (Neo4j 4.4 LTS, 5.x and AuraDB), `bolt://`, `bolt+s://`,
//! `neo4j://` (cluster routing) and `neo4j+s://`, multiple databases, Cypher with READ and
//! WRITE transactions, streaming and cancel.

pub mod bolt;
pub mod convert;
#[cfg(test)]
mod fake;
pub mod meta;
pub mod plan;
#[cfg(test)]
mod server_tests;
pub mod session;

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::drivers::graph::GraphSchema;
use crate::drivers::introspect::{
    NodeKind, NodePath, SchemaSnapshot, SnapshotSchema, SnapshotTable, TreeNode,
};
use crate::drivers::{
    Capabilities, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, ErrorCode, FormKind,
    MetaPool, ResolvedConfig, ServerInfo, Session, Target, TlsConfig, TlsMode,
};
use bolt::{Client, ConnectOpts, Ps};
use meta::Neo4jMeta;
use session::Neo4jSession;

/// Group names under a database in the explorer.
pub const GROUP_LABELS: &str = "Node labels";
pub const GROUP_TYPES: &str = "Relationship types";
pub const GROUP_INDEXES: &str = "Indexes";

const META: DriverMeta = DriverMeta {
    id: "neo4j",
    name: "Neo4j",
    badge: "N4",
    color_token: "--drv-neo4j",
    family: DriverFamily::Graph,
    default_port: Some(7687),
    form: FormKind::Network,
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
pub struct Neo4jDriver;

impl Neo4jDriver {
    pub fn new() -> Self {
        Self
    }
}

/// How the scheme (`neo4j`, `neo4j+s`, `neo4j+ssc`, `bolt`, `bolt+s`, `bolt+ssc`) turns into
/// routing and TLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scheme {
    pub routing: bool,
    /// `None`: the connection's own TLS settings decide.
    pub tls: Option<SchemeTls>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemeTls {
    /// `+s`: verify the server certificate.
    Verify,
    /// `+ssc`: encrypt, accept a self-signed certificate.
    SelfSigned,
}

pub fn parse_scheme(protocol: &str) -> DriverResult<Scheme> {
    let (base, suffix) = match protocol.split_once('+') {
        Some((b, s)) => (b, Some(s)),
        None => (protocol, None),
    };
    let routing = match base.to_ascii_lowercase().as_str() {
        "neo4j" => true,
        "bolt" => false,
        _ => {
            return Err(DriverError::new(
                ErrorCode::QueryFailed,
                format!(
                    "\"{protocol}\" is not a Neo4j protocol (use neo4j, neo4j+s, bolt or bolt+s)"
                ),
            ))
        }
    };
    let tls = match suffix.map(str::to_ascii_lowercase).as_deref() {
        None => None,
        Some("s") => Some(SchemeTls::Verify),
        Some("ssc") => Some(SchemeTls::SelfSigned),
        Some(_) => {
            return Err(DriverError::new(
                ErrorCode::QueryFailed,
                format!(
                    "\"{protocol}\" is not a Neo4j protocol (use neo4j, neo4j+s, bolt or bolt+s)"
                ),
            ))
        }
    };
    Ok(Scheme { routing, tls })
}

/// The TLS options a connection really uses: `+s` verifies the certificate (CA file and client
/// certificate from the connection's TLS settings still apply), `+ssc` accepts any, and a plain
/// scheme follows the connection's TLS mode.
pub fn effective_tls(scheme: Scheme, tls: &TlsConfig) -> TlsConfig {
    let mut out = tls.clone();
    match scheme.tls {
        Some(SchemeTls::Verify) => {
            if !matches!(out.mode, TlsMode::VerifyCa | TlsMode::VerifyFull) {
                out.mode = TlsMode::VerifyFull;
            }
        }
        Some(SchemeTls::SelfSigned) => out.mode = TlsMode::Require,
        None => {}
    }
    out
}

pub(crate) fn connect_opts(cfg: &ResolvedConfig) -> DriverResult<ConnectOpts> {
    let Target::Network { host, port } = &cfg.target else {
        return Err(DriverError::internal("Neo4j connections are host and port"));
    };
    let protocol = cfg
        .options
        .get("neo4j.protocol")
        .map(String::as_str)
        .unwrap_or("bolt");
    let mut scheme = parse_scheme(protocol)?;
    // Through an SSH tunnel the cluster's own addresses are not reachable: talk to one server.
    if cfg.ssh.is_some() {
        scheme.routing = false;
    }
    let tls = crate::transport::tls::client_config(&effective_tls(scheme, &cfg.tls))?;
    let address = bolt::conn::address(host, *port);
    Ok(ConnectOpts {
        host: host.clone(),
        port: *port,
        user: cfg
            .user
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "neo4j".into()),
        password: cfg
            .password
            .as_ref()
            .map(|p| p.expose().to_string())
            .unwrap_or_default(),
        tls,
        routing: scheme
            .routing
            .then(|| vec![("address".to_string(), Ps::Str(address))]),
        timeout: Duration::from_secs(cfg.connect_timeout_secs.max(1)),
    })
}

fn database_of(cfg: &ResolvedConfig) -> Option<String> {
    cfg.database.clone().filter(|d| !d.trim().is_empty())
}

/// Connect once to learn the server and, for routed schemes, how big the cluster is.
async fn handshake(client: &mut Client, db: Option<&str>) -> DriverResult<(ServerInfo, u8)> {
    let started = Instant::now();
    let conn = client
        .acquire(db, crate::drivers::graph::GraphAccess::Read)
        .await?;
    let round_trip_ms = started.elapsed().as_millis() as u64;
    let product = conn
        .server
        .split_once('/')
        .map_or("Neo4j", |(p, _)| p)
        .to_string();
    let mut version = conn.server_version();
    let major = conn.version.0;
    client.release(conn);
    if client.routed() {
        if let Ok(table) = client.table(db, false).await {
            let members = table.members();
            if members > 1 {
                version = format!("{version} · cluster ({members} members)");
            }
        }
    }
    Ok((
        ServerInfo {
            product,
            version,
            round_trip_ms,
        },
        major,
    ))
}

fn format_count(n: i64) -> String {
    match n {
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 10_000 => format!("{}k", n / 1000),
        n if n >= 1_000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

#[async_trait]
impl Driver for Neo4jDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }

    async fn test(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let mut client = Client::new(connect_opts(cfg)?);
        let result = handshake(&mut client, database_of(cfg).as_deref()).await;
        client.close().await;
        Ok(result?.0)
    }

    async fn open(&self, cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        let mut client = Client::new(connect_opts(cfg)?);
        let db = database_of(cfg);
        let (info, major) = match handshake(&mut client, db.as_deref()).await {
            Ok(v) => v,
            Err(e) => {
                client.close().await;
                return Err(e);
            }
        };
        Ok(Box::new(Neo4jSession::new(
            client,
            info,
            db,
            major,
            cfg.read_only,
            cfg.query_timeout_secs.map(Duration::from_secs),
        )))
    }

    async fn open_meta_pool(&self, cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        let mut client = Client::new(connect_opts(cfg)?);
        let db = database_of(cfg);
        if let Err(e) = handshake(&mut client, db.as_deref()).await {
            client.close().await;
            return Err(e);
        }
        Ok(MetaPool::new(Arc::new(Neo4jMeta {
            client: Mutex::new(client),
            default_db: db,
        })))
    }

    /// Root: databases. Database: Node labels, Relationship types, Indexes. Each group lists its
    /// members (labels and relationship types with their counts).
    async fn introspect(&self, pool: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        let meta = pool.downcast::<Arc<Neo4jMeta>>()?;
        let Some(last) = path.last() else {
            return Ok(meta
                .databases()
                .await?
                .into_iter()
                .map(|n| TreeNode::new(path, NodeKind::Database, n, true))
                .collect());
        };
        match last.kind {
            NodeKind::Database => Ok([GROUP_LABELS, GROUP_TYPES, GROUP_INDEXES]
                .into_iter()
                .map(|g| TreeNode::new(path, NodeKind::Group, g, true))
                .collect()),
            NodeKind::Group => {
                let db = path.find(NodeKind::Database);
                Ok(match last.name.as_str() {
                    GROUP_LABELS => meta
                        .label_counts(db)
                        .await?
                        .into_iter()
                        .map(|c| {
                            TreeNode::new(path, NodeKind::Table, c.name, false)
                                .with_detail(format_count(c.count))
                        })
                        .collect(),
                    GROUP_TYPES => meta
                        .relationship_type_counts(db)
                        .await?
                        .into_iter()
                        .map(|c| {
                            TreeNode::new(path, NodeKind::Type, c.name, false)
                                .with_detail(format_count(c.count))
                        })
                        .collect(),
                    GROUP_INDEXES => meta
                        .indexes(db)
                        .await?
                        .into_iter()
                        .map(|i| {
                            let detail = format!(
                                "{} ({})",
                                i.kind,
                                [i.labels.join("|"), i.properties.join(", ")].join(" ")
                            );
                            TreeNode::new(path, NodeKind::Index, i.name, false).with_detail(detail)
                        })
                        .collect(),
                    _ => vec![],
                })
            }
            _ => Ok(vec![]),
        }
    }

    /// Labels become tables (so the generic completion offers them); relationship types, property
    /// keys, functions and procedures travel in `graph` and `functions`.
    async fn completion_snapshot(&self, pool: &MetaPool, db: &str) -> DriverResult<SchemaSnapshot> {
        let meta = pool.downcast::<Arc<Neo4jMeta>>()?;
        let schema = meta.schema(Some(db).filter(|d| !d.is_empty())).await?;
        let tables = schema
            .labels
            .iter()
            .map(|l| SnapshotTable {
                name: l.name.clone(),
                kind: NodeKind::Table,
                columns: vec![],
            })
            .collect();
        let mut functions = schema.functions.clone().unwrap_or_default();
        functions.extend(schema.procedures.iter().flatten().cloned());
        Ok(SchemaSnapshot {
            schemas: vec![SnapshotSchema {
                name: db.to_string(),
                tables,
                functions,
            }],
            graph: Some(schema),
        })
    }

    async fn graph_schema(
        &self,
        pool: &MetaPool,
        database: Option<&str>,
    ) -> DriverResult<GraphSchema> {
        pool.downcast::<Arc<Neo4jMeta>>()?.schema(database).await
    }

    async fn graph_databases(&self, pool: &MetaPool) -> DriverResult<Vec<String>> {
        pool.downcast::<Arc<Neo4jMeta>>()?.databases().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::Secret;

    fn cfg(protocol: Option<&str>) -> ResolvedConfig {
        ResolvedConfig {
            driver: "neo4j".into(),
            target: Target::Network {
                host: "graph.example.com".into(),
                port: 7687,
            },
            user: Some("neo4j".into()),
            password: Some(Secret::new("pw")),
            database: None,
            ssh: None,
            tls: TlsConfig::default(),
            connect_timeout_secs: 5,
            query_timeout_secs: None,
            read_only: false,
            options: protocol
                .map(|p| [("neo4j.protocol".to_string(), p.to_string())].into())
                .unwrap_or_default(),
            on_connect: vec![],
            isolation: None,
        }
    }

    /// (spec: driver-framework › Neo4j driver)
    #[test]
    fn the_four_schemes_choose_routing_and_tls() {
        for (protocol, routing, tls) in [
            ("neo4j", true, None),
            ("neo4j+s", true, Some(SchemeTls::Verify)),
            ("neo4j+ssc", true, Some(SchemeTls::SelfSigned)),
            ("bolt", false, None),
            ("bolt+s", false, Some(SchemeTls::Verify)),
            ("bolt+ssc", false, Some(SchemeTls::SelfSigned)),
            ("BOLT+S", false, Some(SchemeTls::Verify)),
        ] {
            let s = parse_scheme(protocol).unwrap();
            assert_eq!((s.routing, s.tls), (routing, tls), "{protocol}");
        }
        for bad in ["http", "neo4j+x", "", "mongodb"] {
            assert!(parse_scheme(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn plus_s_verifies_the_certificate_even_when_the_form_says_require() {
        let verify = parse_scheme("neo4j+s").unwrap();
        let from_url = TlsConfig {
            mode: TlsMode::Require,
            ..Default::default()
        };
        assert_eq!(effective_tls(verify, &from_url).mode, TlsMode::VerifyFull);
        let ca = TlsConfig {
            mode: TlsMode::VerifyCa,
            ca_file: Some("ca.pem".into()),
            ..Default::default()
        };
        assert_eq!(effective_tls(verify, &ca).mode, TlsMode::VerifyCa);
        assert_eq!(
            effective_tls(parse_scheme("bolt+ssc").unwrap(), &TlsConfig::default()).mode,
            TlsMode::Require
        );
        assert_eq!(
            effective_tls(parse_scheme("bolt").unwrap(), &TlsConfig::default()).mode,
            TlsMode::Disable
        );
        assert_eq!(
            effective_tls(parse_scheme("bolt").unwrap(), &from_url).mode,
            TlsMode::Require
        );
    }

    #[test]
    fn options_come_from_the_resolved_config() {
        let direct = connect_opts(&cfg(Some("bolt"))).unwrap();
        assert!(direct.routing.is_none() && direct.tls.is_none());
        assert_eq!(direct.address(), "graph.example.com:7687");

        let routed = connect_opts(&cfg(Some("neo4j"))).unwrap();
        let ctx = Ps::Map(routed.routing.clone().unwrap());
        assert_eq!(
            ctx.get("address").and_then(Ps::as_str),
            Some("graph.example.com:7687")
        );

        // no protocol recorded: a plain direct connection
        assert!(connect_opts(&cfg(None)).unwrap().routing.is_none());

        let aura = connect_opts(&cfg(Some("neo4j+s"))).unwrap();
        assert!(aura.tls.is_some() && aura.routing.is_some());

        // an SSH tunnel cannot reach the cluster's own addresses
        let mut tunnelled = cfg(Some("neo4j"));
        tunnelled.ssh = Some(crate::drivers::SshConfig {
            host: "bastion".into(),
            port: 22,
            user: "u".into(),
            auth: crate::drivers::SshAuth::Agent,
        });
        assert!(connect_opts(&tunnelled).unwrap().routing.is_none());
    }

    #[test]
    fn user_defaults_to_neo4j_and_the_password_is_carried() {
        let mut c = cfg(None);
        c.user = None;
        let opts = connect_opts(&c).unwrap();
        assert_eq!(opts.user, "neo4j");
        assert_eq!(opts.password, "pw");
    }

    #[test]
    fn counts_are_shortened_for_the_explorer() {
        assert_eq!(format_count(5), "5");
        assert_eq!(format_count(1_500), "1.5k");
        assert_eq!(format_count(25_000), "25k");
        assert_eq!(format_count(2_500_000), "2.5M");
    }

    #[test]
    fn metadata_describes_the_graph_family() {
        let m = Neo4jDriver::new().meta().clone();
        assert_eq!((m.id, m.badge, m.default_port), ("neo4j", "N4", Some(7687)));
        assert_eq!(m.family, DriverFamily::Graph);
        assert!(m.capabilities.cancel && m.capabilities.explain);
    }
}
