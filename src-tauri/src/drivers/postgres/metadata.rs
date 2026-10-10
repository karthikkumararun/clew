//! Structure, indexes, foreign keys and statistics of a table, from the catalogue.

use super::introspect::PgMeta;
use crate::drivers::introspect::{NodeKind, NodePath};
use crate::drivers::table_meta::{
    pg_action, ColumnDetail, ForeignKeyDetail, IndexDetail, ReferencedBy, TableMeta,
};
use crate::drivers::{DriverError, DriverResult};

const REL: &str = "(SELECT c.oid FROM pg_class c WHERE c.relname = $2 AND c.relnamespace = \
                   (SELECT oid FROM pg_namespace WHERE nspname = $1))";

type ColumnRow = (String, String, bool, Option<String>, bool, Option<String>);
type IndexRow = (String, bool, bool, String, Option<i64>, Vec<String>);
type KeyRow = (
    String,
    Vec<String>,
    String,
    String,
    Vec<String>,
    String,
    String,
);
type IncomingRow = (String, Vec<String>, String, String, Vec<String>);

pub async fn table_meta(meta: &PgMeta, path: &NodePath) -> DriverResult<TableMeta> {
    let table = path
        .0
        .last()
        .ok_or_else(|| DriverError::internal("The path does not name a table"))?
        .name
        .as_str();
    let schema = path
        .find(NodeKind::Schema)
        .ok_or_else(|| DriverError::internal("The table is not inside a schema"))?;
    let pool = meta.pool(path.find(NodeKind::Database)).await?;

    let columns: Vec<ColumnRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                pg_get_expr(d.adbin, d.adrelid), \
                COALESCE(a.attnum = ANY (pk.indkey::int2[]), false), \
                col_description(a.attrelid, a.attnum) \
         FROM pg_attribute a \
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
         LEFT JOIN pg_index pk ON pk.indrelid = a.attrelid AND pk.indisprimary \
         WHERE a.attrelid = {REL} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
    )))
    .bind(schema)
    .bind(table)
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    let indexes: Vec<IndexRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT i.relname::text, x.indisunique, x.indisprimary, am.amname::text, \
                pg_relation_size(i.oid), \
                COALESCE((SELECT array_agg(COALESCE(a.attname::text, '(expression)') ORDER BY k.ord) \
                            FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) \
                            LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum), \
                         ARRAY[]::text[]) \
         FROM pg_index x \
         JOIN pg_class i ON i.oid = x.indexrelid \
         JOIN pg_am am ON am.oid = i.relam \
         WHERE x.indrelid = {REL} ORDER BY i.relname"
    )))
    .bind(schema)
    .bind(table)
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    let names = |key: &str, rel: &str| {
        format!(
            "(SELECT array_agg(a.attname::text ORDER BY k.ord) \
               FROM unnest(c.{key}) WITH ORDINALITY AS k(attnum, ord) \
               JOIN pg_attribute a ON a.attrelid = c.{rel} AND a.attnum = k.attnum)"
        )
    };

    let outgoing: Vec<KeyRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT c.conname::text, {cols}, rn.nspname::text, rc.relname::text, {refs}, \
                c.confupdtype::text, c.confdeltype::text \
         FROM pg_constraint c \
         JOIN pg_class rc ON rc.oid = c.confrelid \
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace \
         WHERE c.contype = 'f' AND c.conrelid = {REL} ORDER BY c.conname",
        cols = names("conkey", "conrelid"),
        refs = names("confkey", "confrelid"),
    )))
    .bind(schema)
    .bind(table)
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    let incoming: Vec<IncomingRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT c.conname::text, {cols}, cn.nspname::text, cc.relname::text, {refs} \
         FROM pg_constraint c \
         JOIN pg_class cc ON cc.oid = c.conrelid \
         JOIN pg_namespace cn ON cn.oid = cc.relnamespace \
         WHERE c.contype = 'f' AND c.confrelid = {REL} ORDER BY cn.nspname, cc.relname, c.conname",
        cols = names("conkey", "conrelid"),
        refs = names("confkey", "confrelid"),
    )))
    .bind(schema)
    .bind(table)
    .fetch_all(&pool)
    .await
    .map_err(|e| meta.err(e))?;

    let estimate: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT CASE WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0 \
                     THEN c.reltuples::bigint END FROM pg_class c WHERE c.oid = {REL}"
    )))
    .bind(schema)
    .bind(table)
    .fetch_optional(&pool)
    .await
    .map_err(|e| meta.err(e))?
    .flatten();

    Ok(TableMeta {
        columns: columns
            .into_iter()
            .map(
                |(name, type_name, nullable, default, primary_key, comment)| ColumnDetail {
                    name,
                    type_name,
                    nullable,
                    default,
                    primary_key,
                    comment,
                },
            )
            .collect(),
        indexes: indexes
            .into_iter()
            .map(
                |(name, unique, primary, method, size, columns)| IndexDetail {
                    name,
                    columns,
                    unique,
                    primary,
                    method: Some(method),
                    size_bytes: size,
                },
            )
            .collect(),
        foreign_keys: outgoing
            .into_iter()
            .map(
                |(name, columns, ref_schema, ref_table, ref_columns, upd, del)| ForeignKeyDetail {
                    name,
                    columns,
                    ref_schema: Some(ref_schema),
                    ref_table,
                    ref_columns,
                    on_update: pg_action(&upd),
                    on_delete: pg_action(&del),
                },
            )
            .collect(),
        referenced_by: incoming
            .into_iter()
            .map(|(name, columns, schema, table, ref_columns)| ReferencedBy {
                name,
                schema: Some(schema),
                table,
                columns,
                ref_columns,
            })
            .collect(),
        estimated_rows: estimate,
    })
}
