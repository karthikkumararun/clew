use std::collections::HashMap;
use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

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
