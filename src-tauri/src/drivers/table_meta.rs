//! Everything the table editor's Structure / Indexes / Relations views and its key detection
//! need to know about one table, read through the metadata pool.

use serde::Serialize;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDetail {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    pub comment: Option<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDetail {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    /// `btree`, `hash`, …
    pub method: Option<String>,
    #[ts(type = "number | null")]
    pub size_bytes: Option<i64>,
}

/// A foreign key of this table, pointing at another.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDetail {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

/// A foreign key of another table that points at this one.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencedBy {
    pub name: String,
    pub schema: Option<String>,
    pub table: String,
    /// The referencing columns, in the other table.
    pub columns: Vec<String>,
    /// The columns of this table they point at.
    pub ref_columns: Vec<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexDetail>,
    pub foreign_keys: Vec<ForeignKeyDetail>,
    pub referenced_by: Vec<ReferencedBy>,
    /// From the server's statistics; none when it has none (or for a view).
    #[ts(type = "number | null")]
    pub estimated_rows: Option<i64>,
}

/// `a` → `NO ACTION` etc. for PostgreSQL's single-letter referential actions.
pub fn pg_action(code: &str) -> Option<String> {
    Some(
        match code {
            "a" => "NO ACTION",
            "r" => "RESTRICT",
            "c" => "CASCADE",
            "n" => "SET NULL",
            "d" => "SET DEFAULT",
            _ => return None,
        }
        .to_string(),
    )
}
