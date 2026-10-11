use oracle::{Error, ErrorKind};

use super::client::missing;
use crate::drivers::{DriverError, ErrorCode};

fn code_of(ora: i32) -> ErrorCode {
    match ora {
        1017 | 1005 | 28000 | 28001 | 28009 => ErrorCode::AuthFailed,
        1031 | 1045 | 1950 | 28002 => ErrorCode::AccessDenied,
        1013 => ErrorCode::Cancelled,
        12170 | 12535 | 12547 => ErrorCode::Timeout,
        12154 | 12514 | 12541 | 12545 | 12537 | 12560 | 3113 | 3114 | 3135 | 1012 | 12500
        | 12518 => ErrorCode::ConnectionLost,
        54 | 30006 => ErrorCode::DatabaseLocked,
        _ => ErrorCode::QueryFailed,
    }
}

/// Map a driver error. `ORA-nnnnn` text is kept as Oracle writes it; the Instant Client being
/// absent (`DPI-1047`) gets the explanation the connection dialog also shows.
pub fn map_error(e: Error, target: &str, sql: Option<&str>) -> DriverError {
    match e.kind() {
        ErrorKind::DpiError if matches!(e.dpi_code(), Some(1047 | 1072 | 1050)) => {
            return missing(&e.to_string());
        }
        _ => {}
    }
    let ora = e.oci_code().unwrap_or(0);
    let mut code = code_of(ora);
    let message = e.to_string();
    if ora == 0 && matches!(e.kind(), ErrorKind::DpiError | ErrorKind::InternalError) {
        let lower = message.to_ascii_lowercase();
        if lower.contains("connection") || lower.contains("closed") {
            code = ErrorCode::ConnectionLost;
        }
    }
    let mut err = DriverError::new(code, message);
    if code == ErrorCode::ConnectionLost && !err.message.contains(target) {
        err.detail = Some(format!("while talking to {target}"));
    }
    if sql.is_some() && (900..=999).contains(&ora) {
        err.position = e.db_error().map(|d| d.offset() + 1);
    } else if sql.is_some() {
        err.position = e
            .db_error()
            .map(|d| d.offset())
            .filter(|o| *o > 0)
            .map(|o| o + 1);
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_ora_numbers_get_their_codes() {
        assert_eq!(code_of(1017), ErrorCode::AuthFailed);
        assert_eq!(code_of(28000), ErrorCode::AuthFailed);
        assert_eq!(code_of(1031), ErrorCode::AccessDenied);
        assert_eq!(code_of(1013), ErrorCode::Cancelled);
        assert_eq!(code_of(12541), ErrorCode::ConnectionLost);
        assert_eq!(code_of(12170), ErrorCode::Timeout);
        assert_eq!(code_of(942), ErrorCode::QueryFailed);
    }
}
