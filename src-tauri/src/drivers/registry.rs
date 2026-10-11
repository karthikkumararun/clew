use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use serde::Serialize;

use super::{Driver, DriverError, DriverFamily, DriverMeta, DriverResult};

/// Compiled-in drivers by id. The seam for a future plugin system.
#[derive(Default)]
pub struct Registry {
    drivers: HashMap<&'static str, Arc<dyn Driver>>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DriverGroup {
    pub family: DriverFamily,
    pub drivers: Vec<DriverMeta>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every driver this build ships.
    pub fn with_defaults() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(super::postgres::PostgresDriver::new()));
        r.register(Arc::new(super::mysql::MysqlDriver::mysql()));
        r.register(Arc::new(super::mysql::MysqlDriver::mariadb()));
        r.register(Arc::new(super::sqlite::SqliteDriver::new()));
        r.register(Arc::new(super::duckdb::DuckDbDriver::new()));
        r.register(Arc::new(super::clickhouse::ClickHouseDriver::new()));
        r.register(Arc::new(super::mssql::MsSqlDriver::new()));
        r.register(Arc::new(super::oracle::OracleDriver::new()));
        r.register(Arc::new(super::mongodb::MongoDriver::new()));
        r.register(Arc::new(super::redis::RedisDriver::new()));
        r
    }

    pub fn register(&mut self, driver: Arc<dyn Driver>) {
        self.drivers.insert(driver.meta().id, driver);
    }

    /// `driver_unavailable` for ids this build does not know.
    pub fn get(&self, id: &str) -> DriverResult<Arc<dyn Driver>> {
        self.drivers
            .get(id)
            .cloned()
            .ok_or_else(|| DriverError::driver_unavailable(id))
    }

    /// Drivers grouped by family (SQL, document, key-value, graph), sorted by name in each group.
    pub fn list_grouped(&self) -> Vec<DriverGroup> {
        let mut groups: Vec<DriverGroup> = Vec::new();
        for family in [
            DriverFamily::Sql,
            DriverFamily::Document,
            DriverFamily::Keyvalue,
            DriverFamily::Graph,
        ] {
            let mut drivers: Vec<DriverMeta> = self
                .drivers
                .values()
                .map(|d| d.meta().clone())
                .filter(|m| m.family == family)
                .collect();
            if drivers.is_empty() {
                continue;
            }
            drivers.sort_by_key(|m| m.name);
            groups.push(DriverGroup { family, drivers });
        }
        groups
    }
}

impl fmt::Debug for Registry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut ids: Vec<_> = self.drivers.keys().collect();
        ids.sort();
        f.debug_struct("Registry").field("drivers", &ids).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::{
        Capabilities, ErrorCode, FormKind, MetaPool, NodePath, ResolvedConfig, SchemaSnapshot,
        ServerInfo, Session, TreeNode,
    };
    use async_trait::async_trait;

    struct Fake(DriverMeta);

    fn meta(id: &'static str, name: &'static str, family: DriverFamily) -> DriverMeta {
        DriverMeta {
            id,
            name,
            badge: "XX",
            color_token: "--drv-postgres",
            family,
            default_port: None,
            form: FormKind::Network,
            dialect: None,
            capabilities: Capabilities::default(),
        }
    }

    #[async_trait]
    impl Driver for Fake {
        fn meta(&self) -> &DriverMeta {
            &self.0
        }
        async fn test(&self, _: &ResolvedConfig) -> DriverResult<ServerInfo> {
            Err(DriverError::unsupported("test"))
        }
        async fn open(&self, _: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
            Err(DriverError::unsupported("open"))
        }
        async fn open_meta_pool(&self, _: &ResolvedConfig) -> DriverResult<MetaPool> {
            Err(DriverError::unsupported("pool"))
        }
        async fn introspect(&self, _: &MetaPool, _: &NodePath) -> DriverResult<Vec<TreeNode>> {
            Ok(vec![])
        }
        async fn completion_snapshot(&self, _: &MetaPool, _: &str) -> DriverResult<SchemaSnapshot> {
            Ok(SchemaSnapshot::default())
        }
    }

    fn fake_registry() -> Registry {
        let mut r = Registry::new();
        for (id, name, fam) in [
            ("redis", "Redis", DriverFamily::Keyvalue),
            ("sqlite", "SQLite", DriverFamily::Sql),
            ("postgres", "PostgreSQL", DriverFamily::Sql),
            ("mongodb", "MongoDB", DriverFamily::Document),
        ] {
            r.register(Arc::new(Fake(meta(id, name, fam))));
        }
        r
    }

    #[test]
    fn lists_drivers_grouped_by_family_in_a_stable_order() {
        let groups = fake_registry().list_grouped();
        let families: Vec<_> = groups.iter().map(|g| g.family).collect();
        assert_eq!(
            families,
            [
                DriverFamily::Sql,
                DriverFamily::Document,
                DriverFamily::Keyvalue
            ]
        );
        let sql: Vec<_> = groups[0].drivers.iter().map(|m| m.name).collect();
        assert_eq!(sql, ["PostgreSQL", "SQLite"]);
    }

    #[test]
    fn unknown_driver_is_driver_unavailable_and_names_it() {
        let err = fake_registry().get("oracle").err().unwrap();
        assert_eq!(err.code, ErrorCode::DriverUnavailable);
        assert!(err.message.contains("oracle"));
    }

    #[test]
    fn known_driver_is_found() {
        assert!(fake_registry().get("sqlite").is_ok());
    }

    #[test]
    fn default_registry_ships_postgres_mysql_mariadb_and_sqlite() {
        let r = Registry::with_defaults();
        for id in ["postgres", "mysql", "mariadb", "sqlite"] {
            assert!(r.get(id).is_ok(), "{id} missing");
        }
        let groups = r.list_grouped();
        let families: Vec<_> = groups.iter().map(|g| g.family).collect();
        assert_eq!(
            families,
            [
                DriverFamily::Sql,
                DriverFamily::Document,
                DriverFamily::Keyvalue
            ]
        );
        assert_eq!(groups[1].drivers[0].id, "mongodb");
        assert_eq!(groups[2].drivers[0].id, "redis");
    }

    #[test]
    fn metadata_is_complete_for_each_shipped_driver() {
        let r = Registry::with_defaults();
        let pg = r.get("postgres").unwrap().meta().clone();
        assert_eq!(pg.badge, "PG");
        assert_eq!(pg.default_port, Some(5432));
        let sq = r.get("sqlite").unwrap().meta().clone();
        assert_eq!(sq.form, FormKind::File);
        assert_eq!(sq.default_port, None);
        assert_eq!(r.get("mysql").unwrap().meta().default_port, Some(3306));
        assert_eq!(r.get("mariadb").unwrap().meta().badge, "MA");
    }

    #[test]
    fn metadata_serializes_for_the_frontend() {
        let json = serde_json::to_value(Registry::with_defaults().list_grouped()).unwrap();
        assert_eq!(json[0]["family"], "sql");
        assert_eq!(json[0]["drivers"][0]["capabilities"]["cancel"], true);
    }
}
