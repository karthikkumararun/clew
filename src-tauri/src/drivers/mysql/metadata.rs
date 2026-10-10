//! Structure, indexes, foreign keys and statistics of a table, from `information_schema`.

use std::collections::BTreeMap;

use sqlx::AssertSqlSafe;

use super::introspect::MyMeta;
use crate::drivers::introspect::{NodeKind, NodePath};
use crate::drivers::table_meta::{
    ColumnDetail, ForeignKeyDetail, IndexDetail, ReferencedBy, TableMeta,
};
use crate::drivers::{DriverError, DriverResult};

type ColumnRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);
type IndexRow = (String, i64, String, String, i64);
type KeyRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
);

fn opt(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

pub async fn table_meta(meta: &MyMeta, path: &NodePath) -> DriverResult<TableMeta> {
    let table = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name a table"))?
        .name
        .as_str();
    let db = path
        .find(NodeKind::Database)
        .ok_or_else(|| DriverError::internal("The table is not inside a database"))?;

    let columns: Vec<ColumnRow> = sqlx::query_as(
        "SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), CAST(IS_NULLABLE AS CHAR), \
                CAST(COLUMN_DEFAULT AS CHAR), CAST(COLUMN_KEY AS CHAR), CAST(COLUMN_COMMENT AS CHAR) \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(db)
    .bind(table)
    .fetch_all(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;

    let index_rows: Vec<IndexRow> = sqlx::query_as(
        "SELECT CAST(INDEX_NAME AS CHAR), CAST(NON_UNIQUE AS SIGNED), CAST(INDEX_TYPE AS CHAR), \
                CAST(COLUMN_NAME AS CHAR), CAST(SEQ_IN_INDEX AS SIGNED) \
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(db)
    .bind(table)
    .fetch_all(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;
    let mut grouped: BTreeMap<String, IndexDetail> = BTreeMap::new();
    for (name, non_unique, method, column, _) in index_rows {
        grouped
            .entry(name.clone())
            .or_insert_with(|| IndexDetail {
                primary: name == "PRIMARY",
                name,
                columns: vec![],
                unique: non_unique == 0,
                method: Some(method.to_lowercase()),
                size_bytes: None,
            })
            .columns
            .push(column);
    }

    const KEY_SELECT: &str = "SELECT CAST(k.CONSTRAINT_NAME AS CHAR), CAST(k.COLUMN_NAME AS CHAR), \
        CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR), CAST(k.REFERENCED_TABLE_NAME AS CHAR), \
        CAST(k.REFERENCED_COLUMN_NAME AS CHAR), CAST(r.DELETE_RULE AS CHAR), \
        CAST(r.UPDATE_RULE AS CHAR), CAST(k.TABLE_NAME AS CHAR), CAST(k.ORDINAL_POSITION AS SIGNED) \
        FROM information_schema.KEY_COLUMN_USAGE k \
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
         AND r.TABLE_NAME = k.TABLE_NAME";

    let outgoing: Vec<KeyRow> = sqlx::query_as(AssertSqlSafe(format!(
        "{KEY_SELECT} WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? \
         AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
    )))
    .bind(db)
    .bind(table)
    .fetch_all(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;
    let mut fks: BTreeMap<String, ForeignKeyDetail> = BTreeMap::new();
    for (name, col, ref_schema, ref_table, ref_col, del, upd, _, _) in outgoing {
        let fk = fks.entry(name.clone()).or_insert_with(|| ForeignKeyDetail {
            name,
            columns: vec![],
            ref_schema: Some(ref_schema),
            ref_table,
            ref_columns: vec![],
            on_update: opt(Some(upd)),
            on_delete: opt(Some(del)),
        });
        fk.columns.push(col);
        fk.ref_columns.push(ref_col);
    }

    let incoming: Vec<KeyRow> = sqlx::query_as(AssertSqlSafe(format!(
        "{KEY_SELECT} WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ? \
         ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
    )))
    .bind(db)
    .bind(table)
    .fetch_all(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?;
    let mut refs: BTreeMap<(String, String), ReferencedBy> = BTreeMap::new();
    for (name, col, _, _, ref_col, _, _, child, _) in incoming {
        let r = refs
            .entry((child.clone(), name.clone()))
            .or_insert_with(|| ReferencedBy {
                name,
                schema: Some(db.to_string()),
                table: child,
                columns: vec![],
                ref_columns: vec![],
            });
        r.columns.push(col);
        r.ref_columns.push(ref_col);
    }

    let estimate: Option<i64> = sqlx::query_scalar(
        "SELECT CAST(TABLE_ROWS AS SIGNED) FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'",
    )
    .bind(db)
    .bind(table)
    .fetch_optional(&meta.pool)
    .await
    .map_err(|e| meta.err(e))?
    .flatten();

    Ok(TableMeta {
        columns: columns
            .into_iter()
            .map(
                |(name, type_name, nullable, default, key, comment)| ColumnDetail {
                    name,
                    type_name,
                    nullable: nullable == "YES",
                    default,
                    primary_key: key == "PRI",
                    comment: opt(comment),
                },
            )
            .collect(),
        indexes: grouped.into_values().collect(),
        foreign_keys: fks.into_values().collect(),
        referenced_by: refs.into_values().collect(),
        estimated_rows: estimate,
    })
}
