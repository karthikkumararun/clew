use async_trait::async_trait;

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, FormKind,
    MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, TreeNode,
};

const META: DriverMeta = DriverMeta {
    id: "postgres",
    name: "PostgreSQL",
    badge: "PG",
    color_token: "--drv-postgres",
    family: DriverFamily::Sql,
    default_port: Some(5432),
    form: FormKind::Network,
    dialect: Some(Dialect::Postgresql),
    capabilities: Capabilities {
        transactions: true,
        cancel: true,
        explain: true,
        editable_results: true,
        schemas: true,
        multiple_databases: true,
    },
};

#[derive(Debug)]
pub struct PostgresDriver {
    meta: DriverMeta,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self { meta: META }
    }
}

impl Default for PostgresDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    fn meta(&self) -> &DriverMeta {
        &self.meta
    }

    async fn test(&self, _cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        Err(DriverError::unsupported("the PostgreSQL driver"))
    }

    async fn open(&self, _cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        Err(DriverError::unsupported("the PostgreSQL driver"))
    }

    async fn open_meta_pool(&self, _cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        Err(DriverError::unsupported("the PostgreSQL driver"))
    }

    async fn introspect(&self, _pool: &MetaPool, _path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        Err(DriverError::unsupported("the PostgreSQL driver"))
    }

    async fn completion_snapshot(
        &self,
        _pool: &MetaPool,
        _db: &str,
    ) -> DriverResult<SchemaSnapshot> {
        Err(DriverError::unsupported("the PostgreSQL driver"))
    }
}
