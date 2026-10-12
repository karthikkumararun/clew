//! The application log: one text file in the data directory, kept short, read back for the
//! diagnostics report. Messages must never carry secrets, query text or row data; the report
//! redacts again, but the log is the first line of defence.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const FILE: &str = "clew.log";
/// Trimmed at start-up when larger than this.
const MAX_BYTES: u64 = 512 * 1024;
const KEEP_LINES: usize = 2000;

static PATH: OnceLock<PathBuf> = OnceLock::new();

/// Point the log at `<data dir>/clew.log` and trim an oversized one.
pub fn init(data_dir: &Path) {
    let path = data_dir.join(FILE);
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let keep = tail_of(&path, KEEP_LINES).join("\n");
        let _ = fs::write(&path, format!("{keep}\n"));
    }
    let _ = PATH.set(path);
}

/// Append one line (newlines in `message` become spaces) and echo it to stderr.
pub fn log(message: &str) {
    eprintln!("{message}");
    let Some(path) = PATH.get() else { return };
    let line = format!(
        "{} {}\n",
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
        message.replace(['\n', '\r'], " ")
    );
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// The last `n` lines of the log, oldest first.
pub fn tail(n: usize) -> Vec<String> {
    PATH.get().map(|p| tail_of(p, n)).unwrap_or_default()
}

fn tail_of(path: &Path, n: usize) -> Vec<String> {
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_last_lines_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.log");
        fs::write(&p, "a\nb\nc\nd\n").unwrap();
        assert_eq!(tail_of(&p, 2), vec!["c", "d"]);
        assert_eq!(tail_of(&p, 10).len(), 4);
        assert!(tail_of(&dir.path().join("missing"), 5).is_empty());
    }
}
