//! Schema introspection for ClickHouse from the `system` tables: databases → object groups →
//! tables (with their engine) → columns.

use std::sync::Arc;

use serde_json::Value as J;

use super::client::Client;
use super::types::{is_nullable, unwrap_type};
use crate::drivers::introspect::{
    ColumnInfo, NodeKind, NodePath, SchemaSnapshot, SnapshotColumn, SnapshotSchema, SnapshotTable,
    TreeNode,
};
use crate::drivers::postgres::introspect::format_count;
use crate::drivers::table_meta::{ColumnDetail, IndexDetail, TableMeta};
use crate::drivers::{DriverError, DriverResult, ErrorCode};

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub fn q(name: &str) -> String {
    format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
}

fn s(v: &J) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| match v {
        J::Null => String::new(),
        other => other.to_string(),
    })
}

fn n(v: &J) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|t| t.parse().ok()))
        .unwrap_or(0)
}

fn is_view(engine: &str) -> bool {
    matches!(
        engine,
        "View" | "MaterializedView" | "LiveView" | "WindowView"
    )
}

pub async fn children(client: &Arc<Client>, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let Some(last) = path.last() else {
        let rows = client
            .rows("SELECT name FROM system.databases WHERE name NOT IN ('INFORMATION_SCHEMA', 'information_schema') ORDER BY name")
            .await?;
        return Ok(rows
            .iter()
            .map(|r| TreeNode::new(path, NodeKind::Database, s(&r[0]), true))
            .collect());
    };
    let db = path.find(NodeKind::Database).unwrap_or_default();
    match last.kind {
        NodeKind::Database => {
            let rows = client
                .rows(&format!(
                    "SELECT engine, count() FROM system.tables WHERE database = {} GROUP BY engine",
                    lit(&last.name)
                ))
                .await?;
            let (mut tables, mut views) = (0, 0);
            for r in &rows {
                let c = n(&r[1]);
                if is_view(&s(&r[0])) {
                    views += c;
                } else {
                    tables += c;
                }
            }
            Ok([("tables", tables), ("views", views)]
                .into_iter()
                .map(|(g, c)| {
                    TreeNode::new(path, NodeKind::Group, g, c > 0).with_detail(c.to_string())
                })
                .collect())
        }
        NodeKind::Group => {
            let views = last.name == "views";
            let rows = client
                .rows(&format!(
                    "SELECT name, engine, total_rows FROM system.tables WHERE database = {} ORDER BY name",
                    lit(db)
                ))
                .await?;
            Ok(rows
                .iter()
                .filter(|r| is_view(&s(&r[1])) == views)
                .map(|r| {
                    let kind = if views {
                        NodeKind::View
                    } else {
                        NodeKind::Table
                    };
                    let engine = s(&r[1]);
                    let node = TreeNode::new(path, kind, s(&r[0]), true);
                    if views || r[2].is_null() {
                        node.with_detail(engine)
                    } else {
                        node.with_detail(format!("{engine} · {}", format_count(n(&r[2]))))
                    }
                })
                .collect())
        }
        NodeKind::Table | NodeKind::View => {
            let rows = client
                .rows(&format!(
                    "SELECT name, type, default_expression, is_in_primary_key FROM system.columns \
                     WHERE database = {} AND table = {} ORDER BY position",
                    lit(db),
                    lit(&last.name)
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let mut node = TreeNode::new(path, NodeKind::Column, s(&r[0]), false);
                    node.column = Some(ColumnInfo {
                        type_name: s(&r[1]),
                        nullable: is_nullable(&s(&r[1])),
                        default: Some(s(&r[2])).filter(|d| !d.is_empty()),
                        // The sorting key is not a unique key; rows can't be addressed by it.
                        primary_key: false,
                        foreign_key: None,
                    });
                    node
                })
                .collect())
        }
        _ => Ok(vec![]),
    }
}

pub async fn snapshot(client: &Arc<Client>, db: &str) -> DriverResult<SchemaSnapshot> {
    let filter = if db.is_empty() {
        "database = currentDatabase()".to_string()
    } else {
        format!("database = {}", lit(db))
    };
    let tables = client
        .rows(&format!(
            "SELECT name, engine FROM system.tables WHERE {filter}"
        ))
        .await?;
    let cols = client
        .rows(&format!(
            "SELECT table, name, type FROM system.columns WHERE {filter} ORDER BY table, position"
        ))
        .await?;
    let functions = client
        .rows("SELECT name FROM system.functions WHERE alias_to = '' ORDER BY name")
        .await?
        .iter()
        .map(|r| s(&r[0]))
        .filter(|f| f.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .collect();
    let mut out: Vec<SnapshotTable> = tables
        .iter()
        .map(|r| SnapshotTable {
            name: s(&r[0]),
            kind: if is_view(&s(&r[1])) {
                NodeKind::View
            } else {
                NodeKind::Table
            },
            columns: vec![],
        })
        .collect();
    for r in &cols {
        if let Some(t) = out.iter_mut().find(|t| t.name == s(&r[0])) {
            t.columns.push(SnapshotColumn {
                name: s(&r[1]),
                type_name: unwrap_type(&s(&r[2])).to_string(),
            });
        }
    }
    Ok(SchemaSnapshot {
        schemas: vec![SnapshotSchema {
            name: db.to_string(),
            tables: out,
            functions,
        }],
    })
}

fn target(path: &NodePath) -> DriverResult<(String, String)> {
    let last = path
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    Ok((
        path.find(NodeKind::Database)
            .unwrap_or_default()
            .to_string(),
        last.name.clone(),
    ))
}

pub async fn ddl(client: &Arc<Client>, path: &NodePath) -> DriverResult<String> {
    let (db, name) = target(path)?;
    let rows = client
        .rows(&format!("SHOW CREATE TABLE {}.{}", q(&db), q(&name)))
        .await?;
    rows.first().map(|r| s(&r[0])).ok_or_else(|| {
        DriverError::new(ErrorCode::QueryFailed, format!("{name} has no definition"))
    })
}

pub async fn count_rows(client: &Arc<Client>, path: &NodePath) -> DriverResult<i64> {
    let (db, name) = target(path)?;
    let rows = client
        .rows(&format!("SELECT count() FROM {}.{}", q(&db), q(&name)))
        .await?;
    Ok(rows.first().map_or(0, |r| n(&r[0])))
}

fn split_exprs(list: &str) -> Vec<String> {
    list.split(',')
        .map(|c| c.trim().trim_matches('`').to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

pub async fn table_meta(client: &Arc<Client>, path: &NodePath) -> DriverResult<TableMeta> {
    let (db, name) = target(path)?;
    let columns = client
        .rows(&format!(
            "SELECT name, type, default_expression, comment FROM system.columns \
             WHERE database = {} AND table = {} ORDER BY position",
            lit(&db),
            lit(&name)
        ))
        .await?
        .iter()
        .map(|r| ColumnDetail {
            name: s(&r[0]),
            type_name: s(&r[1]),
            nullable: is_nullable(&s(&r[1])),
            default: Some(s(&r[2])).filter(|d| !d.is_empty()),
            primary_key: false,
            comment: Some(s(&r[3])).filter(|c| !c.is_empty()),
        })
        .collect();

    let mut indexes = Vec::new();
    let t = client
        .rows(&format!(
            "SELECT primary_key, sorting_key, partition_key, engine, total_rows, total_bytes \
             FROM system.tables WHERE database = {} AND name = {}",
            lit(&db),
            lit(&name)
        ))
        .await?;
    let mut estimated_rows = None;
    if let Some(r) = t.first() {
        let (pk, sorting, partition) = (s(&r[0]), s(&r[1]), s(&r[2]));
        let engine = s(&r[3]);
        if !pk.is_empty() {
            indexes.push(IndexDetail {
                name: "PRIMARY KEY".into(),
                columns: split_exprs(&pk),
                unique: false,
                primary: false,
                method: Some(engine.clone()),
                size_bytes: None,
            });
        }
        if !sorting.is_empty() && sorting != pk {
            indexes.push(IndexDetail {
                name: "ORDER BY".into(),
                columns: split_exprs(&sorting),
                unique: false,
                primary: false,
                method: Some(engine.clone()),
                size_bytes: None,
            });
        }
        if !partition.is_empty() {
            indexes.push(IndexDetail {
                name: "PARTITION BY".into(),
                columns: split_exprs(&partition),
                unique: false,
                primary: false,
                method: Some(engine),
                size_bytes: None,
            });
        }
        estimated_rows = (!r[4].is_null()).then(|| n(&r[4]));
    }
    for r in client
        .rows(&format!(
            "SELECT name, expr, type FROM system.data_skipping_indices WHERE database = {} AND table = {}",
            lit(&db),
            lit(&name)
        ))
        .await
        .unwrap_or_default()
    {
        indexes.push(IndexDetail {
            name: s(&r[0]),
            columns: split_exprs(&s(&r[1])),
            unique: false,
            primary: false,
            method: Some(s(&r[2])),
            size_bytes: None,
        });
    }
    Ok(TableMeta {
        columns,
        indexes,
        foreign_keys: vec![],
        referenced_by: vec![],
        estimated_rows,
    })
}
