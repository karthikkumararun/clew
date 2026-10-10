use std::io::ErrorKind;

use sqlx::mysql::MySqlDatabaseError;

use crate::drivers::{DriverError, ErrorCode};
use crate::transport::tls::map_tls_error;

/// Map a MySQL/MariaDB error number to our error codes.
pub fn code_for_errno(errno: u16) -> ErrorCode {
    match errno {
        // ER_ACCESS_DENIED_ERROR, ER_ACCESS_DENIED_NO_PASSWORD_ERROR, ER_NO_SUCH_USER
        1045 | 1698 | 1133 => ErrorCode::AuthFailed,
        // ER_DBACCESS_DENIED_ERROR, ER_TABLEACCESS_DENIED_ERROR, ER_COLUMNACCESS_DENIED_ERROR,
        // ER_SPECIFIC_ACCESS_DENIED_ERROR, ER_PROCACCESS_DENIED_ERROR
        1044 | 1142 | 1143 | 1227 | 1370 => ErrorCode::AccessDenied,
        // ER_QUERY_INTERRUPTED (KILL QUERY), ER_QUERY_TIMEOUT
        1317 => ErrorCode::Cancelled,
        3024 | 1969 => ErrorCode::Timeout,
        // CR_SERVER_GONE_ERROR, CR_SERVER_LOST, ER_SERVER_SHUTDOWN, ER_CONNECTION_KILLED
        2006 | 2013 | 1053 | 1927 => ErrorCode::ConnectionLost,
        _ => ErrorCode::QueryFailed,
    }
}

/// MySQL reports syntax errors as `... near 'text' at line N` without a character offset;
/// locate `text` in the statement to give the editor something to underline (1-based chars).
pub fn position_from_near(sql: &str, message: &str) -> Option<u32> {
    let start = message.find("near '")? + "near '".len();
    let rest = &message[start..];
    let end = rest.rfind("' at line").unwrap_or(rest.len());
    let near = &rest[..end];
    if near.is_empty() {
        // "near ''" means the end of the statement
        return Some(sql.trim_end().chars().count() as u32 + 1);
    }
    let byte = sql.find(near)?;
    Some(sql[..byte].chars().count() as u32 + 1)
}

/// Convert an sqlx error. `sql` (when known) lets syntax errors carry a position.
pub fn map_error(e: sqlx::Error, target: &str, sql: Option<&str>) -> DriverError {
    match e {
        sqlx::Error::Database(db) => {
            let message = db.message().to_string();
            let errno = db
                .try_downcast_ref::<MySqlDatabaseError>()
                .map(|m| m.number())
                .unwrap_or(0);
            let code = code_for_errno(errno);
            let mut err = DriverError::new(code, message.clone());
            if code == ErrorCode::Cancelled {
                err.message = "The statement was cancelled".into();
            }
            if code == ErrorCode::QueryFailed {
                if let Some(pos) = sql.and_then(|s| position_from_near(s, &message)) {
                    err = err.with_position(pos);
                }
            }
            err
        }
        sqlx::Error::Io(io)
            if io.kind() == ErrorKind::InvalidData
                && io.to_string().to_ascii_lowercase().contains("certificate") =>
        {
            let host = target.rsplit_once(':').map_or(target, |(h, _)| h);
            map_tls_error(&io.to_string(), host).unwrap_or_else(|| {
                DriverError::new(
                    ErrorCode::TlsFailed,
                    "The TLS connection could not be established",
                )
                .with_detail(io.to_string())
            })
        }
        sqlx::Error::Io(io) => match io.kind() {
            ErrorKind::ConnectionRefused => DriverError::new(
                ErrorCode::ConnectionLost,
                format!("Connection refused by {target}"),
            ),
            ErrorKind::TimedOut => DriverError::new(
                ErrorCode::Timeout,
                format!("Could not reach {target}: the connection timed out"),
            ),
            _ => DriverError::new(
                ErrorCode::ConnectionLost,
                format!("The connection to {target} was lost"),
            )
            .with_detail(io.to_string()),
        },
        sqlx::Error::Tls(inner) => {
            let text = inner.to_string();
            let host = target.rsplit_once(':').map_or(target, |(h, _)| h);
            map_tls_error(&text, host).unwrap_or_else(|| {
                DriverError::new(
                    ErrorCode::TlsFailed,
                    "The TLS connection could not be established",
                )
                .with_detail(text)
            })
        }
        sqlx::Error::PoolTimedOut => DriverError::new(
            ErrorCode::Timeout,
            format!("Timed out waiting for a connection to {target}"),
        ),
        sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed => DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {target} was closed"),
        ),
        sqlx::Error::Protocol(text) => DriverError::new(
            ErrorCode::ConnectionLost,
            "The server sent an unexpected response",
        )
        .with_detail(text),
        other => DriverError::internal("Unexpected database error").with_detail(other.to_string()),
    }
}

pub fn is_connection_error(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::Protocol(_)
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => true,
        sqlx::Error::Database(db) => db
            .try_downcast_ref::<MySqlDatabaseError>()
            .is_some_and(|m| code_for_errno(m.number()) == ErrorCode::ConnectionLost),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_numbers_map_to_codes() {
        assert_eq!(code_for_errno(1045), ErrorCode::AuthFailed);
        assert_eq!(code_for_errno(1142), ErrorCode::AccessDenied);
        assert_eq!(code_for_errno(1317), ErrorCode::Cancelled);
        assert_eq!(code_for_errno(3024), ErrorCode::Timeout);
        assert_eq!(code_for_errno(2013), ErrorCode::ConnectionLost);
        assert_eq!(code_for_errno(1064), ErrorCode::QueryFailed);
        assert_eq!(code_for_errno(1062), ErrorCode::QueryFailed);
    }

    #[test]
    fn syntax_error_positions_come_from_the_near_text() {
        let sql = "SELEC 1";
        let msg = "You have an error in your SQL syntax; check the manual ... for the right syntax to use near 'SELEC 1' at line 1";
        assert_eq!(position_from_near(sql, msg), Some(1));
        let sql = "SELECT * FORM t";
        let msg = "... right syntax to use near 'FORM t' at line 1";
        assert_eq!(position_from_near(sql, msg), Some(10));
        assert_eq!(
            position_from_near("SELECT é, FORM", "near 'FORM' at line 1"),
            Some(11)
        );
        // "near ''" points past the end of the statement
        assert_eq!(position_from_near("SELECT", "near '' at line 1"), Some(7));
        assert_eq!(position_from_near("SELECT 1", "no hint here"), None);
    }

    #[test]
    fn io_errors_name_the_target() {
        let refused = sqlx::Error::Io(std::io::Error::from(ErrorKind::ConnectionRefused));
        let e = map_error(refused, "db.internal:3306", None);
        assert_eq!(e.code, ErrorCode::ConnectionLost);
        assert!(e.message.contains("db.internal:3306"));
    }

    #[test]
    fn certificate_failures_are_tls_failed() {
        let e = sqlx::Error::Io(std::io::Error::new(
            ErrorKind::InvalidData,
            "invalid peer certificate: UnknownIssuer",
        ));
        assert_eq!(map_error(e, "h:3306", None).code, ErrorCode::TlsFailed);
    }
}
