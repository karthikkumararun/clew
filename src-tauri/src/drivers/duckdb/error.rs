use crate::drivers::{DriverError, ErrorCode};

/// 1-based character offset of the caret DuckDB draws under the failing token:
///
/// ```text
/// Parser Error: syntax error at or near "SELEC"
///
/// LINE 1: SELEC 1
///         ^
/// ```
pub fn error_position(message: &str, sql: &str) -> Option<u32> {
    let lines: Vec<&str> = message.lines().collect();
    let at = lines.iter().position(|l| l.starts_with("LINE "))?;
    let header = lines[at];
    let (num, rest) = header.strip_prefix("LINE ")?.split_once(": ")?;
    let line_no: usize = num.parse().ok()?;
    let prefix = header.len() - rest.len();
    let caret = lines.get(at + 1)?.find('^')?;
    let col = caret.checked_sub(prefix)?;
    let before: usize = sql
        .split('\n')
        .take(line_no.saturating_sub(1))
        .map(|l| l.chars().count() + 1)
        .sum();
    Some((before + col + 1) as u32)
}

pub fn map_error(e: duckdb::Error, path: &str, sql: Option<&str>) -> DriverError {
    let message = match &e {
        duckdb::Error::DuckDBFailure(_, Some(m)) => m.clone(),
        other => other.to_string(),
    };
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("interrupt") {
        ErrorCode::Cancelled
    } else if lower.contains("could not set lock") || lower.contains("conflicting lock") {
        ErrorCode::DatabaseLocked
    } else if lower.contains("no such file")
        || lower.contains("does not exist") && lower.contains("io error")
    {
        ErrorCode::FileNotFound
    } else if lower.contains("permission denied") {
        ErrorCode::AccessDenied
    } else {
        ErrorCode::QueryFailed
    };
    let mut err = DriverError::new(code, message.clone());
    if code == ErrorCode::DatabaseLocked {
        err.message = format!("{path} is in use by another process: {message}");
    }
    if let Some(sql) = sql {
        err.position = error_position(&message, sql);
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    const MSG: &str =
        "Parser Error: syntax error at or near \"SELEC\"\n\nLINE 1: SELEC 1\n        ^";

    #[test]
    fn the_caret_gives_a_one_based_position() {
        assert_eq!(error_position(MSG, "SELEC 1"), Some(1));
        let msg = "Parser Error: syntax error at or near \"FROM\"\n\nLINE 2: FROM t\n        ^";
        assert_eq!(error_position(msg, "SELECT 1\nFROM t"), Some(10));
        let mid = "x\n\nLINE 1: SELECT FROM t\n               ^";
        assert_eq!(error_position(mid, "SELECT FROM t"), Some(8));
        assert_eq!(
            error_position("Catalog Error: no such table", "select 1"),
            None
        );
    }

    #[test]
    fn interrupts_and_locks_get_their_own_codes() {
        let e = duckdb::Error::DuckDBFailure(
            duckdb::ffi::Error::new(1),
            Some("INTERRUPT Error: Interrupted!".into()),
        );
        assert_eq!(map_error(e, "x", None).code, ErrorCode::Cancelled);
        let e = duckdb::Error::DuckDBFailure(
            duckdb::ffi::Error::new(1),
            Some("IO Error: Could not set lock on file \"a.duckdb\"".into()),
        );
        let m = map_error(e, "a.duckdb", None);
        assert_eq!(m.code, ErrorCode::DatabaseLocked);
        assert!(m.message.contains("a.duckdb"));
    }
}
