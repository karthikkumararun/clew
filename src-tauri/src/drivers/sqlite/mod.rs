use async_trait::async_trait;

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, FormKind,
    MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, TreeNode,
};

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
        multiple_databases: false,
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

#[async_trait]
impl Driver for SqliteDriver {
    fn meta(&self) -> &DriverMeta {
        &self.meta
    }

    async fn test(&self, _cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        Err(DriverError::unsupported("the SQLite driver"))
    }

    async fn open(&self, _cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        Err(DriverError::unsupported("the SQLite driver"))
    }

    async fn open_meta_pool(&self, _cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        Err(DriverError::unsupported("the SQLite driver"))
    }

    async fn introspect(&self, _pool: &MetaPool, _path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        Err(DriverError::unsupported("the SQLite driver"))
    }

    async fn completion_snapshot(
        &self,
        _pool: &MetaPool,
        _db: &str,
    ) -> DriverResult<SchemaSnapshot> {
        Err(DriverError::unsupported("the SQLite driver"))
    }
}
