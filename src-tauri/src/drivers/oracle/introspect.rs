//! Schema introspection for Oracle from the `ALL_*` views: schemas (users) → object groups →
//! objects → columns. Everything is read as text over a metadata connection of its own.

use std::sync::Arc;

use super::Meta;
use crate::drivers::introspect::{
    ColumnInfo, NodeKind, NodePath, SchemaSnapshot, SnapshotColumn, SnapshotSchema, SnapshotTable,
    TreeNode,
};
use crate::drivers::postgres::introspect::format_count;
use crate::drivers::table_meta::{
    ColumnDetail, ForeignKeyDetail, IndexDetail, ReferencedBy, TableMeta,
};
use crate::drivers::{DriverError, DriverResult, ErrorCode};

type Row = Vec<Option<String>>;

/// A string literal.
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A quoted identifier.
pub fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn s(r: &Row, i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

fn opt(r: &Row, i: usize) -> Option<String> {
    r.get(i).cloned().flatten().filter(|v| !v.is_empty())
}

fn n(r: &Row, i: usize) -> i64 {
    r.get(i)
        .cloned()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .map_or(0, |v| v as i64)
}

fn list(r: &Row, i: usize) -> Vec<String> {
    s(r, i)
        .split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

pub async fn children(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let Some(last) = path.last() else {
        let rows = meta
            .rows(
                "SELECT username FROM all_users WHERE oracle_maintained = 'N' OR username = USER ORDER BY username",
            )
            .await?;
        return Ok(rows
            .iter()
            .map(|r| TreeNode::new(path, NodeKind::Schema, s(r, 0), true))
            .collect());
    };
    let owner = path.find(NodeKind::Schema).unwrap_or_default();
    match last.kind {
        NodeKind::Schema => groups(meta, path, &last.name).await,
        NodeKind::Group => members(meta, path, owner, &last.name).await,
        NodeKind::Table | NodeKind::View | NodeKind::MaterializedView => {
            columns(meta, path, owner, &last.name).await
        }
        _ => Ok(vec![]),
    }
}

async fn groups(meta: &Arc<Meta>, parent: &NodePath, owner: &str) -> DriverResult<Vec<TreeNode>> {
    let o = lit(owner);
    let rows = meta
        .rows(&format!(
            "SELECT 'tables', COUNT(*) FROM all_tables WHERE owner = {o} AND nested = 'NO' AND table_name NOT LIKE 'BIN$%' AND (iot_type IS NULL OR iot_type = 'IOT') \
             UNION ALL SELECT 'views', COUNT(*) FROM all_views WHERE owner = {o} \
             UNION ALL SELECT 'materialized views', COUNT(*) FROM all_mviews WHERE owner = {o} \
             UNION ALL SELECT 'sequences', COUNT(*) FROM all_sequences WHERE sequence_owner = {o} \
             UNION ALL SELECT 'synonyms', COUNT(*) FROM all_synonyms WHERE owner = {o} \
             UNION ALL SELECT 'packages', COUNT(*) FROM all_objects WHERE owner = {o} AND object_type = 'PACKAGE' \
             UNION ALL SELECT 'procedures', COUNT(*) FROM all_objects WHERE owner = {o} AND object_type = 'PROCEDURE' \
             UNION ALL SELECT 'functions', COUNT(*) FROM all_objects WHERE owner = {o} AND object_type = 'FUNCTION'"
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let c = n(r, 1);
            TreeNode::new(parent, NodeKind::Group, s(r, 0), c > 0).with_detail(c.to_string())
        })
        .collect())
}

async fn members(
    meta: &Arc<Meta>,
    parent: &NodePath,
    owner: &str,
    group: &str,
) -> DriverResult<Vec<TreeNode>> {
    let o = lit(owner);
    let (sql, kind) = match group {
        "tables" => (
            format!("SELECT table_name, num_rows FROM all_tables WHERE owner = {o} AND nested = 'NO' AND table_name NOT LIKE 'BIN$%' AND (iot_type IS NULL OR iot_type = 'IOT') ORDER BY table_name"),
            NodeKind::Table,
        ),
        "views" => (
            format!("SELECT view_name, NULL FROM all_views WHERE owner = {o} ORDER BY view_name"),
            NodeKind::View,
        ),
        "materialized views" => (
            format!("SELECT mview_name, NULL FROM all_mviews WHERE owner = {o} ORDER BY mview_name"),
            NodeKind::MaterializedView,
        ),
        "sequences" => (
            format!("SELECT sequence_name, NULL FROM all_sequences WHERE sequence_owner = {o} ORDER BY sequence_name"),
            NodeKind::Sequence,
        ),
        "synonyms" => (
            format!("SELECT synonym_name, table_owner || '.' || table_name FROM all_synonyms WHERE owner = {o} ORDER BY synonym_name"),
            NodeKind::Synonym,
        ),
        "packages" | "procedures" | "functions" => (
            format!(
                "SELECT object_name, status FROM all_objects WHERE owner = {o} AND object_type = '{}' ORDER BY object_name",
                match group {
                    "packages" => "PACKAGE",
                    "procedures" => "PROCEDURE",
                    _ => "FUNCTION",
                }
            ),
            match group {
                "packages" => NodeKind::Package,
                "procedures" => NodeKind::Procedure,
                _ => NodeKind::Function,
            },
        ),
        other => {
            return Err(DriverError::new(
                ErrorCode::Unsupported,
                format!("Unknown object group \"{other}\""),
            ))
        }
    };
    let rows = meta.rows(&sql).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let node = TreeNode::new(
                parent,
                kind,
                s(r, 0),
                matches!(
                    kind,
                    NodeKind::Table | NodeKind::View | NodeKind::MaterializedView
                ),
            );
            match (kind, opt(r, 1)) {
                (NodeKind::Table, Some(_)) => node.with_detail(format_count(n(r, 1))),
                (NodeKind::Synonym, Some(target)) => node.with_detail(format!("→ {target}")),
                (NodeKind::Package | NodeKind::Procedure | NodeKind::Function, Some(status))
                    if status != "VALID" =>
                {
                    node.with_detail(status.to_lowercase())
                }
                _ => node,
            }
        })
        .collect())
}

/// SQL rendering a column's declared type (`VARCHAR2(50)`, `NUMBER(10,2)`).
const TYPE_SQL: &str = "CASE \
    WHEN c.data_type IN ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR') THEN c.data_type || '(' || c.char_length || ')' \
    WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN 'NUMBER(' || c.data_precision || CASE WHEN NVL(c.data_scale, 0) <> 0 THEN ',' || c.data_scale END || ')' \
    WHEN c.data_type = 'RAW' THEN 'RAW(' || c.data_length || ')' \
    ELSE c.data_type END";

async fn columns(
    meta: &Arc<Meta>,
    parent: &NodePath,
    owner: &str,
    table: &str,
) -> DriverResult<Vec<TreeNode>> {
    let (o, t) = (lit(owner), lit(table));
    let rows = meta
        .rows(&format!(
            "SELECT c.column_name, {TYPE_SQL}, c.nullable, c.data_default, \
             (SELECT COUNT(*) FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
               WHERE k.constraint_type = 'P' AND k.owner = c.owner AND k.table_name = c.table_name AND kc.column_name = c.column_name), \
             (SELECT MIN(r.table_name || '.' || rc.column_name) FROM all_constraints k \
               JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
               JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name \
               JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = kc.position \
               WHERE k.constraint_type = 'R' AND k.owner = c.owner AND k.table_name = c.table_name AND kc.column_name = c.column_name) \
             FROM all_tab_columns c WHERE c.owner = {o} AND c.table_name = {t} ORDER BY c.column_id"
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let mut node = TreeNode::new(parent, NodeKind::Column, s(r, 0), false);
            node.column = Some(ColumnInfo {
                type_name: s(r, 1),
                nullable: s(r, 2) == "Y",
                default: opt(r, 3).map(|d| d.trim().to_string()),
                primary_key: n(r, 4) > 0,
                foreign_key: opt(r, 5),
            });
            node
        })
        .collect())
}

const FUNCTIONS: &[&str] = &[
    "abs",
    "add_months",
    "avg",
    "cast",
    "ceil",
    "coalesce",
    "concat",
    "count",
    "decode",
    "extract",
    "floor",
    "greatest",
    "initcap",
    "instr",
    "last_day",
    "least",
    "length",
    "listagg",
    "lower",
    "lpad",
    "ltrim",
    "max",
    "min",
    "mod",
    "months_between",
    "nullif",
    "nvl",
    "nvl2",
    "regexp_like",
    "regexp_replace",
    "regexp_substr",
    "replace",
    "round",
    "row_number",
    "rpad",
    "rtrim",
    "substr",
    "sum",
    "sysdate",
    "systimestamp",
    "to_char",
    "to_date",
    "to_number",
    "to_timestamp",
    "trim",
    "trunc",
    "upper",
];

pub async fn snapshot(meta: &Arc<Meta>, db: &str) -> DriverResult<SchemaSnapshot> {
    let owner = if db.is_empty() {
        "USER".to_string()
    } else {
        lit(db)
    };
    let cols = meta
        .rows(&format!(
            "SELECT c.owner, c.table_name, c.column_name, c.data_type FROM all_tab_columns c \
             WHERE c.owner = {owner} AND c.table_name NOT LIKE 'BIN$%' ORDER BY c.table_name, c.column_id"
        ))
        .await?;
    let views: std::collections::HashSet<String> = meta
        .rows(&format!(
            "SELECT view_name FROM all_views WHERE owner = {owner}"
        ))
        .await?
        .iter()
        .map(|r| s(r, 0))
        .collect();
    let functions: Vec<String> = FUNCTIONS.iter().map(|f| f.to_string()).collect();
    let mut schemas: Vec<SnapshotSchema> = Vec::new();
    for r in &cols {
        let (schema, table) = (s(r, 0), s(r, 1));
        let si = match schemas.iter().position(|x| x.name == schema) {
            Some(i) => i,
            None => {
                schemas.push(SnapshotSchema {
                    name: schema.clone(),
                    tables: vec![],
                    functions: functions.clone(),
                });
                schemas.len() - 1
            }
        };
        let tables = &mut schemas[si].tables;
        let ti = match tables.iter().position(|t| t.name == table) {
            Some(i) => i,
            None => {
                tables.push(SnapshotTable {
                    kind: if views.contains(&table) {
                        NodeKind::View
                    } else {
                        NodeKind::Table
                    },
                    name: table,
                    columns: vec![],
                });
                tables.len() - 1
            }
        };
        tables[ti].columns.push(SnapshotColumn {
            name: s(r, 2),
            type_name: s(r, 3),
        });
    }
    Ok(SchemaSnapshot {
        schemas,
        ..Default::default()
    })
}

fn target(path: &NodePath) -> DriverResult<(String, String, NodeKind)> {
    let last = path
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    Ok((
        path.find(NodeKind::Schema).unwrap_or_default().to_string(),
        last.name.clone(),
        last.kind,
    ))
}

pub async fn ddl(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<String> {
    let (owner, name, kind) = target(path)?;
    let object = match kind {
        NodeKind::Table => "TABLE",
        NodeKind::View => "VIEW",
        NodeKind::MaterializedView => "MATERIALIZED_VIEW",
        NodeKind::Sequence => "SEQUENCE",
        NodeKind::Synonym => "SYNONYM",
        NodeKind::Package => "PACKAGE",
        NodeKind::Procedure => "PROCEDURE",
        NodeKind::Function => "FUNCTION",
        _ => return Err(DriverError::unsupported("Showing DDL for this object")),
    };
    let rows = meta
        .rows(&format!(
            "SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM dual",
            lit(object),
            lit(&name),
            lit(&owner)
        ))
        .await?;
    rows.first()
        .and_then(|r| opt(r, 0))
        .map(|d| d.trim().to_string())
        .ok_or_else(|| {
            DriverError::new(ErrorCode::QueryFailed, format!("{name} has no definition"))
        })
}

pub async fn count_rows(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<i64> {
    let (owner, name, _) = target(path)?;
    let rows = meta
        .rows(&format!("SELECT COUNT(*) FROM {}.{}", q(&owner), q(&name)))
        .await?;
    Ok(rows.first().map_or(0, |r| n(r, 0)))
}

pub async fn table_meta(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<TableMeta> {
    let (owner, name, kind) = target(path)?;
    let (o, t) = (lit(&owner), lit(&name));

    let pk: Vec<String> = meta
        .rows(&format!(
            "SELECT kc.column_name FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
             WHERE k.constraint_type = 'P' AND k.owner = {o} AND k.table_name = {t} ORDER BY kc.position"
        ))
        .await?
        .iter()
        .map(|r| s(r, 0))
        .collect();

    let columns = meta
        .rows(&format!(
            "SELECT c.column_name, {TYPE_SQL}, c.nullable, c.data_default, cc.comments \
             FROM all_tab_columns c LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name \
             WHERE c.owner = {o} AND c.table_name = {t} ORDER BY c.column_id"
        ))
        .await?
        .iter()
        .map(|r| ColumnDetail {
            primary_key: pk.contains(&s(r, 0)),
            name: s(r, 0),
            type_name: s(r, 1),
            nullable: s(r, 2) == "Y",
            default: opt(r, 3).map(|d| d.trim().to_string()),
            comment: opt(r, 4),
            generated: None,
        })
        .collect();

    let indexes = meta
        .rows(&format!(
            "SELECT i.index_name, i.uniqueness, i.index_type, \
             (SELECT LISTAGG(ic.column_name, ',') WITHIN GROUP (ORDER BY ic.column_position) FROM all_ind_columns ic \
               WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name), \
             (SELECT COUNT(*) FROM all_constraints k WHERE k.owner = i.owner AND k.index_name = i.index_name AND k.constraint_type = 'P') \
             FROM all_indexes i WHERE i.table_owner = {o} AND i.table_name = {t} ORDER BY i.index_name"
        ))
        .await?
        .iter()
        .map(|r| IndexDetail {
            name: s(r, 0),
            unique: s(r, 1) == "UNIQUE",
            primary: n(r, 4) > 0,
            method: opt(r, 2),
            columns: list(r, 3),
            size_bytes: None,
        })
        .collect();

    let cols = |alias: &str| {
        format!(
            "(SELECT LISTAGG(x.column_name, ',') WITHIN GROUP (ORDER BY x.position) FROM all_cons_columns x \
              WHERE x.owner = {alias}.owner AND x.constraint_name = {alias}.constraint_name)"
        )
    };
    let foreign_keys = meta
        .rows(&format!(
            "SELECT c.constraint_name, {cc}, r.owner, r.table_name, {rc}, c.delete_rule \
             FROM all_constraints c JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
             WHERE c.constraint_type = 'R' AND c.owner = {o} AND c.table_name = {t} ORDER BY c.constraint_name",
            cc = cols("c"),
            rc = cols("r"),
        ))
        .await?
        .iter()
        .map(|r| ForeignKeyDetail {
            name: s(r, 0),
            columns: list(r, 1),
            ref_schema: opt(r, 2),
            ref_table: s(r, 3),
            ref_columns: list(r, 4),
            on_update: None,
            on_delete: opt(r, 5).filter(|d| d != "NO ACTION"),
        })
        .collect();

    let referenced_by = meta
        .rows(&format!(
            "SELECT c.constraint_name, c.owner, c.table_name, {cc}, {rc} \
             FROM all_constraints c JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
             WHERE c.constraint_type = 'R' AND r.owner = {o} AND r.table_name = {t} ORDER BY c.table_name, c.constraint_name",
            cc = cols("c"),
            rc = cols("r"),
        ))
        .await?
        .iter()
        .map(|r| ReferencedBy {
            name: s(r, 0),
            schema: opt(r, 1),
            table: s(r, 2),
            columns: list(r, 3),
            ref_columns: list(r, 4),
        })
        .collect();

    let estimated_rows = if kind == NodeKind::Table {
        meta.rows(&format!(
            "SELECT num_rows FROM all_tables WHERE owner = {o} AND table_name = {t}"
        ))
        .await?
        .first()
        .and_then(|r| opt(r, 0))
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| v as i64)
    } else {
        None
    };
    Ok(TableMeta {
        columns,
        indexes,
        foreign_keys,
        referenced_by,
        estimated_rows,
        is_view: None,
    })
}
