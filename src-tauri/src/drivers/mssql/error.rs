use tiberius::error::Error;

use crate::drivers::{DriverError, ErrorCode};

/// Server error numbers worth their own code.
fn code_of(number: u32) -> ErrorCode {
    match number {
        18456 | 18452 | 18451 => ErrorCode::AuthFailed,
        229 | 230 | 262 | 297 | 300 | 916 => ErrorCode::AccessDenied,
        1222 => ErrorCode::DatabaseLocked,
        _ => ErrorCode::QueryFailed,
    }
}

pub fn map_error(e: Error, target: &str) -> DriverError {
    match e {
        Error::Server(token) => {
            let mut err = DriverError::new(code_of(token.code()), token.message().to_string());
            err.detail = Some(format!(
                "Msg {}, Level {}, State {}, Line {}",
                token.code(),
                token.class(),
                token.state(),
                token.line()
            ));
            err
        }
        Error::Io { message, .. } => DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {target} failed: {message}"),
        ),
        Error::Tls(message) => DriverError::new(ErrorCode::TlsFailed, message),
        Error::Routing { host, port } => DriverError::new(
            ErrorCode::Unsupported,
            format!("The server redirected the connection to {host}:{port}, which isn't supported"),
        ),
        other => DriverError::new(ErrorCode::QueryFailed, other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_numbers_get_their_codes() {
        assert_eq!(code_of(18456), ErrorCode::AuthFailed);
        assert_eq!(code_of(229), ErrorCode::AccessDenied);
        assert_eq!(code_of(102), ErrorCode::QueryFailed);
    }
}
