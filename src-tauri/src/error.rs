use serde::Serialize;

/// Typed error that crosses the IPC boundary as `{ code, message, detail? }`.
/// Never put secrets in any of these fields.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_without_empty_detail() {
        let err = AppError::new("io", "disk full");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "io", "message": "disk full" })
        );
    }

    #[test]
    fn serializes_detail_when_present() {
        let err = AppError::new("io", "disk full").with_detail("os error 28");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["detail"], "os error 28");
    }
}
