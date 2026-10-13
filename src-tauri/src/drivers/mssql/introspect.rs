//! Schema introspection for SQL Server from the `sys` catalog views: databases → schemas →
//! object groups → objects → columns. Names are three-part (`[db].sys.tables`), so any database
//! on the server can be browsed without switching the metadata connection's context.

use std::sync::Arc;

use tiberius::ColumnData;

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

/// An N'…' string literal.
fn lit(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

/// A bracketed identifier.
pub fn q(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn s(v: &ColumnData<'static>) -> String {
    match v {
        ColumnData::String(Some(t)) => t.to_string(),
        ColumnData::I32(Some(n)) => n.to_string(),
        ColumnData::I64(Some(n)) => n.to_string(),
        ColumnData::I16(Some(n)) => n.to_string(),
        ColumnData::U8(Some(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn opt(v: &ColumnData<'static>) -> Option<String> {
    let t = s(v);
    (!t.is_empty()).then_some(t)
}

fn n(v: &ColumnData<'static>) -> i64 {
    match v {
        ColumnData::I64(Some(x)) => *x,
        ColumnData::I32(Some(x)) => (*x).into(),
        ColumnData::I16(Some(x)) => (*x).into(),
        ColumnData::U8(Some(x)) => (*x).into(),
        ColumnData::Numeric(Some(x)) => x.int_part() as i64,
        ColumnData::F64(Some(x)) => *x as i64,
        _ => 0,
    }
}

fn b(v: &ColumnData<'static>) -> bool {
    matches!(v, ColumnData::Bit(Some(true)))
}

fn csv(v: &ColumnData<'static>) -> Vec<String> {
    s(v).split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

/// `s.name = N'…'` for the schema a catalog view row belongs to.
fn schema_is(alias: &str, schema: &str) -> String {
    format!("{alias}.name = {}", lit(schema))
}

pub async fn children(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
    let Some(last) = path.last() else {
        let rows = meta
            .rows("SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state = 0 ORDER BY name")
            .await?;
        return Ok(rows
            .iter()
            .map(|r| TreeNode::new(path, NodeKind::Database, s(&r[0]), true))
            .collect());
    };
    let db = path.find(NodeKind::Database).unwrap_or_default();
    let schema = path.find(NodeKind::Schema).unwrap_or("dbo");
    match last.kind {
        NodeKind::Database => {
            let rows = meta
                .rows(&format!(
                    "SELECT name FROM {}.sys.schemas WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') \
                     AND name NOT LIKE 'db[_]%' ORDER BY name",
                    q(&last.name)
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| TreeNode::new(path, NodeKind::Schema, s(&r[0]), true))
                .collect())
        }
        NodeKind::Schema => groups(meta, path, db, &last.name).await,
        NodeKind::Group => members(meta, path, db, schema, &last.name).await,
        NodeKind::Table | NodeKind::View => columns(meta, path, db, schema, &last.name).await,
        _ => Ok(vec![]),
    }
}

async fn groups(
    meta: &Arc<Meta>,
    parent: &NodePath,
    db: &str,
    schema: &str,
) -> DriverResult<Vec<TreeNode>> {
    let d = q(db);
    let at = schema_is("s", schema);
    let rows = meta
        .rows(&format!(
            "SELECT 'tables', COUNT(*) FROM {d}.sys.tables o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE {at} \
             UNION ALL SELECT 'views', COUNT(*) FROM {d}.sys.views o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE {at} \
             UNION ALL SELECT 'procedures', COUNT(*) FROM {d}.sys.procedures o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE {at} AND o.is_ms_shipped = 0 \
             UNION ALL SELECT 'functions', COUNT(*) FROM {d}.sys.objects o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE {at} AND o.type IN ('FN', 'IF', 'TF') AND o.is_ms_shipped = 0"
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let c = n(&r[1]);
            TreeNode::new(parent, NodeKind::Group, s(&r[0]), c > 0).with_detail(c.to_string())
        })
        .collect())
}

async fn members(
    meta: &Arc<Meta>,
    parent: &NodePath,
    db: &str,
    schema: &str,
    group: &str,
) -> DriverResult<Vec<TreeNode>> {
    let d = q(db);
    let at = schema_is("s", schema);
    let (sql, kind) = match group {
        "tables" => (
            format!(
                "SELECT o.name, SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) FROM {d}.sys.tables o \
                 JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN {d}.sys.partitions p ON p.object_id = o.object_id \
                 WHERE {at} GROUP BY o.name ORDER BY o.name"
            ),
            NodeKind::Table,
        ),
        "views" => (
            format!("SELECT o.name, NULL FROM {d}.sys.views o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE {at} ORDER BY o.name"),
            NodeKind::View,
        ),
        "procedures" => (
            format!("SELECT o.name, NULL FROM {d}.sys.procedures o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE {at} AND o.is_ms_shipped = 0 ORDER BY o.name"),
            NodeKind::Procedure,
        ),
        "functions" => (
            format!("SELECT o.name, NULL FROM {d}.sys.objects o JOIN {d}.sys.schemas s ON s.schema_id = o.schema_id WHERE {at} AND o.type IN ('FN', 'IF', 'TF') AND o.is_ms_shipped = 0 ORDER BY o.name"),
            NodeKind::Function,
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
                s(&r[0]),
                matches!(kind, NodeKind::Table | NodeKind::View),
            );
            match (kind, &r[1]) {
                (NodeKind::Table, ColumnData::Numeric(None) | ColumnData::I64(None)) => node,
                (NodeKind::Table, rows) => node.with_detail(format_count(n(rows))),
                _ => node,
            }
        })
        .collect())
}

/// SQL that renders a column's type the way it is declared (`nvarchar(50)`, `decimal(10,2)`).
fn type_sql(col: &str, ty: &str) -> String {
    format!(
        "CASE WHEN {ty}.name IN ('varchar', 'char', 'varbinary', 'binary') THEN {ty}.name + '(' + CASE WHEN {col}.max_length = -1 THEN 'max' ELSE CAST({col}.max_length AS varchar(10)) END + ')' \
         WHEN {ty}.name IN ('nvarchar', 'nchar') THEN {ty}.name + '(' + CASE WHEN {col}.max_length = -1 THEN 'max' ELSE CAST({col}.max_length / 2 AS varchar(10)) END + ')' \
         WHEN {ty}.name IN ('decimal', 'numeric') THEN {ty}.name + '(' + CAST({col}.precision AS varchar(10)) + ',' + CAST({col}.scale AS varchar(10)) + ')' \
         WHEN {ty}.name IN ('datetime2', 'time', 'datetimeoffset') THEN {ty}.name + '(' + CAST({col}.scale AS varchar(10)) + ')' \
         ELSE {ty}.name END"
    )
}

fn object_id(db: &str, schema: &str, name: &str) -> String {
    lit(&format!("{}.{}.{}", q(db), q(schema), q(name)))
}

async fn columns(
    meta: &Arc<Meta>,
    parent: &NodePath,
    db: &str,
    schema: &str,
    table: &str,
) -> DriverResult<Vec<TreeNode>> {
    let d = q(db);
    let rows = meta
        .rows(&format!(
            "SELECT c.name, {ty}, c.is_nullable, dc.definition, \
             CASE WHEN EXISTS (SELECT 1 FROM {d}.sys.index_columns ic JOIN {d}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
               WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END, \
             (SELECT TOP 1 rt.name + '.' + rc.name FROM {d}.sys.foreign_key_columns fkc \
               JOIN {d}.sys.tables rt ON rt.object_id = fkc.referenced_object_id \
               JOIN {d}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
               WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id) \
             FROM {d}.sys.columns c JOIN {d}.sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN {d}.sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
             WHERE c.object_id = OBJECT_ID({oid}) ORDER BY c.column_id",
            ty = type_sql("c", "ty"),
            oid = object_id(db, schema, table),
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let mut node = TreeNode::new(parent, NodeKind::Column, s(&r[0]), false);
            node.column = Some(ColumnInfo {
                type_name: s(&r[1]),
                nullable: b(&r[2]),
                default: opt(&r[3]),
                primary_key: n(&r[4]) == 1,
                foreign_key: opt(&r[5]),
            });
            node
        })
        .collect())
}

const FUNCTIONS: &[&str] = &[
    "abs",
    "avg",
    "cast",
    "ceiling",
    "charindex",
    "coalesce",
    "concat",
    "concat_ws",
    "convert",
    "count",
    "count_big",
    "dateadd",
    "datediff",
    "datename",
    "datepart",
    "day",
    "eomonth",
    "floor",
    "format",
    "getdate",
    "getutcdate",
    "iif",
    "isnull",
    "isnumeric",
    "left",
    "len",
    "lower",
    "ltrim",
    "max",
    "min",
    "month",
    "newid",
    "nullif",
    "object_id",
    "patindex",
    "power",
    "replace",
    "replicate",
    "reverse",
    "right",
    "round",
    "row_number",
    "rtrim",
    "scope_identity",
    "sign",
    "sqrt",
    "string_agg",
    "string_split",
    "stuff",
    "substring",
    "sum",
    "sysdatetime",
    "trim",
    "try_cast",
    "try_convert",
    "upper",
    "year",
];

pub async fn snapshot(meta: &Arc<Meta>, db: &str) -> DriverResult<SchemaSnapshot> {
    let d = if db.is_empty() {
        "DB_NAME()".to_string()
    } else {
        q(db)
    };
    let d = if db.is_empty() {
        String::new()
    } else {
        format!("{d}.")
    };
    let rows = meta
        .rows(&format!(
            "SELECT s.name, o.name, o.type, c.name, ty.name FROM {d}sys.objects o \
             JOIN {d}sys.schemas s ON s.schema_id = o.schema_id \
             JOIN {d}sys.columns c ON c.object_id = o.object_id \
             JOIN {d}sys.types ty ON ty.user_type_id = c.user_type_id \
             WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name, c.column_id"
        ))
        .await?;
    let functions: Vec<String> = FUNCTIONS.iter().map(|f| f.to_string()).collect();
    let mut schemas: Vec<SnapshotSchema> = Vec::new();
    for r in &rows {
        let (schema, table) = (s(&r[0]), s(&r[1]));
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
                    name: table,
                    kind: if s(&r[2]).trim() == "V" {
                        NodeKind::View
                    } else {
                        NodeKind::Table
                    },
                    columns: vec![],
                });
                tables.len() - 1
            }
        };
        tables[ti].columns.push(SnapshotColumn {
            name: s(&r[3]),
            type_name: s(&r[4]),
        });
    }
    Ok(SchemaSnapshot {
        schemas,
        ..Default::default()
    })
}

fn target(path: &NodePath) -> DriverResult<(String, String, String, NodeKind)> {
    let last = path
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name an object"))?;
    Ok((
        path.find(NodeKind::Database)
            .unwrap_or_default()
            .to_string(),
        path.find(NodeKind::Schema).unwrap_or("dbo").to_string(),
        last.name.clone(),
        last.kind,
    ))
}

pub async fn count_rows(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<i64> {
    let (db, schema, name, _) = target(path)?;
    let rows = meta
        .rows(&format!(
            "SELECT COUNT_BIG(*) FROM {}.{}.{}",
            q(&db),
            q(&schema),
            q(&name)
        ))
        .await?;
    Ok(rows.first().map_or(0, |r| n(&r[0])))
}

pub async fn table_meta(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<TableMeta> {
    let (db, schema, name, kind) = target(path)?;
    let d = q(&db);
    let oid = object_id(&db, &schema, &name);

    let columns = meta
        .rows(&format!(
            "SELECT c.name, {ty}, c.is_nullable, dc.definition, \
             CASE WHEN EXISTS (SELECT 1 FROM {d}.sys.index_columns ic JOIN {d}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
               WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END, \
             CAST(ep.value AS nvarchar(4000)), c.is_computed, c.is_identity \
             FROM {d}.sys.columns c JOIN {d}.sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN {d}.sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
             LEFT JOIN {d}.sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' \
             WHERE c.object_id = OBJECT_ID({oid}) ORDER BY c.column_id",
            ty = type_sql("c", "ty"),
        ))
        .await?
        .iter()
        .map(|r| ColumnDetail {
            name: s(&r[0]),
            type_name: s(&r[1]),
            nullable: b(&r[2]),
            default: opt(&r[3]),
            primary_key: n(&r[4]) == 1,
            comment: opt(&r[5]),
            generated: (b(&r[6]) || b(&r[7]))
                .then_some(crate::drivers::table_meta::Generation::Always),
        })
        .collect();

    let indexes = meta
        .rows(&format!(
            "SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, \
             STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) \
             FROM {d}.sys.indexes i JOIN {d}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 \
             JOIN {d}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE i.object_id = OBJECT_ID({oid}) AND i.name IS NOT NULL \
             GROUP BY i.name, i.is_unique, i.is_primary_key, i.type_desc ORDER BY i.is_primary_key DESC, i.name"
        ))
        .await?
        .iter()
        .map(|r| IndexDetail {
            name: s(&r[0]),
            unique: b(&r[1]),
            primary: b(&r[2]),
            method: opt(&r[3]),
            columns: csv(&r[4]),
            size_bytes: None,
        })
        .collect();

    let foreign_keys = meta
        .rows(&format!(
            "SELECT fk.name, STRING_AGG(pc.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id), rs.name, rt.name, \
             STRING_AGG(rc.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id), \
             fk.update_referential_action_desc, fk.delete_referential_action_desc \
             FROM {d}.sys.foreign_keys fk JOIN {d}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN {d}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
             JOIN {d}.sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN {d}.sys.schemas rs ON rs.schema_id = rt.schema_id \
             JOIN {d}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
             WHERE fk.parent_object_id = OBJECT_ID({oid}) \
             GROUP BY fk.name, rs.name, rt.name, fk.update_referential_action_desc, fk.delete_referential_action_desc"
        ))
        .await?
        .iter()
        .map(|r| ForeignKeyDetail {
            name: s(&r[0]),
            columns: csv(&r[1]),
            ref_schema: opt(&r[2]),
            ref_table: s(&r[3]),
            ref_columns: csv(&r[4]),
            on_update: opt(&r[5]).map(|a| a.replace('_', " ")),
            on_delete: opt(&r[6]).map(|a| a.replace('_', " ")),
        })
        .collect();

    let referenced_by = meta
        .rows(&format!(
            "SELECT fk.name, ps.name, pt.name, STRING_AGG(pc.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id), \
             STRING_AGG(rc.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id) \
             FROM {d}.sys.foreign_keys fk JOIN {d}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN {d}.sys.tables pt ON pt.object_id = fk.parent_object_id JOIN {d}.sys.schemas ps ON ps.schema_id = pt.schema_id \
             JOIN {d}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
             JOIN {d}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
             WHERE fk.referenced_object_id = OBJECT_ID({oid}) GROUP BY fk.name, ps.name, pt.name"
        ))
        .await?
        .iter()
        .map(|r| ReferencedBy {
            name: s(&r[0]),
            schema: opt(&r[1]),
            table: s(&r[2]),
            columns: csv(&r[3]),
            ref_columns: csv(&r[4]),
        })
        .collect();

    let estimated_rows = if kind == NodeKind::Table {
        meta.rows(&format!(
            "SELECT SUM(p.rows) FROM {d}.sys.partitions p WHERE p.object_id = OBJECT_ID({oid}) AND p.index_id IN (0, 1)"
        ))
        .await?
        .first()
        .map(|r| n(&r[0]))
    } else {
        None
    };
    let is_view = meta
        .rows(&format!(
            "SELECT type FROM {d}.sys.objects WHERE object_id = OBJECT_ID({oid})"
        ))
        .await?
        .first()
        .map(|r| s(&r[0]).trim() == "V");
    Ok(TableMeta {
        columns,
        indexes,
        foreign_keys,
        referenced_by,
        estimated_rows,
        is_view,
    })
}

/// The statement that creates the object. Views, procedures and functions are stored as text;
/// tables are rebuilt from the catalog (columns, primary key, foreign keys).
pub async fn ddl(meta: &Arc<Meta>, path: &NodePath) -> DriverResult<String> {
    let (db, schema, name, kind) = target(path)?;
    let d = q(&db);
    match kind {
        NodeKind::View | NodeKind::Procedure | NodeKind::Function => {
            let rows = meta
                .rows(&format!(
                    "SELECT definition FROM {d}.sys.sql_modules WHERE object_id = OBJECT_ID({})",
                    object_id(&db, &schema, &name)
                ))
                .await?;
            rows.first().and_then(|r| opt(&r[0])).ok_or_else(|| {
                DriverError::new(
                    ErrorCode::QueryFailed,
                    format!("{name} has no stored definition (it may be encrypted)"),
                )
            })
        }
        NodeKind::Table => {
            let m = table_meta(meta, path).await?;
            let identity = meta
                .rows(&format!(
                    "SELECT c.name, CAST(ic.seed_value AS bigint), CAST(ic.increment_value AS bigint) FROM {d}.sys.identity_columns ic \
                     JOIN {d}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                     WHERE ic.object_id = OBJECT_ID({})",
                    object_id(&db, &schema, &name)
                ))
                .await?;
            let mut lines: Vec<String> = m
                .columns
                .iter()
                .map(|c| {
                    let mut l = format!("    {} {}", q(&c.name), c.type_name);
                    if let Some(i) = identity.iter().find(|i| s(&i[0]) == c.name) {
                        l.push_str(&format!(" IDENTITY({},{})", n(&i[1]), n(&i[2])));
                    }
                    l.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
                    if let Some(def) = &c.default {
                        l.push_str(&format!(" DEFAULT {def}"));
                    }
                    l
                })
                .collect();
            let cols = |v: &[String]| v.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
            if let Some(pk) = m.indexes.iter().find(|i| i.primary) {
                lines.push(format!(
                    "    CONSTRAINT {} PRIMARY KEY ({})",
                    q(&pk.name),
                    cols(&pk.columns)
                ));
            }
            for u in m.indexes.iter().filter(|i| i.unique && !i.primary) {
                lines.push(format!(
                    "    CONSTRAINT {} UNIQUE ({})",
                    q(&u.name),
                    cols(&u.columns)
                ));
            }
            for fk in &m.foreign_keys {
                let mut l = format!(
                    "    CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
                    q(&fk.name),
                    cols(&fk.columns),
                    q(fk.ref_schema.as_deref().unwrap_or("dbo")),
                    q(&fk.ref_table),
                    cols(&fk.ref_columns)
                );
                if let Some(a) = fk.on_delete.as_deref().filter(|a| *a != "NO ACTION") {
                    l.push_str(&format!(" ON DELETE {a}"));
                }
                if let Some(a) = fk.on_update.as_deref().filter(|a| *a != "NO ACTION") {
                    l.push_str(&format!(" ON UPDATE {a}"));
                }
                lines.push(l);
            }
            Ok(format!(
                "CREATE TABLE {}.{} (\n{}\n);",
                q(&schema),
                q(&name),
                lines.join(",\n")
            ))
        }
        _ => Err(DriverError::unsupported("Showing DDL for this object")),
    }
}
