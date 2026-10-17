use std::collections::HashMap;
use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::ai::chats::{ChatSummary, StoredMessage};
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

    /// Create a chat, or touch an existing one (new `updated_at`, same title).
    pub async fn ai_chat_touch(&self, chat: &ChatSummary) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO ai_chats (id, connection_id, title, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
        )
        .bind(&chat.id)
        .bind(&chat.connection_id)
        .bind(&chat.title)
        .bind(chat.created_at)
        .bind(chat.updated_at)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    /// Insert or replace one message of a chat.
    pub async fn ai_message_save(&self, chat_id: &str, m: &StoredMessage) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO ai_messages (id, chat_id, seq, role, body) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, seq = excluded.seq",
        )
        .bind(&m.id)
        .bind(chat_id)
        .bind(m.seq)
        .bind(&m.role)
        .bind(&m.body)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    /// Chats, newest first; of one connection when `connection_id` is given.
    pub async fn ai_chats_list(&self, connection_id: Option<&str>) -> AppResult<Vec<ChatSummary>> {
        let rows: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
            "SELECT id, connection_id, title, created_at, updated_at FROM ai_chats \
             WHERE (?1 IS NULL OR connection_id = ?1) ORDER BY updated_at DESC, id DESC LIMIT 500",
        )
        .bind(connection_id)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(rows
            .into_iter()
            .map(
                |(id, connection_id, title, created_at, updated_at)| ChatSummary {
                    id,
                    connection_id,
                    title,
                    created_at,
                    updated_at,
                },
            )
            .collect())
    }

    pub async fn ai_chat_messages(&self, chat_id: &str) -> AppResult<Vec<StoredMessage>> {
        let rows: Vec<(String, i64, String, String)> = sqlx::query_as(
            "SELECT id, seq, role, body FROM ai_messages WHERE chat_id = ? ORDER BY seq, id",
        )
        .bind(chat_id)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(rows
            .into_iter()
            .map(|(id, seq, role, body)| StoredMessage {
                id,
                seq,
                role,
                body,
            })
            .collect())
    }

    /// Delete one chat, or every chat of a connection (or all chats). Returns how many chats went.
    pub async fn ai_chats_delete(
        &self,
        chat_id: Option<&str>,
        connection_id: Option<&str>,
    ) -> AppResult<u64> {
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        sqlx::query(
            "DELETE FROM ai_messages WHERE chat_id IN (SELECT id FROM ai_chats \
             WHERE (?1 IS NULL OR id = ?1) AND (?2 IS NULL OR connection_id = ?2))",
        )
        .bind(chat_id)
        .bind(connection_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        let n = sqlx::query(
            "DELETE FROM ai_chats WHERE (?1 IS NULL OR id = ?1) AND (?2 IS NULL OR connection_id = ?2)",
        )
        .bind(chat_id)
        .bind(connection_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?
        .rows_affected();
        tx.commit().await.map_err(db_err)?;
        Ok(n)
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

    fn chat(id: &str, conn: &str, at: i64) -> ChatSummary {
        ChatSummary {
            id: id.into(),
            connection_id: conn.into(),
            title: format!("title {id}"),
            created_at: at,
            updated_at: at,
        }
    }

    fn msg(id: &str, seq: i64, role: &str) -> StoredMessage {
        StoredMessage {
            id: id.into(),
            seq,
            role: role.into(),
            body: format!("{{\"id\":\"{id}\"}}"),
        }
    }

    /// (spec: ai-assistant › Reopen a chat)
    #[tokio::test]
    async fn chats_are_listed_newest_first_and_reopen_in_order() {
        let store = Store::open_in_memory().await.unwrap();
        store.ai_chat_touch(&chat("a", "c1", 10)).await.unwrap();
        store.ai_chat_touch(&chat("b", "c1", 20)).await.unwrap();
        store.ai_chat_touch(&chat("c", "c2", 30)).await.unwrap();
        store
            .ai_message_save("a", &msg("m2", 2, "assistant"))
            .await
            .unwrap();
        store
            .ai_message_save("a", &msg("m1", 1, "user"))
            .await
            .unwrap();
        let ids = |v: Vec<ChatSummary>| v.into_iter().map(|c| c.id).collect::<Vec<_>>();
        assert_eq!(
            ids(store.ai_chats_list(Some("c1")).await.unwrap()),
            vec!["b", "a"]
        );
        assert_eq!(
            ids(store.ai_chats_list(None).await.unwrap()),
            vec!["c", "b", "a"]
        );
        let m = store.ai_chat_messages("a").await.unwrap();
        assert_eq!(
            m.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2"]
        );
        // Saving a message again replaces its body; touching a chat keeps its title.
        let mut again = msg("m1", 1, "user");
        again.body = "{}".into();
        store.ai_message_save("a", &again).await.unwrap();
        assert_eq!(store.ai_chat_messages("a").await.unwrap()[0].body, "{}");
        let mut renamed = chat("a", "c1", 99);
        renamed.title = "other".into();
        store.ai_chat_touch(&renamed).await.unwrap();
        let listed = store.ai_chats_list(Some("c1")).await.unwrap();
        assert_eq!(
            (listed[0].id.as_str(), listed[0].title.as_str()),
            ("a", "title a")
        );
    }

    #[tokio::test]
    async fn deleting_one_chat_or_all_of_a_connection() {
        let store = Store::open_in_memory().await.unwrap();
        for (id, conn) in [("a", "c1"), ("b", "c1"), ("c", "c2")] {
            store.ai_chat_touch(&chat(id, conn, 1)).await.unwrap();
            store
                .ai_message_save(id, &msg(&format!("{id}1"), 1, "user"))
                .await
                .unwrap();
        }
        assert_eq!(store.ai_chats_delete(Some("a"), None).await.unwrap(), 1);
        assert!(store.ai_chat_messages("a").await.unwrap().is_empty());
        assert_eq!(store.ai_chats_delete(None, Some("c1")).await.unwrap(), 1);
        assert_eq!(store.ai_chats_list(None).await.unwrap().len(), 1);
        assert_eq!(store.ai_chats_delete(None, None).await.unwrap(), 1);
        assert!(store.ai_chats_list(None).await.unwrap().is_empty());
    }

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
