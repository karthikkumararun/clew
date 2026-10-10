//! Lazy schema introspection and the completion snapshot, through the metadata pool.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use tokio::sync::Mutex;

use super::ddl::{render_table, render_view, ColumnDef, TableDef};
use super::error::map_error;
use crate::drivers::introspect::{
    ColumnInfo, NodeKind, NodePath, SchemaSnapshot, SnapshotColumn, SnapshotSchema, SnapshotTable,
    TreeNode,
};
use crate::drivers::{DriverError, DriverResult, ErrorCode};

/// Metadata pools, one per database (PostgreSQL cannot query across databases). Each pool has at
/// most three connections.
pub struct PgMeta {
    base: PgConnectOptions,
    default_db: String,
    target: String,
    pools: Mutex<HashMap<String, PgPool>>,
}

impl PgMeta {
    pub async fn open(base: PgConnectOptions, target: String) -> DriverResult<Self> {
        let default_db = base
            .get_database()
            .unwrap_or(base.get_username())
            .to_string();
        let meta = Self {
            base,
            default_db,
            target,
            pools: Mutex::new(HashMap::new()),
        };
        meta.pool(None).await?; // connect eagerly so a bad config fails here
        Ok(meta)
    }

    async fn pool(&self, db: Option<&str>) -> DriverResult<PgPool> {
        let db = db.unwrap_or(&self.default_db).to_string();
        let mut pools = self.pools.lock().await;
        if let Some(p) = pools.get(&db) {
            return Ok(p.clone());
        }
        let pool = PgPoolOptions::new()
            .max_connections(3)
            .connect_with(self.base.clone().database(&db))
            .await
            .map_err(|e| map_error(e, &self.target))?;
        pools.insert(db, pool.clone());
        Ok(pool)
    }

    fn err(&self, e: sqlx::Error) -> DriverError {
        map_error(e, &self.target)
    }
}

/// `12.4k`, `3.2M`, `850`.
pub fn format_count(n: i64) -> String {
    match n {
        n if n >= 1_000_000_000 => format!("{:.1}B", n as f64 / 1e9),
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 1_000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

macro_rules! ns {
    () => {
        "(SELECT oid FROM pg_namespace WHERE nspname = $1)"
    };
}

pub async fn children(meta: &PgMeta, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let segs = &path.0;
    match segs.last() {
        None => databases(meta, path).await,
        Some(seg) => {
            let db = path.find(NodeKind::Database);
            let pool = meta.pool(db).await?;
            match seg.kind {
                NodeKind::Database => schemas(meta, &pool, path).await,
                NodeKind::Schema => groups(meta, &pool, path, &seg.name).await,
                NodeKind::Group => {
                    let schema = path
                        .find(NodeKind::Schema)
                        .ok_or_else(|| DriverError::internal("A group needs a schema"))?;
                    group_members(meta, &pool, path, schema, &seg.name).await
                }
                NodeKind::Table | NodeKind::View | NodeKind::MaterializedView => {
                    let schema = path
                        .find(NodeKind::Schema)
                        .ok_or_else(|| DriverError::internal("A table needs a schema"))?;
                    table_children(meta, &pool, path, schema, &seg.name).await
                }
                _ => Ok(vec![]),
            }
        }
    }
}

async fn databases(meta: &PgMeta, parent: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let pool = meta.pool(None).await?;
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT datname::text FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;
    Ok(names
        .into_iter()
        .map(|n| TreeNode::new(parent, NodeKind::Database, n, true))
        .collect())
}

async fn schemas(meta: &PgMeta, pool: &PgPool, parent: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let rows: Vec<(String, bool)> = sqlx::query_as(
        "SELECT n.nspname::text, has_schema_privilege(n.oid, 'USAGE') FROM pg_namespace n \
         WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY n.nspname",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| meta.err(e))?;
    Ok(rows
        .into_iter()
        .map(|(name, usable)| {
            let node = TreeNode::new(parent, NodeKind::Schema, name, usable);
            if usable {
                node
            } else {
                node.with_detail("access_denied")
            }
        })
        .collect())
}

async fn groups(
    meta: &PgMeta,
    pool: &PgPool,
    parent: &NodePath,
    schema: &str,
) -> DriverResult<Vec<TreeNode>> {
    let counts: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(concat!("SELECT \
           (SELECT count(*) FROM pg_class WHERE relnamespace = ", ns!(), " AND relkind IN ('r','p')), \
           (SELECT count(*) FROM pg_class WHERE relnamespace = ", ns!(), " AND relkind = 'v'), \
           (SELECT count(*) FROM pg_class WHERE relnamespace = ", ns!(), " AND relkind = 'm'), \
           (SELECT count(*) FROM pg_proc WHERE pronamespace = ", ns!(), " AND prokind IN ('f','p')), \
           (SELECT count(*) FROM pg_class WHERE relnamespace = ", ns!(), " AND relkind = 'S'), \
           (SELECT count(*) FROM pg_type t WHERE t.typnamespace = ", ns!(), " AND (t.typtype IN ('e','d') \
              OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))))"))
    .bind(schema)
    .fetch_one(pool)
    .await
    .map_err(|e| meta.err(e))?;
    let entries = [
        ("tables", counts.0),
        ("views", counts.1),
        ("materialized views", counts.2),
        ("functions", counts.3),
        ("sequences", counts.4),
        ("types", counts.5),
    ];
    Ok(entries
        .into_iter()
        .map(|(name, n)| {
            TreeNode::new(parent, NodeKind::Group, name, n > 0).with_detail(n.to_string())
        })
        .collect())
}

async fn group_members(
    meta: &PgMeta,
    pool: &PgPool,
    parent: &NodePath,
    schema: &str,
    group: &str,
) -> DriverResult<Vec<TreeNode>> {
    match group {
        "tables" => {
            let rows: Vec<(String, f32)> = sqlx::query_as(concat!(
                "SELECT relname::text, reltuples FROM pg_class \
                 WHERE relnamespace = ",
                ns!(),
                " AND relkind IN ('r','p') ORDER BY relname"
            ))
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(rows
                .into_iter()
                .map(|(name, est)| {
                    let node = TreeNode::new(parent, NodeKind::Table, name, true);
                    // reltuples is -1 until the table has been analyzed
                    if est >= 0.0 {
                        node.with_detail(format_count(est as i64))
                    } else {
                        node
                    }
                })
                .collect())
        }
        "views" | "materialized views" => {
            let (kind, relkind) = if group == "views" {
                (NodeKind::View, "v")
            } else {
                (NodeKind::MaterializedView, "m")
            };
            let names: Vec<String> = sqlx::query_scalar(concat!(
                "SELECT relname::text FROM pg_class WHERE relnamespace = ",
                ns!(),
                " AND relkind::text = $2 ORDER BY relname"
            ))
            .bind(schema)
            .bind(relkind)
            .fetch_all(pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(names
                .into_iter()
                .map(|n| TreeNode::new(parent, kind, n, true))
                .collect())
        }
        "functions" => {
            let rows: Vec<(String, String, String)> = sqlx::query_as(concat!(
                "SELECT proname::text, prokind::text, pg_get_function_identity_arguments(oid) \
                 FROM pg_proc WHERE pronamespace = ",
                ns!(),
                " AND prokind IN ('f','p') ORDER BY proname, oid"
            ))
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(rows
                .into_iter()
                .map(|(name, kind, args)| {
                    let k = if kind == "p" {
                        NodeKind::Procedure
                    } else {
                        NodeKind::Function
                    };
                    TreeNode::new(parent, k, name, false).with_detail(format!("({args})"))
                })
                .collect())
        }
        "sequences" => {
            let names: Vec<String> = sqlx::query_scalar(concat!(
                "SELECT relname::text FROM pg_class WHERE relnamespace = ",
                ns!(),
                " AND relkind = 'S' ORDER BY relname"
            ))
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(names
                .into_iter()
                .map(|n| TreeNode::new(parent, NodeKind::Sequence, n, false))
                .collect())
        }
        "types" => {
            let rows: Vec<(String, String)> = sqlx::query_as(concat!("SELECT t.typname::text, CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' ELSE 'composite' END \
                 FROM pg_type t WHERE t.typnamespace = ", ns!(), " AND (t.typtype IN ('e','d') \
                   OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))) \
                 ORDER BY t.typname"))
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(|e| meta.err(e))?;
            Ok(rows
                .into_iter()
                .map(|(n, d)| TreeNode::new(parent, NodeKind::Type, n, false).with_detail(d))
                .collect())
        }
        other => Err(DriverError::new(
            ErrorCode::Unsupported,
            format!("Unknown object group \"{other}\""),
        )),
    }
}

macro_rules! rel {
    () => {
        "(SELECT c.oid FROM pg_class c WHERE c.relname = $2 AND c.relnamespace = \
         (SELECT oid FROM pg_namespace WHERE nspname = $1))"
    };
}

#[allow(clippy::type_complexity)]
async fn table_children(
    meta: &PgMeta,
    pool: &PgPool,
    parent: &NodePath,
    schema: &str,
    table: &str,
) -> DriverResult<Vec<TreeNode>> {
    let columns: Vec<(String, String, bool, Option<String>, bool, Option<String>)> =
        sqlx::query_as(concat!("SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                    pg_get_expr(d.adbin, d.adrelid), \
                    COALESCE(a.attnum = ANY (pk.indkey::int2[]), false), \
                    (SELECT ft.relname::text || '.' || fa.attname::text \
                       FROM pg_constraint con \
                       JOIN pg_class ft ON ft.oid = con.confrelid \
                       JOIN pg_attribute fa ON fa.attrelid = con.confrelid \
                        AND fa.attnum = con.confkey[array_position(con.conkey, a.attnum)] \
                      WHERE con.contype = 'f' AND con.conrelid = a.attrelid AND a.attnum = ANY (con.conkey) \
                      LIMIT 1) \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             LEFT JOIN pg_index pk ON pk.indrelid = a.attrelid AND pk.indisprimary \
             WHERE a.attrelid = ", rel!(), " AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"))
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(|e| meta.err(e))?;

    let mut nodes: Vec<TreeNode> = columns
        .into_iter()
        .map(|(name, ty, nullable, default, pk, fk)| {
            let mut node =
                TreeNode::new(parent, NodeKind::Column, name, false).with_detail(match &fk {
                    Some(target) => format!("{ty} → {target}"),
                    None => ty.clone(),
                });
            node.column = Some(ColumnInfo {
                type_name: ty,
                nullable,
                default,
                primary_key: pk,
                foreign_key: fk,
            });
            node
        })
        .collect();

    let constraints: Vec<(String, String, String)> = sqlx::query_as(concat!(
        "SELECT conname::text, contype::text, pg_get_constraintdef(oid) FROM pg_constraint \
         WHERE conrelid = ",
        rel!(),
        " AND contype IN ('p','f') ORDER BY contype DESC, conname"
    ))
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| meta.err(e))?;
    for (name, kind, def) in constraints {
        let k = if kind == "p" {
            NodeKind::PrimaryKey
        } else {
            NodeKind::ForeignKey
        };
        nodes.push(TreeNode::new(parent, k, name, false).with_detail(def));
    }

    let indexes: Vec<(String, String, bool)> = sqlx::query_as(concat!("SELECT i.relname::text, regexp_replace(pg_get_indexdef(i.oid), '^.* USING ', ''), x.indisprimary \
         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = ", rel!(), " ORDER BY i.relname"))
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| meta.err(e))?;
    for (name, def, _) in indexes {
        nodes.push(TreeNode::new(parent, NodeKind::Index, name, false).with_detail(def));
    }
    Ok(nodes)
}

#[allow(clippy::type_complexity)]
pub async fn snapshot(meta: &PgMeta, db: &str) -> DriverResult<SchemaSnapshot> {
    let pool = meta.pool(Some(db)).await?;
    let schemas: Vec<String> = sqlx::query_scalar(
        "SELECT n.nspname::text FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' \
         AND n.nspname <> 'information_schema' AND has_schema_privilege(n.oid, 'USAGE') ORDER BY n.nspname",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    let rows: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text, a.attname::text, \
                format_type(a.atttypid, a.atttypmod) \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg\\_%' \
           AND n.nspname <> 'information_schema' AND has_schema_privilege(n.oid, 'USAGE') \
         ORDER BY n.nspname, c.relname, a.attnum",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    let functions: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT n.nspname::text, p.proname::text FROM pg_proc p \
         JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE p.prokind IN ('f','p') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
           AND has_schema_privilege(n.oid, 'USAGE') ORDER BY 1, 2",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    let mut by_schema: BTreeMap<String, SnapshotSchema> = schemas
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
    let mut table_index: HashMap<(String, String), usize> = HashMap::new();
    for (schema, table, relkind, column, ty) in rows {
        let Some(s) = by_schema.get_mut(&schema) else {
            continue;
        };
        let idx = *table_index
            .entry((schema.clone(), table.clone()))
            .or_insert_with(|| {
                let kind = match relkind.as_str() {
                    "v" => NodeKind::View,
                    "m" => NodeKind::MaterializedView,
                    _ => NodeKind::Table,
                };
                s.tables.push(SnapshotTable {
                    name: table.clone(),
                    kind,
                    columns: vec![],
                });
                s.tables.len() - 1
            });
        if let (Some(name), Some(type_name)) = (column, ty) {
            s.tables[idx]
                .columns
                .push(SnapshotColumn { name, type_name });
        }
    }
    for (schema, name) in functions {
        if let Some(s) = by_schema.get_mut(&schema) {
            s.functions.push(name);
        }
    }
    Ok(SchemaSnapshot {
        schemas: by_schema.into_values().collect(),
    })
}

#[allow(dead_code)]
fn _arc(_: Arc<PgMeta>) {}

fn schema_of(path: &NodePath) -> DriverResult<&str> {
    path.find(NodeKind::Schema)
        .ok_or_else(|| DriverError::internal("The object is not inside a schema"))
}

/// `CREATE` statement for a table, view or materialized view, built from the catalogue.
#[allow(clippy::type_complexity)]
pub async fn ddl(meta: &PgMeta, path: &NodePath) -> DriverResult<String> {
    let seg = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    if !matches!(
        seg.kind,
        NodeKind::Table | NodeKind::View | NodeKind::MaterializedView
    ) {
        return Err(DriverError::unsupported("DDL for this kind of object"));
    }
    let schema = schema_of(path)?;
    let table = seg.name.as_str();
    let pool = meta.pool(path.find(NodeKind::Database)).await?;

    let kind: Option<String> = sqlx::query_scalar(concat!(
        "SELECT c.relkind::text FROM pg_class c WHERE c.oid = ",
        rel!()
    ))
    .bind(schema)
    .bind(table)
    .fetch_optional(&pool)
    .await
    .map_err(|e| meta.err(e))?;
    let kind = kind
        .ok_or_else(|| DriverError::new(ErrorCode::QueryFailed, "The object no longer exists"))?;

    let indexes: Vec<String> = sqlx::query_scalar(concat!(
        "SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x WHERE x.indrelid = ",
        rel!(),
        " AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid \
           AND k.contype IN ('p','u','x')) ORDER BY 1"
    ))
    .bind(schema)
    .bind(table)
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    match kind.as_str() {
        "v" | "m" => {
            let def: Option<String> =
                sqlx::query_scalar(concat!("SELECT pg_get_viewdef(", rel!(), ", true)"))
                    .bind(schema)
                    .bind(table)
                    .fetch_one(&pool)
                    .await
                    .map_err(|e| meta.err(e))?;
            let def = def.unwrap_or_default();
            let matview = kind == "m";
            Ok(render_view(
                schema,
                table,
                &def,
                matview,
                if matview { &indexes } else { &[] },
            ))
        }
        "r" | "p" => {
            let columns: Vec<(String, String, bool, Option<String>, String, String)> =
                sqlx::query_as(concat!(
                    "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull, \
                            pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text \
                     FROM pg_attribute a \
                     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                     WHERE a.attrelid = ",
                    rel!(),
                    " AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
                ))
                .bind(schema)
                .bind(table)
                .fetch_all(&pool)
                .await
                .map_err(|e| meta.err(e))?;
            let constraints: Vec<(String, String)> = sqlx::query_as(concat!(
                "SELECT conname::text, pg_get_constraintdef(oid) FROM pg_constraint \
                 WHERE conrelid = ",
                rel!(),
                " AND contype IN ('p','u','c','f','x') \
                 ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 \
                          WHEN 'f' THEN 3 ELSE 4 END, conname"
            ))
            .bind(schema)
            .bind(table)
            .fetch_all(&pool)
            .await
            .map_err(|e| meta.err(e))?;
            let first = |s: &str| {
                s.chars()
                    .next()
                    .filter(|c| *c != '\0' && !c.is_whitespace())
            };
            Ok(render_table(&TableDef {
                schema: schema.into(),
                name: table.into(),
                columns: columns
                    .into_iter()
                    .map(
                        |(name, type_name, not_null, default, identity, generated)| ColumnDef {
                            name,
                            type_name,
                            not_null,
                            default,
                            identity: first(&identity),
                            generated: first(&generated),
                        },
                    )
                    .collect(),
                constraints,
                indexes,
            }))
        }
        _ => Err(DriverError::unsupported("DDL for this kind of object")),
    }
}

/// Exact row count of a table or view.
pub async fn count_rows(meta: &PgMeta, path: &NodePath) -> DriverResult<i64> {
    let seg = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    let schema = schema_of(path)?;
    let pool = meta.pool(path.find(NodeKind::Database)).await?;
    let sql = format!(
        "SELECT count(*) FROM {}.{}",
        super::ddl::quote(schema),
        super::ddl::quote(&seg.name)
    );
    // Both identifiers are quoted by `quote`, which doubles embedded quotes.
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(&pool)
        .await
        .map_err(|e| meta.err(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_are_compact() {
        assert_eq!(format_count(850), "850");
        assert_eq!(format_count(12_400), "12.4k");
        assert_eq!(format_count(3_200_000), "3.2M");
        assert_eq!(format_count(0), "0");
    }
}
