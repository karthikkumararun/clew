//! Lazy schema introspection for SQLite: databases (main + attached) → object groups → objects →
//! columns, keys and indexes, read through a small read-only pool.

use std::collections::{BTreeMap, HashMap};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::{AssertSqlSafe, Executor, Row, SqlSafeStr};

use super::config::attach_sql;
use super::error::map_error;
use crate::drivers::introspect::{
    ColumnInfo, NodeKind, NodePath, SchemaSnapshot, SnapshotColumn, SnapshotSchema, SnapshotTable,
    TreeNode,
};
use crate::drivers::postgres::introspect::format_count;
use crate::drivers::{DriverError, DriverResult, ErrorCode};

pub struct SqliteMeta {
    pool: SqlitePool,
    path: String,
}

fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl SqliteMeta {
    pub async fn open(
        opts: SqliteConnectOptions,
        attachments: Vec<(String, String)>,
        path: String,
    ) -> DriverResult<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(3)
            .after_connect(move |conn, _meta| {
                let attachments = attachments.clone();
                Box::pin(async move {
                    for (name, file) in &attachments {
                        conn.execute(AssertSqlSafe(attach_sql(name, file)).into_sql_str())
                            .await?;
                    }
                    Ok(())
                })
            })
            .connect_with(opts)
            .await
            .map_err(|e| map_error(e, &path, None))?;
        Ok(Self { pool, path })
    }

    fn err(&self, e: sqlx::Error) -> DriverError {
        map_error(e, &self.path, None)
    }

    /// Run an identifier-quoted statement (PRAGMA arguments cannot be bound).
    async fn rows(&self, sql: String) -> DriverResult<Vec<sqlx::sqlite::SqliteRow>> {
        sqlx::query(AssertSqlSafe(sql))
            .persistent(false)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| self.err(e))
    }
}

pub async fn children(meta: &SqliteMeta, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
    match path.0.last() {
        None => databases(meta, path).await,
        Some(seg) => {
            let db = path.find(NodeKind::Database).unwrap_or("main");
            match seg.kind {
                NodeKind::Database => groups(meta, path, &seg.name).await,
                NodeKind::Group => members(meta, path, db, &seg.name).await,
                NodeKind::Table | NodeKind::View => table_children(meta, path, db, &seg.name).await,
                _ => Ok(vec![]),
            }
        }
    }
}

async fn database_list(meta: &SqliteMeta) -> DriverResult<Vec<(String, String)>> {
    let rows = meta.rows("PRAGMA database_list".into()).await?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                r.try_get::<String, _>(1).unwrap_or_default(),
                r.try_get::<String, _>(2).unwrap_or_default(),
            )
        })
        .collect())
}

async fn databases(meta: &SqliteMeta, parent: &NodePath) -> DriverResult<Vec<TreeNode>> {
    Ok(database_list(meta)
        .await?
        .into_iter()
        .filter(|(name, _)| name != "temp")
        .map(|(name, file)| {
            let node = TreeNode::new(parent, NodeKind::Database, name, true);
            if file.is_empty() {
                node
            } else {
                node.with_detail(file)
            }
        })
        .collect())
}

async fn groups(meta: &SqliteMeta, parent: &NodePath, db: &str) -> DriverResult<Vec<TreeNode>> {
    let rows = meta
        .rows(format!(
            "SELECT type, COUNT(*) FROM {}.sqlite_master \
             WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','index','trigger') GROUP BY type",
            q(db)
        ))
        .await?;
    let counts: HashMap<String, i64> = rows
        .iter()
        .map(|r| {
            (
                r.try_get::<String, _>(0).unwrap_or_default(),
                r.try_get::<i64, _>(1).unwrap_or(0),
            )
        })
        .collect();
    Ok([
        ("tables", "table"),
        ("views", "view"),
        ("indexes", "index"),
        ("triggers", "trigger"),
    ]
    .into_iter()
    .map(|(label, kind)| {
        let n = counts.get(kind).copied().unwrap_or(0);
        TreeNode::new(parent, NodeKind::Group, label, n > 0).with_detail(n.to_string())
    })
    .collect())
}

async fn members(
    meta: &SqliteMeta,
    parent: &NodePath,
    db: &str,
    group: &str,
) -> DriverResult<Vec<TreeNode>> {
    let (kind, sqlite_type) = match group {
        "tables" => (NodeKind::Table, "table"),
        "views" => (NodeKind::View, "view"),
        "indexes" => (NodeKind::Index, "index"),
        "triggers" => (NodeKind::Trigger, "trigger"),
        other => {
            return Err(DriverError::new(
                ErrorCode::Unsupported,
                format!("Unknown object group \"{other}\""),
            ))
        }
    };
    let rows = meta
        .rows(format!(
            "SELECT name, tbl_name FROM {}.sqlite_master \
             WHERE type = '{sqlite_type}' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            q(db)
        ))
        .await?;
    // Row estimates exist only after ANALYZE; ignore their absence.
    let estimates: HashMap<String, i64> = if kind == NodeKind::Table {
        meta.rows(format!(
            "SELECT tbl, CAST(substr(stat, 1, instr(stat || ' ', ' ') - 1) AS INTEGER) \
             FROM {}.sqlite_stat1 WHERE idx IS NULL OR idx = tbl",
            q(db)
        ))
        .await
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    (
                        r.try_get::<String, _>(0).unwrap_or_default(),
                        r.try_get::<i64, _>(1).unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
    } else {
        HashMap::new()
    };
    Ok(rows
        .iter()
        .map(|r| {
            let name: String = r.try_get(0).unwrap_or_default();
            let tbl: String = r.try_get(1).unwrap_or_default();
            let has_children = matches!(kind, NodeKind::Table | NodeKind::View);
            let node = TreeNode::new(parent, kind, name.clone(), has_children);
            match kind {
                NodeKind::Index | NodeKind::Trigger => node.with_detail(format!("ON {tbl}")),
                _ => match estimates.get(&name) {
                    Some(n) => node.with_detail(format_count(*n)),
                    None => node,
                },
            }
        })
        .collect())
}

async fn table_children(
    meta: &SqliteMeta,
    parent: &NodePath,
    db: &str,
    table: &str,
) -> DriverResult<Vec<TreeNode>> {
    // table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden
    let cols = meta
        .rows(format!("PRAGMA {}.table_xinfo({})", q(db), q(table)))
        .await?;
    // foreign_key_list: id, seq, table, from, to, on_update, on_delete, match
    let fk_rows = meta
        .rows(format!("PRAGMA {}.foreign_key_list({})", q(db), q(table)))
        .await?;
    let mut fk_by_column: HashMap<String, String> = HashMap::new();
    let mut fk_groups: BTreeMap<i64, (String, Vec<String>, Vec<String>)> = BTreeMap::new();
    for r in &fk_rows {
        let id: i64 = r.try_get(0).unwrap_or(0);
        let target: String = r.try_get(2).unwrap_or_default();
        let from: String = r.try_get(3).unwrap_or_default();
        let to: Option<String> = r.try_get(4).unwrap_or(None);
        let to_name = to.clone().unwrap_or_else(|| "id".into());
        fk_by_column.insert(from.clone(), format!("{target}.{to_name}"));
        let e = fk_groups
            .entry(id)
            .or_insert_with(|| (target, vec![], vec![]));
        e.1.push(from);
        e.2.push(to_name);
    }

    let mut pk: Vec<(i64, String)> = Vec::new();
    let mut nodes: Vec<TreeNode> = Vec::new();
    for r in &cols {
        let hidden: i64 = r.try_get(6).unwrap_or(0);
        if hidden == 1 {
            continue; // a virtual table's hidden column
        }
        let name: String = r.try_get(1).unwrap_or_default();
        let ty: String = r.try_get(2).unwrap_or_default();
        let notnull: i64 = r.try_get(3).unwrap_or(0);
        let default: Option<String> = r.try_get(4).unwrap_or(None);
        let pk_pos: i64 = r.try_get(5).unwrap_or(0);
        if pk_pos > 0 {
            pk.push((pk_pos, name.clone()));
        }
        let fk = fk_by_column.get(&name).cloned();
        let shown_type = if ty.is_empty() {
            "(any)".to_string()
        } else {
            ty.clone()
        };
        let detail = match &fk {
            Some(t) => format!("{shown_type} → {t}"),
            None => shown_type,
        };
        let mut node = TreeNode::new(parent, NodeKind::Column, name, false).with_detail(detail);
        node.column = Some(ColumnInfo {
            type_name: ty,
            nullable: notnull == 0 && pk_pos == 0,
            default,
            primary_key: pk_pos > 0,
            foreign_key: fk,
        });
        nodes.push(node);
    }

    if !pk.is_empty() {
        pk.sort();
        let names: Vec<_> = pk.into_iter().map(|(_, n)| n).collect();
        nodes.push(
            TreeNode::new(parent, NodeKind::PrimaryKey, "PRIMARY KEY", false)
                .with_detail(format!("({})", names.join(", "))),
        );
    }
    for (id, (target, from, to)) in fk_groups {
        nodes.push(
            TreeNode::new(parent, NodeKind::ForeignKey, format!("fk_{id}"), false).with_detail(
                format!("({}) → {target}({})", from.join(", "), to.join(", ")),
            ),
        );
    }

    // index_list: seq, name, unique, origin, partial
    let idx = meta
        .rows(format!("PRAGMA {}.index_list({})", q(db), q(table)))
        .await?;
    for r in &idx {
        let name: String = r.try_get(1).unwrap_or_default();
        let unique: i64 = r.try_get(2).unwrap_or(0);
        let origin: String = r.try_get(3).unwrap_or_default();
        if origin == "pk" {
            continue; // shown as the primary key
        }
        let info = meta
            .rows(format!("PRAGMA {}.index_info({})", q(db), q(&name)))
            .await?;
        let cols: Vec<String> = info
            .iter()
            .map(|c| {
                c.try_get::<Option<String>, _>(2)
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "<expr>".into())
            })
            .collect();
        let u = if unique == 1 { "unique " } else { "" };
        nodes.push(
            TreeNode::new(parent, NodeKind::Index, name, false)
                .with_detail(format!("{u}({})", cols.join(", "))),
        );
    }
    Ok(nodes)
}

/// The stored `CREATE` statement of a table, view, index or trigger. A table also gets the
/// `CREATE INDEX` statements of its explicitly created indexes.
pub async fn ddl(meta: &SqliteMeta, path: &NodePath) -> DriverResult<String> {
    let seg = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    let kind = match seg.kind {
        NodeKind::Table => "table",
        NodeKind::View => "view",
        NodeKind::Index => "index",
        NodeKind::Trigger => "trigger",
        _ => return Err(DriverError::unsupported("DDL for this kind of object")),
    };
    let db = path.find(NodeKind::Database).unwrap_or("main");
    let sql: Option<String> = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT sql FROM {}.sqlite_master WHERE type = ? AND name = ?",
        q(db)
    )))
    .bind(kind)
    .bind(&seg.name)
    .fetch_optional(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?
    .flatten();
    let mut out =
        sql.ok_or_else(|| DriverError::new(ErrorCode::QueryFailed, "The object no longer exists"))?;
    if kind == "table" {
        // Automatic indexes (PRIMARY KEY / UNIQUE) have no stored SQL and are part of the table.
        let extra: Vec<String> = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT sql FROM {}.sqlite_master WHERE type IN ('index', 'trigger') \
             AND tbl_name = ? AND sql IS NOT NULL ORDER BY type, name",
            q(db)
        )))
        .bind(&seg.name)
        .fetch_all(&meta.pool)
        .await
        .map_err(|e| meta.err(e))?;
        for stmt in extra {
            out.push_str(";\n\n");
            out.push_str(&stmt);
        }
    }
    Ok(out)
}

/// Exact row count of a table or view.
pub async fn count_rows(meta: &SqliteMeta, path: &NodePath) -> DriverResult<i64> {
    let seg = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    let db = path.find(NodeKind::Database).unwrap_or("main");
    // `q` quotes both identifiers, doubling embedded quotes.
    sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT count(*) FROM {}.{}",
        q(db),
        q(&seg.name)
    )))
    .fetch_one(&meta.pool)
    .await
    .map_err(|e| meta.err(e))
}

pub async fn snapshot(meta: &SqliteMeta, db: &str) -> DriverResult<SchemaSnapshot> {
    let dbs: Vec<String> = database_list(meta)
        .await?
        .into_iter()
        .map(|(n, _)| n)
        .filter(|n| n != "temp" && (db.is_empty() || n == db))
        .collect();
    let mut schemas = Vec::new();
    for name in dbs {
        let rows = meta
            .rows(format!(
                "SELECT m.name, m.type, p.name, p.type FROM {db}.sqlite_master m \
                 JOIN pragma_table_info(m.name, '{raw}') p \
                 WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid",
                db = q(&name),
                raw = name.replace('\'', "''")
            ))
            .await?;
        let mut tables: Vec<SnapshotTable> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for r in &rows {
            let table: String = r.try_get(0).unwrap_or_default();
            let kind = if r.try_get::<String, _>(1).unwrap_or_default() == "view" {
                NodeKind::View
            } else {
                NodeKind::Table
            };
            let idx = *index.entry(table.clone()).or_insert_with(|| {
                tables.push(SnapshotTable {
                    name: table.clone(),
                    kind,
                    columns: vec![],
                });
                tables.len() - 1
            });
            tables[idx].columns.push(SnapshotColumn {
                name: r.try_get(2).unwrap_or_default(),
                type_name: r.try_get(3).unwrap_or_default(),
            });
        }
        schemas.push(SnapshotSchema {
            name,
            tables,
            functions: vec![],
        });
    }
    // SQLite's built-in functions are not per-database; offer them on the first schema.
    if let Some(first) = schemas.first_mut() {
        if let Ok(rows) = meta
            .rows("SELECT DISTINCT name FROM pragma_function_list ORDER BY name".into())
            .await
        {
            first.functions = rows
                .iter()
                .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
                .collect();
        }
    }
    Ok(SchemaSnapshot { schemas })
}
