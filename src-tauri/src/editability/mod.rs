//! Can this result be edited, and through which table? The console's Result tab asks
//! `results_resolve_edit` after every run; the answer is either an edit plan (target table, which
//! result column is which table column, the key) or the specific reason the result is read-only.
//!
//! Provenance from the driver wins; drivers that report none are inferred from the statement
//! ([`analyze`]). Keys, generated columns and views come from the introspection cache.

pub mod analyze;
pub mod resolve;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub use resolve::{resolve_edit, TableInfo};

/// A table, as the schema it lives in (when the driver has schemas) and its name.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableRef {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
}

impl TableRef {
    /// `schema.table`, or just `table`.
    pub fn display(&self) -> String {
        match &self.schema {
            Some(s) => format!("{s}.{}", self.table),
            None => self.table.clone(),
        }
    }

    /// Same table, ignoring letter case (unquoted names fold differently per database).
    pub fn same_as(&self, other: &TableRef) -> bool {
        self.table.eq_ignore_ascii_case(&other.table)
            && match (&self.schema, &other.schema) {
                (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                _ => true,
            }
    }
}

/// Whether one result column can be edited, and if not why (shown when hovering its header).
/// "Key columns can't be changed" is not decided here: it depends on the row.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnEdit {
    pub editable: bool,
    pub reason: Option<String>,
    /// Whether the table column accepts NULL (Set NULL is hidden when it does not).
    pub nullable: bool,
    /// Whether the table fills the column when no value is given (Set DEFAULT, new rows).
    pub has_default: bool,
}

/// A table seen in the result, and whether it can be the edit target.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub schema: Option<String>,
    pub table: String,
    /// Its whole key is in the result and it is a table (not a view).
    pub available: bool,
    /// The key columns the result lacks ("key missing (add u.id)").
    pub missing_keys: Vec<String>,
    /// The table has no primary or unique non-null key.
    pub no_key: bool,
    pub is_view: bool,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadOnlyCode {
    /// The table's key is not (entirely) among the result's columns.
    NoKeyInResult,
    /// The table has no primary or unique key at all.
    NoKeyOnTable,
    /// Several tables and none has its whole key in the result.
    MultipleTables,
    SessionReadOnly,
    /// DISTINCT, GROUP BY, aggregates, window functions, UNION: the rows are not table rows.
    Aggregate,
    View,
    /// The origin of the columns can't be told.
    Unknown,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyReason {
    pub code: ReadOnlyCode,
    /// What the chip says.
    pub message: String,
    /// What would fix it ("Add id to the SELECT", "Switch to read-write"), when something would.
    pub fix: Option<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditResolution {
    #[serde(rename_all = "camelCase")]
    Editable {
        target: TableRef,
        /// The target came from parsing the statement, not from the driver's provenance.
        inferred: bool,
        /// Per result column: the column of the target it reads, `None` when it is not one.
        column_map: Vec<Option<String>>,
        /// The target's key columns, primary key first, else the first unique non-null index.
        key_columns: Vec<String>,
        /// The result column holding each key column (same order as `key_columns`).
        #[ts(type = "number[]")]
        key_indexes: Vec<usize>,
        /// Per result column.
        columns: Vec<ColumnEdit>,
        /// Every table seen in the result, in `FROM` order, the chosen one included.
        candidates: Vec<Candidate>,
    },
    #[serde(rename_all = "camelCase")]
    ReadOnly {
        reason: ReadOnlyReason,
        candidates: Vec<Candidate>,
    },
}

/// How long a table's keys and flags are reused before the catalogue is asked again.
const TTL: Duration = Duration::from_secs(30);

type CacheKey = (String, String, String);

/// Table structure per connection and table, so resolving a result costs no round trip after the
/// first. Short-lived rather than invalidated: DDL run in a console shows up within the TTL.
#[derive(Default)]
pub struct Cache {
    tables: Mutex<HashMap<CacheKey, (Instant, TableInfo)>>,
}

impl std::fmt::Debug for Cache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("editability::Cache")
    }
}

impl Cache {
    fn key(connection_id: &str, table: &TableRef) -> CacheKey {
        (
            connection_id.to_string(),
            table.schema.clone().unwrap_or_default().to_lowercase(),
            table.table.to_lowercase(),
        )
    }

    pub fn get(&self, connection_id: &str, table: &TableRef) -> Option<TableInfo> {
        let map = self.tables.lock().unwrap();
        map.get(&Self::key(connection_id, table))
            .filter(|(at, _)| at.elapsed() < TTL)
            .map(|(_, info)| info.clone())
    }

    pub fn put(&self, connection_id: &str, table: &TableRef, info: TableInfo) {
        self.tables
            .lock()
            .unwrap()
            .insert(Self::key(connection_id, table), (Instant::now(), info));
    }

    /// Forget everything about a connection (it disconnected).
    pub fn forget(&self, connection_id: &str) {
        self.tables
            .lock()
            .unwrap()
            .retain(|(c, _, _), _| c != connection_id);
    }
}
