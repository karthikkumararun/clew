//! Lazy schema introspection for MySQL and MariaDB. The top level is the database (there are no
//! schemas below it), then object groups, objects, columns, keys and indexes.
//!
//! Every text column from `information_schema` is `CAST(... AS CHAR)`: MySQL 8 reports some of
//! them as VARBINARY, which sqlx will not decode as a string.

use std::collections::{BTreeMap, HashMap};

use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::{AssertSqlSafe, Executor, Row};

use super::error::map_error;
use crate::drivers::introspect::{
    ColumnInfo, NodeKind, NodePath, SchemaSnapshot, SnapshotColumn, SnapshotSchema, SnapshotTable,
    TreeNode,
};
use crate::drivers::postgres::introspect::format_count;
use crate::drivers::{DriverError, DriverResult, ErrorCode};

/// System databases are hidden from the tree and the completion snapshot.
const SYSTEM_DBS: &str = "'information_schema','mysql','performance_schema','sys'";

pub struct MyMeta {
    pool: MySqlPool,
    target: String,
}

impl MyMeta {
    pub async fn open(
        opts: sqlx::mysql::MySqlConnectOptions,
        target: String,
    ) -> DriverResult<Self> {
        let pool = MySqlPoolOptions::new()
            .max_connections(3)
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    // MySQL 8 caches table statistics for a day; row estimates should be fresh.
                    // MariaDB has no such variable, so a failure here is fine.
                    let _ = conn
                        .execute("SET SESSION information_schema_stats_expiry = 0")
                        .await;
                    Ok(())
                })
            })
            .connect_with(opts)
            .await
            .map_err(|e| map_error(e, &target, None))?;
        Ok(Self { pool, target })
    }

    fn err(&self, e: sqlx::Error) -> DriverError {
        map_error(e, &self.target, None)
    }
}

pub async fn children(meta: &MyMeta, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
    match path.0.last() {
        None => databases(meta, path).await,
        Some(seg) => {
            let db = path.find(NodeKind::Database);
            match (seg.kind, db) {
                (NodeKind::Database, _) => groups(meta, path, &seg.name).await,
                (NodeKind::Group, Some(db)) => members(meta, path, db, &seg.name).await,
                (NodeKind::Table | NodeKind::View, Some(db)) => {
                    table_children(meta, path, db, &seg.name).await
                }
                _ => Ok(vec![]),
            }
        }
    }
}

async fn databases(meta: &MyMeta, parent: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA \
         WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') \
         ORDER BY SCHEMA_NAME",
    )
    .fetch_all(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;
    Ok(names
        .into_iter()
        .map(|n| TreeNode::new(parent, NodeKind::Database, n, true))
        .collect())
}

async fn groups(meta: &MyMeta, parent: &NodePath, db: &str) -> DriverResult<Vec<TreeNode>> {
    let row = sqlx::query(
        "SELECT \
           (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'), \
           (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'VIEW'), \
           (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?), \
           (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?)",
    )
    .bind(db)
    .bind(db)
    .bind(db)
    .bind(db)
    .fetch_one(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;
    let counts: Vec<i64> = (0..4)
        .map(|i| row.try_get::<i64, _>(i).unwrap_or(0))
        .collect();
    Ok(["tables", "views", "routines", "triggers"]
        .into_iter()
        .zip(counts)
        .map(|(name, n)| {
            TreeNode::new(parent, NodeKind::Group, name, n > 0).with_detail(n.to_string())
        })
        .collect())
}

async fn members(
    meta: &MyMeta,
    parent: &NodePath,
    db: &str,
    group: &str,
) -> DriverResult<Vec<TreeNode>> {
    match group {
        "tables" => {
            let rows: Vec<(String, Option<u64>)> = sqlx::query_as(
                "SELECT CAST(TABLE_NAME AS CHAR), TABLE_ROWS FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
            )
            .bind(db)
            .fetch_all(&meta.pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(rows
                .into_iter()
                .map(|(name, est)| {
                    let node = TreeNode::new(parent, NodeKind::Table, name, true);
                    match est {
                        Some(n) => node.with_detail(format_count(n as i64)),
                        None => node,
                    }
                })
                .collect())
        }
        "views" => {
            let names: Vec<String> = sqlx::query_scalar(
                "SELECT CAST(TABLE_NAME AS CHAR) FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'VIEW' ORDER BY TABLE_NAME",
            )
            .bind(db)
            .fetch_all(&meta.pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(names
                .into_iter()
                .map(|n| TreeNode::new(parent, NodeKind::View, n, true))
                .collect())
        }
        "routines" => {
            let rows: Vec<(String, String)> = sqlx::query_as(
                "SELECT CAST(ROUTINE_NAME AS CHAR), CAST(ROUTINE_TYPE AS CHAR) \
                 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME",
            )
            .bind(db)
            .fetch_all(&meta.pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(rows
                .into_iter()
                .map(|(name, kind)| {
                    let k = if kind.eq_ignore_ascii_case("PROCEDURE") {
                        NodeKind::Procedure
                    } else {
                        NodeKind::Function
                    };
                    TreeNode::new(parent, k, name, false).with_detail(kind.to_lowercase())
                })
                .collect())
        }
        "triggers" => {
            let rows: Vec<(String, String, String, String)> = sqlx::query_as(
                "SELECT CAST(TRIGGER_NAME AS CHAR), CAST(ACTION_TIMING AS CHAR), \
                        CAST(EVENT_MANIPULATION AS CHAR), CAST(EVENT_OBJECT_TABLE AS CHAR) \
                 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
            )
            .bind(db)
            .fetch_all(&meta.pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(rows
                .into_iter()
                .map(|(name, timing, event, table)| {
                    TreeNode::new(parent, NodeKind::Trigger, name, false)
                        .with_detail(format!("{timing} {event} ON {table}"))
                })
                .collect())
        }
        other => Err(DriverError::new(
            ErrorCode::Unsupported,
            format!("Unknown object group \"{other}\""),
        )),
    }
}

#[allow(clippy::type_complexity)]
async fn table_children(
    meta: &MyMeta,
    parent: &NodePath,
    db: &str,
    table: &str,
) -> DriverResult<Vec<TreeNode>> {
    let columns: Vec<(String, String, String, Option<String>, String, Option<String>)> =
        sqlx::query_as(
            "SELECT CAST(c.COLUMN_NAME AS CHAR), CAST(c.COLUMN_TYPE AS CHAR), \
                    CAST(c.IS_NULLABLE AS CHAR), CAST(c.COLUMN_DEFAULT AS CHAR), \
                    CAST(c.COLUMN_KEY AS CHAR), \
                    (SELECT CAST(CONCAT(k.REFERENCED_TABLE_NAME, '.', k.REFERENCED_COLUMN_NAME) AS CHAR) \
                       FROM information_schema.KEY_COLUMN_USAGE k \
                      WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
                        AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL \
                      LIMIT 1) \
             FROM information_schema.COLUMNS c \
             WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION",
        )
        .bind(db)
        .bind(table)
        .fetch_all(&meta.pool)
        .await
        .map_err(|e| meta.err(e))?;

    let mut nodes: Vec<TreeNode> = columns
        .into_iter()
        .map(|(name, ty, nullable, default, key, fk)| {
            let detail = match &fk {
                Some(target) => format!("{ty} → {target}"),
                None => ty.clone(),
            };
            let mut node = TreeNode::new(parent, NodeKind::Column, name, false).with_detail(detail);
            node.column = Some(ColumnInfo {
                type_name: ty,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key: key == "PRI",
                foreign_key: fk,
            });
            node
        })
        .collect();

    let indexes: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT CAST(INDEX_NAME AS CHAR), \
                CAST(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS CHAR), \
                CAST(MAX(NON_UNIQUE) AS SIGNED) \
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         GROUP BY INDEX_NAME ORDER BY INDEX_NAME",
    )
    .bind(db)
    .bind(table)
    .fetch_all(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;

    let fks: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT CAST(k.CONSTRAINT_NAME AS CHAR), \
                CAST(GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS CHAR), \
                CAST(k.REFERENCED_TABLE_NAME AS CHAR), \
                CAST(GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS CHAR) \
         FROM information_schema.KEY_COLUMN_USAGE k \
         WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
         GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME ORDER BY k.CONSTRAINT_NAME",
    )
    .bind(db)
    .bind(table)
    .fetch_all(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;

    for (name, cols, _) in indexes.iter().filter(|(n, _, _)| n == "PRIMARY") {
        nodes.push(
            TreeNode::new(parent, NodeKind::PrimaryKey, name.clone(), false)
                .with_detail(format!("({cols})")),
        );
    }
    for (name, cols, ref_table, ref_cols) in fks {
        nodes.push(
            TreeNode::new(parent, NodeKind::ForeignKey, name, false)
                .with_detail(format!("({cols}) → {ref_table}({ref_cols})")),
        );
    }
    for (name, cols, non_unique) in indexes.into_iter().filter(|(n, _, _)| n != "PRIMARY") {
        let unique = if non_unique == 0 { "unique " } else { "" };
        nodes.push(
            TreeNode::new(parent, NodeKind::Index, name, false)
                .with_detail(format!("{unique}({cols})")),
        );
    }
    Ok(nodes)
}

/// `SHOW CREATE ...` for the object at `path`.
pub async fn ddl(meta: &MyMeta, path: &NodePath) -> DriverResult<String> {
    let seg = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    let db = path
        .find(NodeKind::Database)
        .ok_or_else(|| DriverError::internal("The object is not inside a database"))?;
    let q = |s: &str| format!("`{}`", s.replace('`', "``"));
    let (sql, column) = match seg.kind {
        NodeKind::Table => (format!("SHOW CREATE TABLE {}.{}", q(db), q(&seg.name)), 1),
        NodeKind::View => (format!("SHOW CREATE VIEW {}.{}", q(db), q(&seg.name)), 1),
        NodeKind::Function => (
            format!("SHOW CREATE FUNCTION {}.{}", q(db), q(&seg.name)),
            2,
        ),
        NodeKind::Procedure => (
            format!("SHOW CREATE PROCEDURE {}.{}", q(db), q(&seg.name)),
            2,
        ),
        NodeKind::Trigger => (format!("SHOW CREATE TRIGGER {}.{}", q(db), q(&seg.name)), 2),
        _ => return Err(DriverError::unsupported("DDL for this kind of object")),
    };
    // identifiers are quoted above; SHOW statements take no bind parameters
    let row = sqlx::raw_sql(AssertSqlSafe(sql))
        .fetch_one(&meta.pool)
        .await
        .map_err(|e| meta.err(e))?;
    let bytes: Option<Vec<u8>> = row.try_get_unchecked(column).map_err(|e| meta.err(e))?;
    Ok(bytes
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default())
}

#[allow(clippy::type_complexity)]
pub async fn snapshot(meta: &MyMeta, db: &str) -> DriverResult<SchemaSnapshot> {
    let filter = if db.is_empty() {
        format!("c.TABLE_SCHEMA NOT IN ({SYSTEM_DBS})")
    } else {
        "c.TABLE_SCHEMA = ?".to_string()
    };
    let sql = format!(
        "SELECT CAST(c.TABLE_SCHEMA AS CHAR), CAST(c.TABLE_NAME AS CHAR), CAST(t.TABLE_TYPE AS CHAR), \
                CAST(c.COLUMN_NAME AS CHAR), CAST(c.COLUMN_TYPE AS CHAR) \
         FROM information_schema.COLUMNS c \
         JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
         WHERE {filter} ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION"
    );
    // `filter` holds only constants and a placeholder, never caller data
    let mut query =
        sqlx::query_as::<_, (String, String, String, String, String)>(AssertSqlSafe(sql));
    if !db.is_empty() {
        query = query.bind(db);
    }
    let rows = query.fetch_all(&meta.pool).await.map_err(|e| meta.err(e))?;

    let mut routines_sql = String::from(
        "SELECT CAST(ROUTINE_SCHEMA AS CHAR), CAST(ROUTINE_NAME AS CHAR) FROM information_schema.ROUTINES WHERE ",
    );
    routines_sql.push_str(&if db.is_empty() {
        format!("ROUTINE_SCHEMA NOT IN ({SYSTEM_DBS})")
    } else {
        "ROUTINE_SCHEMA = ?".to_string()
    });
    routines_sql.push_str(" ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME");
    let mut rq = sqlx::query_as::<_, (String, String)>(AssertSqlSafe(routines_sql));
    if !db.is_empty() {
        rq = rq.bind(db);
    }
    let routines = rq.fetch_all(&meta.pool).await.map_err(|e| meta.err(e))?;

    // Empty databases still belong in the snapshot.
    let mut schema_sql =
        String::from("SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA WHERE ");
    schema_sql.push_str(&if db.is_empty() {
        format!("SCHEMA_NAME NOT IN ({SYSTEM_DBS})")
    } else {
        "SCHEMA_NAME = ?".to_string()
    });
    let mut sq = sqlx::query_scalar::<_, String>(AssertSqlSafe(schema_sql));
    if !db.is_empty() {
        sq = sq.bind(db);
    }
    let names = sq.fetch_all(&meta.pool).await.map_err(|e| meta.err(e))?;

    let mut by_schema: BTreeMap<String, SnapshotSchema> = names
        .into_iter()
        .map(|name| {
            (
                name.clone(),
                SnapshotSchema {
                    name,
                    tables: vec![],
                    functions: vec![],
                },
            )
        })
        .collect();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    for (schema, table, table_type, column, ty) in rows {
        let Some(s) = by_schema.get_mut(&schema) else {
            continue;
        };
        let idx = *index
            .entry((schema.clone(), table.clone()))
            .or_insert_with(|| {
                let kind = if table_type == "VIEW" {
                    NodeKind::View
                } else {
                    NodeKind::Table
                };
                s.tables.push(SnapshotTable {
                    name: table.clone(),
                    kind,
                    columns: vec![],
                });
                s.tables.len() - 1
            });
        s.tables[idx].columns.push(SnapshotColumn {
            name: column,
            type_name: ty,
        });
    }
    for (schema, name) in routines {
        if let Some(s) = by_schema.get_mut(&schema) {
            s.functions.push(name);
        }
    }
    Ok(SchemaSnapshot {
        schemas: by_schema.into_values().collect(),
    })
}
