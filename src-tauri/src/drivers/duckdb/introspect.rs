//! Schema introspection for DuckDB: catalogs (the open database and anything attached) →
//! schemas → object groups → objects → columns, from the `duckdb_*()` table functions.

use std::collections::HashMap;
use std::sync::Arc;

use duckdb::types::Value as D;

use super::Shared;
use crate::drivers::introspect::{
    ColumnInfo, NodeKind, NodePath, SchemaSnapshot, SnapshotColumn, SnapshotSchema, SnapshotTable,
    TreeNode,
};
use crate::drivers::postgres::introspect::format_count;
use crate::drivers::table_meta::{
    ColumnDetail, ForeignKeyDetail, IndexDetail, ReferencedBy, TableMeta,
};
use crate::drivers::{DriverError, DriverResult, ErrorCode};

/// A string literal.
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A quoted identifier.
pub fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn s(v: &D) -> String {
    match v {
        D::Text(t) | D::Enum(t) => t.clone(),
        D::Null => String::new(),
        other => format!("{other:?}"),
    }
}

fn opt(v: &D) -> Option<String> {
    match v {
        D::Null => None,
        other => Some(s(other)),
    }
}

fn n(v: &D) -> i64 {
    match v {
        D::TinyInt(x) => (*x).into(),
        D::SmallInt(x) => (*x).into(),
        D::Int(x) => (*x).into(),
        D::BigInt(x) => *x,
        D::UTinyInt(x) => (*x).into(),
        D::USmallInt(x) => (*x).into(),
        D::UInt(x) => (*x).into(),
        D::UBigInt(x) => i64::try_from(*x).unwrap_or(i64::MAX),
        D::HugeInt(x) => i64::try_from(*x).unwrap_or(i64::MAX),
        _ => 0,
    }
}

fn b(v: &D) -> bool {
    matches!(v, D::Boolean(true))
}

fn list(v: &D) -> Vec<String> {
    match v {
        D::List(items) | D::Array(items) => items.iter().map(s).collect(),
        _ => Vec::new(),
    }
}

pub async fn children(shared: &Arc<Shared>, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let Some(last) = path.last() else {
        return catalogs(shared, path).await;
    };
    let db = path.find(NodeKind::Database).unwrap_or_default();
    let schema = path.find(NodeKind::Schema).unwrap_or("main");
    match last.kind {
        NodeKind::Database => schemas(shared, path, &last.name).await,
        NodeKind::Schema => groups(shared, path, db, &last.name).await,
        NodeKind::Group => members(shared, path, db, schema, &last.name).await,
        NodeKind::Table | NodeKind::View => columns(shared, path, db, schema, &last.name).await,
        _ => Ok(vec![]),
    }
}

async fn catalogs(shared: &Arc<Shared>, parent: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let rows = shared
        .rows("SELECT database_name, path FROM duckdb_databases() WHERE NOT internal ORDER BY database_name".into())
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let node = TreeNode::new(parent, NodeKind::Database, s(&r[0]), true);
            match opt(&r[1]) {
                Some(p) => node.with_detail(p),
                None => node,
            }
        })
        .collect())
}

async fn schemas(shared: &Arc<Shared>, parent: &NodePath, db: &str) -> DriverResult<Vec<TreeNode>> {
    let rows = shared
        .rows(format!(
            "SELECT schema_name FROM duckdb_schemas() WHERE database_name = {} AND (NOT internal OR schema_name = 'main') ORDER BY schema_name",
            lit(db)
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| TreeNode::new(parent, NodeKind::Schema, s(&r[0]), true))
        .collect())
}

async fn groups(
    shared: &Arc<Shared>,
    parent: &NodePath,
    db: &str,
    schema: &str,
) -> DriverResult<Vec<TreeNode>> {
    let at = format!(
        "database_name = {} AND schema_name = {}",
        lit(db),
        lit(schema)
    );
    let rows = shared
        .rows(format!(
            "SELECT 'tables', count(*) FROM duckdb_tables() WHERE {at} \
             UNION ALL SELECT 'views', count(*) FROM duckdb_views() WHERE {at} AND NOT internal \
             UNION ALL SELECT 'sequences', count(*) FROM duckdb_sequences() WHERE {at} \
             UNION ALL SELECT 'indexes', count(*) FROM duckdb_indexes() WHERE {at}"
        ))
        .await?;
    let counts: HashMap<String, i64> = rows.iter().map(|r| (s(&r[0]), n(&r[1]))).collect();
    Ok(["tables", "views", "sequences", "indexes"]
        .into_iter()
        .map(|g| {
            let c = counts.get(g).copied().unwrap_or(0);
            TreeNode::new(parent, NodeKind::Group, g, c > 0).with_detail(c.to_string())
        })
        .collect())
}

async fn members(
    shared: &Arc<Shared>,
    parent: &NodePath,
    db: &str,
    schema: &str,
    group: &str,
) -> DriverResult<Vec<TreeNode>> {
    let at = format!(
        "database_name = {} AND schema_name = {}",
        lit(db),
        lit(schema)
    );
    let (sql, kind) = match group {
        "tables" => (
            format!("SELECT table_name, estimated_size FROM duckdb_tables() WHERE {at} ORDER BY table_name"),
            NodeKind::Table,
        ),
        "views" => (
            format!("SELECT view_name, NULL FROM duckdb_views() WHERE {at} AND NOT internal ORDER BY view_name"),
            NodeKind::View,
        ),
        "sequences" => (
            format!("SELECT sequence_name, NULL FROM duckdb_sequences() WHERE {at} ORDER BY sequence_name"),
            NodeKind::Sequence,
        ),
        "indexes" => (
            format!("SELECT index_name, table_name FROM duckdb_indexes() WHERE {at} ORDER BY index_name"),
            NodeKind::Index,
        ),
        other => {
            return Err(DriverError::new(
                ErrorCode::Unsupported,
                format!("Unknown object group \"{other}\""),
            ))
        }
    };
    let rows = shared.rows(sql).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let name = s(&r[0]);
            let node = TreeNode::new(
                parent,
                kind,
                name,
                matches!(kind, NodeKind::Table | NodeKind::View),
            );
            match (kind, &r[1]) {
                (NodeKind::Table, D::Null) => node,
                (NodeKind::Table, est) => node.with_detail(format_count(n(est))),
                (NodeKind::Index, t) => node.with_detail(format!("ON {}", s(t))),
                _ => node,
            }
        })
        .collect())
}

struct Keys {
    primary: Vec<String>,
    /// column → `table.column`
    foreign: HashMap<String, String>,
}

async fn keys(shared: &Arc<Shared>, db: &str, schema: &str, table: &str) -> DriverResult<Keys> {
    let rows = shared
        .rows(format!(
            "SELECT constraint_type, constraint_column_names, referenced_table, referenced_column_names \
             FROM duckdb_constraints() WHERE database_name = {} AND schema_name = {} AND table_name = {} \
             AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')",
            lit(db),
            lit(schema),
            lit(table)
        ))
        .await?;
    let mut out = Keys {
        primary: vec![],
        foreign: HashMap::new(),
    };
    for r in &rows {
        let cols = list(&r[1]);
        if s(&r[0]) == "PRIMARY KEY" {
            out.primary = cols;
        } else {
            let target = s(&r[2]);
            let refs = list(&r[3]);
            for (i, c) in cols.into_iter().enumerate() {
                let rc = refs.get(i).cloned().unwrap_or_default();
                out.foreign.insert(c, format!("{target}.{rc}"));
            }
        }
    }
    Ok(out)
}

async fn columns(
    shared: &Arc<Shared>,
    parent: &NodePath,
    db: &str,
    schema: &str,
    table: &str,
) -> DriverResult<Vec<TreeNode>> {
    let k = keys(shared, db, schema, table).await?;
    let rows = shared
        .rows(format!(
            "SELECT column_name, data_type, is_nullable, column_default FROM duckdb_columns() \
             WHERE database_name = {} AND schema_name = {} AND table_name = {} ORDER BY column_index",
            lit(db),
            lit(schema),
            lit(table)
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let name = s(&r[0]);
            let mut node = TreeNode::new(parent, NodeKind::Column, name.clone(), false);
            node.column = Some(ColumnInfo {
                type_name: s(&r[1]),
                nullable: b(&r[2]),
                default: opt(&r[3]),
                primary_key: k.primary.contains(&name),
                foreign_key: k.foreign.get(&name).cloned(),
            });
            node
        })
        .collect())
}

pub async fn snapshot(shared: &Arc<Shared>, db: &str) -> DriverResult<SchemaSnapshot> {
    let catalog = if db.is_empty() {
        "current_database()".to_string()
    } else {
        lit(db)
    };
    let cols = shared
        .rows(format!(
            "SELECT schema_name, table_name, column_name, data_type FROM duckdb_columns() \
             WHERE database_name = {catalog} AND NOT internal ORDER BY schema_name, table_name, column_index"
        ))
        .await?;
    let views = shared
        .rows(format!(
            "SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = {catalog} AND NOT internal"
        ))
        .await?;
    let view_set: std::collections::HashSet<(String, String)> =
        views.iter().map(|r| (s(&r[0]), s(&r[1]))).collect();
    let funcs = shared
        .rows(
            "SELECT DISTINCT function_name FROM duckdb_functions() \
             WHERE function_type IN ('scalar', 'aggregate') AND regexp_matches(function_name, '^[a-z_][a-z0-9_]*$') \
             ORDER BY function_name"
                .into(),
        )
        .await?
        .iter()
        .map(|r| s(&r[0]))
        .collect::<Vec<_>>();

    let mut schemas: Vec<SnapshotSchema> = Vec::new();
    for r in &cols {
        let (schema, table) = (s(&r[0]), s(&r[1]));
        let si = match schemas.iter().position(|x| x.name == schema) {
            Some(i) => i,
            None => {
                schemas.push(SnapshotSchema {
                    name: schema.clone(),
                    tables: vec![],
                    functions: funcs.clone(),
                });
                schemas.len() - 1
            }
        };
        let tables = &mut schemas[si].tables;
        let ti = match tables.iter().position(|t| t.name == table) {
            Some(i) => i,
            None => {
                let kind = if view_set.contains(&(schema.clone(), table.clone())) {
                    NodeKind::View
                } else {
                    NodeKind::Table
                };
                tables.push(SnapshotTable {
                    name: table.clone(),
                    kind,
                    columns: vec![],
                });
                tables.len() - 1
            }
        };
        tables[ti].columns.push(SnapshotColumn {
            name: s(&r[2]),
            type_name: s(&r[3]),
        });
    }
    Ok(SchemaSnapshot { schemas })
}

fn target(path: &NodePath) -> DriverResult<(String, String, String, NodeKind)> {
    let last = path
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    Ok((
        path.find(NodeKind::Database)
            .unwrap_or_default()
            .to_string(),
        path.find(NodeKind::Schema).unwrap_or("main").to_string(),
        last.name.clone(),
        last.kind,
    ))
}

pub async fn ddl(shared: &Arc<Shared>, path: &NodePath) -> DriverResult<String> {
    let (db, schema, name, kind) = target(path)?;
    let (func, col) = match kind {
        NodeKind::Table => ("duckdb_tables", "table_name"),
        NodeKind::View => ("duckdb_views", "view_name"),
        NodeKind::Sequence => ("duckdb_sequences", "sequence_name"),
        NodeKind::Index => ("duckdb_indexes", "index_name"),
        _ => return Err(DriverError::unsupported("Showing DDL for this object")),
    };
    let rows = shared
        .rows(format!(
            "SELECT sql FROM {func}() WHERE database_name = {} AND schema_name = {} AND {col} = {}",
            lit(&db),
            lit(&schema),
            lit(&name)
        ))
        .await?;
    rows.first().and_then(|r| opt(&r[0])).ok_or_else(|| {
        DriverError::new(
            ErrorCode::QueryFailed,
            format!("{name} has no stored definition"),
        )
    })
}

pub async fn count_rows(shared: &Arc<Shared>, path: &NodePath) -> DriverResult<i64> {
    let (db, schema, name, _) = target(path)?;
    let rows = shared
        .rows(format!(
            "SELECT count(*) FROM {}.{}.{}",
            q(&db),
            q(&schema),
            q(&name)
        ))
        .await?;
    Ok(rows.first().map_or(0, |r| n(&r[0])))
}

pub async fn table_meta(shared: &Arc<Shared>, path: &NodePath) -> DriverResult<TableMeta> {
    let (db, schema, name, kind) = target(path)?;
    let k = keys(shared, &db, &schema, &name).await?;
    let at = format!(
        "database_name = {} AND schema_name = {} AND table_name = {}",
        lit(&db),
        lit(&schema),
        lit(&name)
    );
    let columns = shared
        .rows(format!(
            "SELECT column_name, data_type, is_nullable, column_default, comment FROM duckdb_columns() \
             WHERE {at} ORDER BY column_index"
        ))
        .await?
        .iter()
        .map(|r| {
            let col = s(&r[0]);
            ColumnDetail {
                primary_key: k.primary.contains(&col),
                name: col,
                type_name: s(&r[1]),
                nullable: b(&r[2]),
                default: opt(&r[3]),
                comment: opt(&r[4]),
            }
        })
        .collect();

    let mut indexes = Vec::new();
    if !k.primary.is_empty() {
        indexes.push(IndexDetail {
            name: format!("{name}_pkey"),
            columns: k.primary.clone(),
            unique: true,
            primary: true,
            method: Some("art".into()),
            size_bytes: None,
        });
    }
    for r in shared
        .rows(format!(
            "SELECT index_name, is_unique, expressions FROM duckdb_indexes() WHERE {at} ORDER BY index_name"
        ))
        .await?
    {
        let exprs = match &r[2] {
            D::Text(t) => t
                .trim_matches(|c| c == '[' || c == ']')
                .split(',')
                .map(|c| c.trim().trim_matches('\'').trim_matches('"').to_string())
                .filter(|c| !c.is_empty())
                .collect(),
            other => list(other),
        };
        indexes.push(IndexDetail {
            name: s(&r[0]),
            columns: exprs,
            unique: b(&r[1]),
            primary: false,
            method: Some("art".into()),
            size_bytes: None,
        });
    }

    let mut foreign_keys = Vec::new();
    for r in shared
        .rows(format!(
            "SELECT constraint_name, constraint_column_names, referenced_table, referenced_column_names \
             FROM duckdb_constraints() WHERE {at} AND constraint_type = 'FOREIGN KEY'"
        ))
        .await?
    {
        foreign_keys.push(ForeignKeyDetail {
            name: s(&r[0]),
            columns: list(&r[1]),
            ref_schema: Some(schema.clone()),
            ref_table: s(&r[2]),
            ref_columns: list(&r[3]),
            on_update: None,
            on_delete: None,
        });
    }

    let mut referenced_by = Vec::new();
    for r in shared
        .rows(format!(
            "SELECT constraint_name, schema_name, table_name, constraint_column_names, referenced_column_names \
             FROM duckdb_constraints() WHERE database_name = {} AND constraint_type = 'FOREIGN KEY' \
             AND referenced_table = {}",
            lit(&db),
            lit(&name)
        ))
        .await?
    {
        referenced_by.push(ReferencedBy {
            name: s(&r[0]),
            schema: Some(s(&r[1])),
            table: s(&r[2]),
            columns: list(&r[3]),
            ref_columns: list(&r[4]),
        });
    }

    let estimated_rows = if kind == NodeKind::Table {
        shared
            .rows(format!(
                "SELECT estimated_size FROM duckdb_tables() WHERE {at}"
            ))
            .await?
            .first()
            .map(|r| n(&r[0]))
    } else {
        None
    };
    Ok(TableMeta {
        columns,
        indexes,
        foreign_keys,
        referenced_by,
        estimated_rows,
    })
}
