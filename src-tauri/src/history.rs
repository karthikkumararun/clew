//! Query history: every statement executed from a console is recorded here, in Rust, right after
//! it finishes, so the UI cannot skip it. Stored in the app database and never leaves the machine.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::store::Store;

/// Entries kept per connection; older ones are deleted.
pub const HISTORY_LIMIT: i64 = 10_000;
/// Rows returned by one `history_list` call.
pub const PAGE_SIZE: i64 = 100;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    Error,
    Cancelled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Cancelled => "cancelled",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "error" => Outcome::Error,
            "cancelled" => Outcome::Cancelled,
            _ => Outcome::Ok,
        }
    }
}

/// A statement that just finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEntry {
    pub connection_id: String,
    pub database: String,
    pub sql: String,
    /// Start time, ms since the epoch.
    pub started_at: i64,
    pub duration_ms: i64,
    /// Rows returned, or rows affected for a write; none for a failed statement.
    pub rows: Option<i64>,
    pub outcome: Outcome,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[ts(type = "number")]
    pub id: i64,
    pub connection_id: String,
    pub database: String,
    pub sql: String,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub duration_ms: i64,
    #[ts(type = "number | null")]
    pub rows: Option<i64>,
    pub outcome: Outcome,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    /// Pass back as `before` to get the next (older) page; none at the end.
    #[ts(type = "number | null")]
    pub next: Option<i64>,
}

/// Where the session manager reports finished statements.
pub trait HistorySink: Send + Sync {
    fn record(&self, entry: NewEntry);
}

/// Writes to the app database in the background, so a slow disk never delays a query.
pub struct StoreHistory(pub Store);

impl HistorySink for StoreHistory {
    fn record(&self, entry: NewEntry) {
        let store = self.0.clone();
        tokio::spawn(async move {
            if let Err(e) = store.history_insert(&entry).await {
                eprintln!("couldn't record history: {e}");
            }
        });
    }
}

pub fn sink(store: Store) -> Arc<dyn HistorySink> {
    Arc::new(StoreHistory(store))
}

/// Escape `%`, `_` and the escape character itself for a `LIKE ... ESCAPE '\'` search.
pub fn like_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// A `history` row as the database returns it.
pub(crate) type Row = (i64, String, String, String, i64, i64, Option<i64>, String);

pub(crate) fn entry_from_row(
    (id, connection_id, database, sql, started_at, duration_ms, rows, outcome): Row,
) -> HistoryEntry {
    HistoryEntry {
        id,
        connection_id,
        database,
        sql,
        started_at,
        duration_ms,
        rows,
        outcome: Outcome::parse(&outcome),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(conn: &str, sql: &str, at: i64, outcome: Outcome) -> NewEntry {
        NewEntry {
            connection_id: conn.into(),
            database: "analytics".into(),
            sql: sql.into(),
            started_at: at,
            duration_ms: 38,
            rows: Some(50),
            outcome,
        }
    }

    #[test]
    fn like_patterns_escape_wildcards() {
        assert_eq!(like_pattern("orders"), "%orders%");
        assert_eq!(like_pattern("100%_done\\"), "%100\\%\\_done\\\\%");
    }

    #[tokio::test]
    async fn records_and_lists_newest_first() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .history_insert(&entry("c1", "select 1", 1000, Outcome::Ok))
            .await
            .unwrap();
        store
            .history_insert(&entry("c1", "select 2", 3000, Outcome::Error))
            .await
            .unwrap();
        store
            .history_insert(&entry("c1", "select 3", 2000, Outcome::Cancelled))
            .await
            .unwrap();
        store
            .history_insert(&entry("c2", "other", 5000, Outcome::Ok))
            .await
            .unwrap();

        let page = store
            .history_list("c1", None, None, PAGE_SIZE)
            .await
            .unwrap();
        let sqls: Vec<_> = page.entries.iter().map(|e| e.sql.as_str()).collect();
        assert_eq!(sqls, ["select 2", "select 3", "select 1"]);
        assert_eq!(page.entries[0].outcome, Outcome::Error);
        assert_eq!(
            page.entries[2],
            HistoryEntry {
                id: page.entries[2].id,
                connection_id: "c1".into(),
                database: "analytics".into(),
                sql: "select 1".into(),
                started_at: 1000,
                duration_ms: 38,
                rows: Some(50),
                outcome: Outcome::Ok,
            }
        );
        assert_eq!(page.next, None);
    }

    #[tokio::test]
    async fn search_is_a_case_insensitive_substring_over_the_text() {
        let store = Store::open_in_memory().await.unwrap();
        for (i, sql) in [
            "SELECT * FROM Orders",
            "select 1",
            "update orders set a = 1",
            "select '50%'",
        ]
        .into_iter()
        .enumerate()
        {
            store
                .history_insert(&entry("c1", sql, i as i64, Outcome::Ok))
                .await
                .unwrap();
        }
        let found = |q: &str| {
            let store = store.clone();
            let q = q.to_string();
            async move {
                store
                    .history_list("c1", Some(&q), None, PAGE_SIZE)
                    .await
                    .unwrap()
                    .entries
                    .into_iter()
                    .map(|e| e.sql)
                    .collect::<Vec<_>>()
            }
        };
        assert_eq!(
            found("orders").await,
            ["update orders set a = 1", "SELECT * FROM Orders"]
        );
        assert_eq!(
            found("50%").await,
            ["select '50%'"],
            "% is literal, not a wildcard"
        );
        assert!(found("nothing").await.is_empty());
        assert_eq!(found("").await.len(), 4, "an empty query lists everything");
    }

    #[tokio::test]
    async fn pages_with_a_cursor() {
        let store = Store::open_in_memory().await.unwrap();
        for i in 0..5 {
            store
                .history_insert(&entry("c1", &format!("q{i}"), i, Outcome::Ok))
                .await
                .unwrap();
        }
        let first = store.history_list("c1", None, None, 2).await.unwrap();
        assert_eq!(
            first
                .entries
                .iter()
                .map(|e| e.sql.as_str())
                .collect::<Vec<_>>(),
            ["q4", "q3"]
        );
        let second = store.history_list("c1", None, first.next, 2).await.unwrap();
        assert_eq!(
            second
                .entries
                .iter()
                .map(|e| e.sql.as_str())
                .collect::<Vec<_>>(),
            ["q2", "q1"]
        );
        let last = store
            .history_list("c1", None, second.next, 2)
            .await
            .unwrap();
        assert_eq!(
            last.entries
                .iter()
                .map(|e| e.sql.as_str())
                .collect::<Vec<_>>(),
            ["q0"]
        );
        assert_eq!(last.next, None);
    }

    #[tokio::test]
    async fn keeps_only_the_newest_entries_per_connection() {
        let store = Store::open_in_memory().await.unwrap();
        // Fill past the limit in one statement; inserting 10,000 rows one by one is slow.
        let extra = 25;
        sqlx::query(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 2) \
             INSERT INTO history (connection_id, database, sql, started_at, duration_ms, rows, outcome) \
             SELECT 'c1', '', 'q' || i, i, 1, 1, 'ok' FROM n",
        )
        .bind(HISTORY_LIMIT)
        .bind(extra)
        .execute(store.pool())
        .await
        .unwrap();
        assert_eq!(
            store.history_count("c1").await.unwrap(),
            HISTORY_LIMIT + extra - 1
        );
        store
            .history_insert(&entry("c2", "keep me", 1, Outcome::Ok))
            .await
            .unwrap();

        // The next recorded statement trims the connection back to the limit, oldest first.
        store
            .history_insert(&entry("c1", "newest", HISTORY_LIMIT + extra, Outcome::Ok))
            .await
            .unwrap();
        assert_eq!(store.history_count("c1").await.unwrap(), HISTORY_LIMIT);
        assert_eq!(
            store.history_count("c2").await.unwrap(),
            1,
            "other connections are untouched"
        );
        let newest = store.history_list("c1", None, None, 1).await.unwrap();
        assert_eq!(newest.entries[0].sql, "newest");
        let gone = store
            .history_list("c1", Some("q0"), None, PAGE_SIZE)
            .await
            .unwrap();
        assert!(
            gone.entries.iter().all(|e| e.sql != "q0"),
            "the oldest are gone"
        );
        let kept = store
            .history_list(
                "c1",
                Some(&format!("q{}", HISTORY_LIMIT + extra - 2)),
                None,
                PAGE_SIZE,
            )
            .await
            .unwrap();
        assert_eq!(kept.entries.len(), 1, "the newest survive");
    }

    #[tokio::test]
    async fn clears_one_connection_or_all() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .history_insert(&entry("c1", "a", 1, Outcome::Ok))
            .await
            .unwrap();
        store
            .history_insert(&entry("c1", "b", 2, Outcome::Ok))
            .await
            .unwrap();
        store
            .history_insert(&entry("c2", "c", 3, Outcome::Ok))
            .await
            .unwrap();
        assert_eq!(store.history_clear(Some("c1")).await.unwrap(), 2);
        assert_eq!(store.history_count("c1").await.unwrap(), 0);
        assert_eq!(store.history_count("c2").await.unwrap(), 1);
        assert_eq!(store.history_clear(None).await.unwrap(), 1);
        assert_eq!(store.history_count("c2").await.unwrap(), 0);
    }
}
