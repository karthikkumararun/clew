use std::io::ErrorKind;

use sqlx::postgres::{PgDatabaseError, PgErrorPosition};

use crate::drivers::{DriverError, ErrorCode};
use crate::transport::tls::map_tls_error;

/// Map a SQLSTATE to our error codes.
pub fn code_for_sqlstate(state: &str) -> ErrorCode {
    match state {
        "28P01" | "28000" => ErrorCode::AuthFailed,
        "57014" => ErrorCode::Cancelled,
        "42501" => ErrorCode::AccessDenied,
        s if s.starts_with("08") => ErrorCode::ConnectionLost,
        "57P01" | "57P02" | "57P03" => ErrorCode::ConnectionLost,
        _ => ErrorCode::QueryFailed,
    }
}

/// Convert an sqlx error. `target` names the host for messages ("db.internal:5432").
pub fn map_error(e: sqlx::Error, target: &str) -> DriverError {
    match e {
        sqlx::Error::Database(db) => {
            let message = db.message().to_string();
            let mut err = match db.try_downcast_ref::<PgDatabaseError>() {
                Some(pg) => {
                    let code = code_for_sqlstate(pg.code());
                    let mut err = DriverError::new(code, message);
                    if let Some(detail) = pg.detail() {
                        err = err.with_detail(detail);
                    }
                    if let Some(hint) = pg.hint() {
                        err = err.with_hint(hint);
                    }
                    if let Some(PgErrorPosition::Original(pos)) = pg.position() {
                        err = err.with_position(pos as u32);
                    }
                    err
                }
                None => DriverError::new(ErrorCode::QueryFailed, message),
            };
            if err.code == ErrorCode::Cancelled {
                err.message = "The statement was cancelled".into();
            }
            err
        }
        // rustls certificate failures reach us wrapped in an InvalidData I/O error
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

/// Did this error leave the connection unusable?
pub fn is_connection_error(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::Protocol(_)
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => true,
        sqlx::Error::Database(db) => db
            .try_downcast_ref::<PgDatabaseError>()
            .is_some_and(|pg| code_for_sqlstate(pg.code()) == ErrorCode::ConnectionLost),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlstates_map_to_codes() {
        assert_eq!(code_for_sqlstate("28P01"), ErrorCode::AuthFailed);
        assert_eq!(code_for_sqlstate("57014"), ErrorCode::Cancelled);
        assert_eq!(code_for_sqlstate("42501"), ErrorCode::AccessDenied);
        assert_eq!(code_for_sqlstate("08006"), ErrorCode::ConnectionLost);
        assert_eq!(code_for_sqlstate("57P01"), ErrorCode::ConnectionLost);
        assert_eq!(code_for_sqlstate("42601"), ErrorCode::QueryFailed);
        assert_eq!(code_for_sqlstate("23505"), ErrorCode::QueryFailed);
    }

    #[test]
    fn io_errors_name_the_target() {
        let refused = sqlx::Error::Io(std::io::Error::from(ErrorKind::ConnectionRefused));
        let e = map_error(refused, "db.internal:5432");
        assert_eq!(e.code, ErrorCode::ConnectionLost);
        assert!(e.message.contains("db.internal:5432"));
        let timed = sqlx::Error::Io(std::io::Error::from(ErrorKind::TimedOut));
        assert_eq!(map_error(timed, "h:1").code, ErrorCode::Timeout);
    }

    #[test]
    fn certificate_failures_are_tls_failed_even_when_wrapped_in_io() {
        let e = sqlx::Error::Io(std::io::Error::new(
            ErrorKind::InvalidData,
            "invalid peer certificate: certificate not valid for name \"127.0.0.1\"; certificate is only valid for DnsName(\"wrong.example.test\")",
        ));
        let mapped = map_error(e, "127.0.0.1:5432");
        assert_eq!(mapped.code, ErrorCode::TlsFailed);
        assert!(mapped.message.contains("127.0.0.1"));
        let unknown = sqlx::Error::Io(std::io::Error::new(
            ErrorKind::InvalidData,
            "invalid peer certificate: UnknownIssuer",
        ));
        assert!(map_error(unknown, "h:1")
            .message
            .contains("certificate authority"));
    }

    #[test]
    fn connection_level_errors_are_detected() {
        assert!(is_connection_error(&sqlx::Error::Io(std::io::Error::from(
            ErrorKind::BrokenPipe
        ))));
        assert!(!is_connection_error(&sqlx::Error::RowNotFound));
    }
}
