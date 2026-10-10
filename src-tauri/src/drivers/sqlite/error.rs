use std::io::ErrorKind;

use crate::drivers::{DriverError, ErrorCode};

/// Primary SQLite result code (extended codes keep it in the low byte).
pub fn code_for_sqlite(code: i32) -> ErrorCode {
    match code & 0xff {
        // SQLITE_BUSY, SQLITE_LOCKED
        5 | 6 => ErrorCode::DatabaseLocked,
        // SQLITE_INTERRUPT
        9 => ErrorCode::Cancelled,
        // SQLITE_PERM, SQLITE_AUTH
        3 | 23 => ErrorCode::AccessDenied,
        // SQLITE_IOERR, SQLITE_CORRUPT, SQLITE_NOTADB
        10 | 11 | 26 => ErrorCode::QueryFailed,
        _ => ErrorCode::QueryFailed,
    }
}

/// SQLite reports syntax errors as `near "TEXT": syntax error` without an offset; locate TEXT in
/// the statement (1-based chars).
pub fn position_from_near(sql: &str, message: &str) -> Option<u32> {
    let start = message.find("near \"")? + "near \"".len();
    let rest = &message[start..];
    let near = &rest[..rest.find("\":")?];
    if near.is_empty() {
        return None;
    }
    let byte = sql.find(near)?;
    Some(sql[..byte].chars().count() as u32 + 1)
}

pub fn map_error(e: sqlx::Error, path: &str, sql: Option<&str>) -> DriverError {
    match e {
        sqlx::Error::Database(db) => {
            let message = db.message().to_string();
            let code = db
                .code()
                .and_then(|c| c.parse::<i32>().ok())
                .map(code_for_sqlite)
                .unwrap_or(ErrorCode::QueryFailed);
            let mut err = DriverError::new(code, message.clone());
            match code {
                ErrorCode::DatabaseLocked => {
                    err.message =
                        format!("The database {path} is locked by another process or connection");
                    err.detail = Some(message);
                }
                ErrorCode::Cancelled => err.message = "The statement was cancelled".into(),
                ErrorCode::QueryFailed => {
                    if let Some(pos) = sql.and_then(|s| position_from_near(s, &message)) {
                        err = err.with_position(pos);
                    }
                }
                _ => {}
            }
            err
        }
        sqlx::Error::Io(io) if io.kind() == ErrorKind::NotFound => DriverError::new(
            ErrorCode::FileNotFound,
            format!("The database file {path} does not exist"),
        ),
        sqlx::Error::Io(io) => DriverError::new(
            ErrorCode::QueryFailed,
            format!("Could not read the database file {path}"),
        )
        .with_detail(io.to_string()),
        sqlx::Error::PoolTimedOut => DriverError::new(
            ErrorCode::DatabaseLocked,
            format!("Timed out waiting for the database {path}"),
        ),
        sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed => DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {path} was closed"),
        ),
        other => DriverError::internal("Unexpected database error").with_detail(other.to_string()),
    }
}

pub fn is_connection_error(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_codes_map() {
        assert_eq!(code_for_sqlite(5), ErrorCode::DatabaseLocked);
        assert_eq!(
            code_for_sqlite(517),
            ErrorCode::DatabaseLocked,
            "SQLITE_BUSY_SNAPSHOT"
        );
        assert_eq!(code_for_sqlite(6), ErrorCode::DatabaseLocked);
        assert_eq!(code_for_sqlite(9), ErrorCode::Cancelled);
        assert_eq!(code_for_sqlite(3), ErrorCode::AccessDenied);
        assert_eq!(code_for_sqlite(1), ErrorCode::QueryFailed);
        assert_eq!(
            code_for_sqlite(19),
            ErrorCode::QueryFailed,
            "constraint violations are query errors"
        );
    }

    #[test]
    fn syntax_error_positions() {
        assert_eq!(
            position_from_near("SELEC 1", "near \"SELEC\": syntax error"),
            Some(1)
        );
        assert_eq!(
            position_from_near("SELECT * FORM t", "near \"FORM\": syntax error"),
            Some(10)
        );
        assert_eq!(
            position_from_near("SELECT é, FORM", "near \"FORM\": syntax error"),
            Some(11)
        );
        assert_eq!(position_from_near("x", "no such table: t"), None);
    }
}
