use serde::Serialize;

use crate::error::AppError;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    AuthFailed,
    Timeout,
    ConnectionLost,
    QueryFailed,
    Cancelled,
    TlsFailed,
    HostKeyMismatch,
    FileNotFound,
    DatabaseLocked,
    AccessDenied,
    DriverUnavailable,
    Unsupported,
    /// A write was refused because the session is read-only.
    ReadOnly,
    /// A write needs the user's confirmation first (see `safety_check`).
    ConfirmationRequired,
    /// Anything that is a bug or an unexpected environment problem.
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AuthFailed => "auth_failed",
            Self::Timeout => "timeout",
            Self::ConnectionLost => "connection_lost",
            Self::QueryFailed => "query_failed",
            Self::Cancelled => "cancelled",
            Self::TlsFailed => "tls_failed",
            Self::HostKeyMismatch => "host_key_mismatch",
            Self::FileNotFound => "file_not_found",
            Self::DatabaseLocked => "database_locked",
            Self::AccessDenied => "access_denied",
            Self::DriverUnavailable => "driver_unavailable",
            Self::Unsupported => "unsupported",
            Self::ReadOnly => "read_only",
            Self::ConfirmationRequired => "confirmation_required",
            Self::Internal => "internal",
        }
    }
}

/// Error returned by drivers. Never carries secrets (passwords, passphrases, tokens).
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{}: {message}", code.as_str())]
pub struct DriverError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
    /// 1-based character offset into the statement text, when the server reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub position: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hint: Option<String>,
}

pub type DriverResult<T> = Result<T, DriverError>;

impl DriverError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            position: None,
            hint: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn with_position(mut self, position: u32) -> Self {
        self.position = Some(position);
        self
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn unsupported(what: &str) -> Self {
        Self::new(
            ErrorCode::Unsupported,
            format!("{what} is not supported by this driver"),
        )
    }

    pub fn driver_unavailable(id: &str) -> Self {
        Self::new(
            ErrorCode::DriverUnavailable,
            format!("The driver \"{id}\" is not available in this build of Clew"),
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

/// Errors cross IPC as the shell's `{ code, message, detail }`; position and hint are folded
/// into `detail` for commands that return `AppError`. Streaming events carry the full error.
impl From<DriverError> for AppError {
    fn from(e: DriverError) -> Self {
        let mut detail = e.detail.clone().unwrap_or_default();
        if let Some(h) = &e.hint {
            if !detail.is_empty() {
                detail.push('\n');
            }
            detail.push_str(&format!("Hint: {h}"));
        }
        let app = AppError::new(e.code.as_str(), e.message);
        if detail.is_empty() {
            app
        } else {
            app.with_detail(detail)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialize_snake_case_and_match_as_str() {
        for code in [
            ErrorCode::AuthFailed,
            ErrorCode::HostKeyMismatch,
            ErrorCode::DatabaseLocked,
            ErrorCode::DriverUnavailable,
        ] {
            let json = serde_json::to_value(code).unwrap();
            assert_eq!(json, code.as_str());
        }
    }

    #[test]
    fn maps_to_app_error_with_hint_in_detail() {
        let e = DriverError::new(ErrorCode::QueryFailed, "syntax error")
            .with_detail("near FORM")
            .with_hint("Did you mean FROM?")
            .with_position(42);
        let app: AppError = e.into();
        assert_eq!(app.code, "query_failed");
        assert_eq!(app.message, "syntax error");
        assert_eq!(
            app.detail.as_deref(),
            Some("near FORM\nHint: Did you mean FROM?")
        );
    }

    #[test]
    fn driver_unavailable_names_the_driver() {
        let e = DriverError::driver_unavailable("oracle");
        assert_eq!(e.code, ErrorCode::DriverUnavailable);
        assert!(e.message.contains("oracle"));
    }

    #[test]
    fn position_is_serialized_when_present() {
        let e = DriverError::new(ErrorCode::QueryFailed, "x").with_position(7);
        assert_eq!(serde_json::to_value(e).unwrap()["position"], 7);
    }
}
