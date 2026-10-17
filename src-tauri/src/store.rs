use std::collections::HashMap;
use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};
use crate::history::{entry_from_row, like_pattern, HistoryPage, NewEntry, Row, HISTORY_LIMIT};
use crate::palette::{EntryKind, IndexEntry};

pub const DB_FILE: &str = "clew.db";

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::new("store", "Could not access app data").with_detail(e.to_string())
}

/// App-data SQLite store (`clew.db`): UI state now; history and saved queries later.
#[derive(Debug, Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub async fn open(dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(dir).map_err(db_err)?;
        let options = SqliteConnectOptions::new()
            .filename(dir.join(DB_FILE))
            .create_if_missing(true);
        Self::connect(options).await
    }

    pub async fn open_in_memory() -> AppResult<Self> {
        let options = SqliteConnectOptions::new().in_memory(true);
        Self::connect(options).await
    }

    async fn connect(options: SqliteConnectOptions) -> AppResult<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(db_err)?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(db_err)?;
        Ok(Self { pool })
    }

    pub async fn ui_state_get(&self, key: &str) -> AppResult<Option<String>> {
        sqlx::query_scalar("SELECT value FROM ui_state WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)
    }

    pub async fn ui_state_set(&self, key: &str, value: &str) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO ui_state (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    /// Record a finished statement and trim the connection's history to the newest entries.
    pub async fn history_insert(&self, e: &NewEntry) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO history (connection_id, database, sql, started_at, duration_ms, rows, outcome) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&e.connection_id)
        .bind(&e.database)
        .bind(&e.sql)
        .bind(e.started_at)
        .bind(e.duration_ms)
        .bind(e.rows)
        .bind(e.outcome.as_str())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        sqlx::query(
            "DELETE FROM history WHERE connection_id = ?1 AND id NOT IN \
             (SELECT id FROM history WHERE connection_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2)",
        )
        .bind(&e.connection_id)
        .bind(HISTORY_LIMIT)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    /// A connection's history, newest first. `query` is a case-insensitive substring of the
    /// statement; `before` is the `next` cursor of the previous page.
    pub async fn history_list(
        &self,
        connection_id: &str,
        query: Option<&str>,
        before: Option<i64>,
        limit: i64,
    ) -> AppResult<HistoryPage> {
        let pattern = query.filter(|q| !q.is_empty()).map(like_pattern);
        // One extra row tells whether there is another page.
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, connection_id, database, sql, started_at, duration_ms, rows, outcome \
             FROM history WHERE connection_id = ?1 \
               AND (?2 IS NULL OR sql LIKE ?2 ESCAPE '\\') \
               AND (?3 IS NULL OR id < ?3) \
             ORDER BY started_at DESC, id DESC LIMIT ?4",
        )
        .bind(connection_id)
        .bind(pattern)
        .bind(before)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        let mut entries: Vec<_> = rows.into_iter().map(entry_from_row).collect();
        let next = if entries.len() as i64 > limit {
            entries.truncate(limit as usize);
            entries.last().map(|e| e.id)
        } else {
            None
        };
        Ok(HistoryPage { entries, next })
    }

    #[cfg(test)]
    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn history_count(&self, connection_id: &str) -> AppResult<i64> {
        sqlx::query_scalar("SELECT count(*) FROM history WHERE connection_id = ?")
            .bind(connection_id)
            .fetch_one(&self.pool)
            .await
            .map_err(db_err)
    }

    /// Delete one connection's history, or everyone's. Returns how many entries went.
    pub async fn history_clear(&self, connection_id: Option<&str>) -> AppResult<u64> {
        let result = match connection_id {
            Some(id) => {
                sqlx::query("DELETE FROM history WHERE connection_id = ?")
                    .bind(id)
                    .execute(&self.pool)
                    .await
            }
            None => sqlx::query("DELETE FROM history").execute(&self.pool).await,
        };
        Ok(result.map_err(db_err)?.rows_affected())
    }

    /// Replace the persisted index of one (connection, database).
    pub async fn palette_replace(
        &self,
        connection_id: &str,
        database: &str,
        entries: &[IndexEntry],
    ) -> AppResult<()> {
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        sqlx::query("DELETE FROM palette_index WHERE connection_id = ? AND database = ?")
            .bind(connection_id)
            .bind(database)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        for e in entries {
            let path = serde_json::to_string(&e.path).map_err(db_err)?;
            sqlx::query(
                "INSERT INTO palette_index (connection_id, database, kind, name, parent_label, path, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&e.connection_id)
            .bind(&e.database)
            .bind(e.kind.as_str())
            .bind(&e.name)
            .bind(&e.parent_label)
            .bind(path)
            .bind(e.updated_at)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        }
        tx.commit().await.map_err(db_err)
    }

    pub async fn palette_remove_connection(&self, connection_id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM palette_index WHERE connection_id = ?")
            .bind(connection_id)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    pub async fn palette_clear(&self) -> AppResult<()> {
        sqlx::query("DELETE FROM palette_index")
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    /// Everything indexed so far, to warm the in-memory index at start-up.
    pub async fn palette_load(&self) -> AppResult<Vec<IndexEntry>> {
        let rows: Vec<(String, String, String, String, String, String, i64)> = sqlx::query_as(
            "SELECT connection_id, database, kind, name, parent_label, path, updated_at FROM palette_index",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(rows
            .into_iter()
            .filter_map(
                |(connection_id, database, kind, name, parent_label, path, updated_at)| {
                    Some(IndexEntry {
                        connection_id,
                        database,
                        kind: EntryKind::parse(&kind)?,
                        name,
                        parent_label,
                        path: serde_json::from_str(&path).ok()?,
                        updated_at,
                    })
                },
            )
            .collect())
    }

    /// The newest distinct statements across all connections, for the palette.
    pub async fn history_recent(&self, limit: i64) -> AppResult<Vec<crate::history::HistoryEntry>> {
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, connection_id, database, sql, started_at, duration_ms, rows, outcome \
             FROM history WHERE id IN (SELECT max(id) FROM history WHERE outcome = 'ok' \
               GROUP BY connection_id, sql) \
             ORDER BY started_at DESC, id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(rows.into_iter().map(entry_from_row).collect())
    }

    pub async fn ui_state_all(&self) -> AppResult<HashMap<String, String>> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM ui_state")
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(rows.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ui_state_round_trip_and_overwrite() {
        let store = Store::open_in_memory().await.unwrap();
        assert_eq!(
            store.ui_state_get("layout.sidebarWidth").await.unwrap(),
            None
        );
        store
            .ui_state_set("layout.sidebarWidth", "300")
            .await
            .unwrap();
        store
            .ui_state_set("layout.sidebarWidth", "320")
            .await
            .unwrap();
        assert_eq!(
            store
                .ui_state_get("layout.sidebarWidth")
                .await
                .unwrap()
                .as_deref(),
            Some("320")
        );
        let all = store.ui_state_all().await.unwrap();
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn opens_a_file_database_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = Store::open(dir.path()).await.unwrap();
            store.ui_state_set("k", "v").await.unwrap();
        }
        let store = Store::open(dir.path()).await.unwrap();
        assert_eq!(store.ui_state_get("k").await.unwrap().as_deref(), Some("v"));
    }
}
