//! Structure, indexes and foreign keys of a table, from SQLite's pragmas.

use sqlx::Row;

use super::introspect::{q, SqliteMeta};
use crate::drivers::introspect::{NodeKind, NodePath};
use crate::drivers::table_meta::{
    ColumnDetail, ForeignKeyDetail, Generation, IndexDetail, ReferencedBy, TableMeta,
};
use crate::drivers::{DriverError, DriverResult};

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub async fn table_meta(meta: &SqliteMeta, path: &NodePath) -> DriverResult<TableMeta> {
    let table = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name a table"))?
        .name
        .as_str();
    let db = path.find(NodeKind::Database).unwrap_or("main");

    // `table_xinfo` also reports generated columns (hidden = 2 virtual, 3 stored).
    let mut columns = Vec::new();
    for r in meta
        .rows(format!("PRAGMA {}.table_xinfo({})", q(db), lit(table)))
        .await?
    {
        let hidden: i64 = r.try_get("hidden").unwrap_or(0);
        if hidden == 1 {
            continue; // a virtual-table hidden column, not part of the table's own shape
        }
        let pk: i64 = r.try_get("pk").unwrap_or(0);
        let notnull: i64 = r.try_get("notnull").unwrap_or(0);
        columns.push(ColumnDetail {
            name: r.try_get("name").unwrap_or_default(),
            type_name: r.try_get("type").unwrap_or_default(),
            // A primary key column that is a lone INTEGER is an alias for the rowid.
            nullable: notnull == 0 && pk == 0,
            default: r.try_get::<Option<String>, _>("dflt_value").ok().flatten(),
            primary_key: pk > 0,
            comment: None,
            generated: matches!(hidden, 2 | 3).then_some(Generation::Always),
        });
    }

    let mut indexes = Vec::new();
    for r in meta
        .rows(format!("PRAGMA {}.index_list({})", q(db), lit(table)))
        .await?
    {
        let name: String = r.try_get("name").unwrap_or_default();
        let origin: String = r.try_get("origin").unwrap_or_default();
        let unique: i64 = r.try_get("unique").unwrap_or(0);
        let cols = meta
            .rows(format!("PRAGMA {}.index_info({})", q(db), lit(&name)))
            .await?
            .iter()
            .map(|c| {
                c.try_get::<Option<String>, _>("name")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "(expression)".into())
            })
            .collect();
        indexes.push(IndexDetail {
            primary: origin == "pk",
            name,
            columns: cols,
            unique: unique == 1,
            method: Some("btree".into()),
            size_bytes: None,
        });
    }

    let mut foreign_keys: Vec<ForeignKeyDetail> = Vec::new();
    for r in meta
        .rows(format!("PRAGMA {}.foreign_key_list({})", q(db), lit(table)))
        .await?
    {
        let id: i64 = r.try_get("id").unwrap_or(0);
        let from: String = r.try_get("from").unwrap_or_default();
        let to: String = r
            .try_get::<Option<String>, _>("to")
            .ok()
            .flatten()
            .unwrap_or_default();
        let name = format!("fk_{table}_{id}");
        if let Some(fk) = foreign_keys.iter_mut().find(|f| f.name == name) {
            fk.columns.push(from);
            fk.ref_columns.push(to);
        } else {
            foreign_keys.push(ForeignKeyDetail {
                name,
                columns: vec![from],
                ref_schema: None,
                ref_table: r.try_get("table").unwrap_or_default(),
                ref_columns: vec![to],
                on_update: r.try_get("on_update").ok(),
                on_delete: r.try_get("on_delete").ok(),
            });
        }
    }

    let mut referenced_by: Vec<ReferencedBy> = Vec::new();
    for r in meta
        .rows(format!(
            "SELECT m.name AS child, f.id AS id, f.\"from\" AS child_col, f.\"to\" AS parent_col \
             FROM {db}.sqlite_master m, pragma_foreign_key_list(m.name, {schema}) f \
             WHERE m.type = 'table' AND f.\"table\" = {table} COLLATE NOCASE \
             ORDER BY m.name, f.id, f.seq",
            db = q(db),
            schema = lit(db),
            table = lit(table)
        ))
        .await?
    {
        let child: String = r.try_get("child").unwrap_or_default();
        let id: i64 = r.try_get("id").unwrap_or(0);
        let name = format!("fk_{child}_{id}");
        let from: String = r.try_get("child_col").unwrap_or_default();
        let to: String = r
            .try_get::<Option<String>, _>("parent_col")
            .ok()
            .flatten()
            .unwrap_or_default();
        if let Some(x) = referenced_by
            .iter_mut()
            .find(|x| x.name == name && x.table == child)
        {
            x.columns.push(from);
            x.ref_columns.push(to);
        } else {
            referenced_by.push(ReferencedBy {
                name,
                schema: None,
                table: child,
                columns: vec![from],
                ref_columns: vec![to],
            });
        }
    }

    let object_type: Option<String> = meta
        .rows(format!(
            "SELECT type FROM {}.sqlite_master WHERE name = {} COLLATE NOCASE",
            q(db),
            lit(table)
        ))
        .await?
        .first()
        .and_then(|r| r.try_get("type").ok());

    Ok(TableMeta {
        columns,
        indexes,
        foreign_keys,
        referenced_by,
        estimated_rows: None,
        is_view: object_type.map(|t| t == "view"),
    })
}
