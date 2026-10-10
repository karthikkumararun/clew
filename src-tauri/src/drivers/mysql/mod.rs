use async_trait::async_trait;

use crate::drivers::{
    Capabilities, Dialect, Driver, DriverError, DriverFamily, DriverMeta, DriverResult, FormKind,
    MetaPool, NodePath, ResolvedConfig, SchemaSnapshot, ServerInfo, Session, TreeNode,
};

const CAPS: Capabilities = Capabilities {
    transactions: true,
    cancel: true,
    explain: true,
    editable_results: true,
    schemas: false,
    multiple_databases: true,
};

const MYSQL: DriverMeta = DriverMeta {
    id: "mysql",
    name: "MySQL",
    badge: "MY",
    color_token: "--drv-mysql",
    family: DriverFamily::Sql,
    default_port: Some(3306),
    form: FormKind::Network,
    dialect: Some(Dialect::Mysql),
    capabilities: CAPS,
};

const MARIADB: DriverMeta = DriverMeta {
    id: "mariadb",
    name: "MariaDB",
    badge: "MA",
    color_token: "--drv-mariadb",
    family: DriverFamily::Sql,
    default_port: Some(3306),
    form: FormKind::Network,
    dialect: Some(Dialect::Mariadb),
    capabilities: CAPS,
};

#[derive(Debug)]
pub struct MysqlDriver {
    meta: DriverMeta,
}

impl MysqlDriver {
    pub fn mysql() -> Self {
        Self { meta: MYSQL }
    }

    pub fn mariadb() -> Self {
        Self { meta: MARIADB }
    }
}

#[async_trait]
impl Driver for MysqlDriver {
    fn meta(&self) -> &DriverMeta {
        &self.meta
    }

    async fn test(&self, _cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        Err(DriverError::unsupported("the MySQL/MariaDB driver"))
    }

    async fn open(&self, _cfg: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        Err(DriverError::unsupported("the MySQL/MariaDB driver"))
    }

    async fn open_meta_pool(&self, _cfg: &ResolvedConfig) -> DriverResult<MetaPool> {
        Err(DriverError::unsupported("the MySQL/MariaDB driver"))
    }

    async fn introspect(&self, _pool: &MetaPool, _path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        Err(DriverError::unsupported("the MySQL/MariaDB driver"))
    }

    async fn completion_snapshot(
        &self,
        _pool: &MetaPool,
        _db: &str,
    ) -> DriverResult<SchemaSnapshot> {
        Err(DriverError::unsupported("the MySQL/MariaDB driver"))
    }
}
