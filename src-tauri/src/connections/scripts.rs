//! Each connection's Scripts folder: SQL files linked to it.

use std::path::{Path, PathBuf};

use super::model::Connection;
use super::service::expand_home;

const MAX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Make a connection name safe to use as a folder name.
pub fn sanitize_dir_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "connection".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `~/Documents/Clew/Scripts`
pub fn scripts_root() -> Option<PathBuf> {
    std::env::home_dir().map(|h| h.join("Documents").join("Clew").join("Scripts"))
}

/// Default folder for a connection name: `~/Documents/Clew/Scripts/<name>/`.
pub fn default_scripts_dir(name: &str) -> Option<PathBuf> {
    scripts_root().map(|r| r.join(sanitize_dir_name(name)))
}

/// The connection's own folder if set, else the default for its name.
pub fn scripts_dir_of(c: &Connection) -> Option<PathBuf> {
    match c.scripts_dir.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(dir) => Some(PathBuf::from(expand_home(dir))),
        None => default_scripts_dir(&c.name),
    }
}

/// Every `.sql` file under `dir` as (relative path with `/` separators, content).
pub fn list_sql_files(dir: &Path) -> Vec<(String, String)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if out.len() >= MAX_FILES {
                return;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(base, &path, out);
            } else if meta.is_file()
                && meta.len() <= MAX_FILE_BYTES
                && path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("sql"))
            {
                if let (Ok(rel), Ok(text)) =
                    (path.strip_prefix(base), std::fs::read_to_string(&path))
                {
                    let rel = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/");
                    out.push((rel, text));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

/// A path inside `dir` for a file called `name`, with a numeric suffix when taken.
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("a free name exists")
}

/// Reject relative paths that would escape the folder they are written into.
pub fn safe_relative(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if p.is_absolute() || rel.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_safe_folder_names() {
        assert_eq!(sanitize_dir_name("prod/db: main"), "prod_db_ main");
        assert_eq!(sanitize_dir_name("  .. "), "connection");
        assert_eq!(sanitize_dir_name("analytics-prod"), "analytics-prod");
    }

    #[test]
    fn lists_sql_files_recursively_with_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("a.sql"), "select 1").unwrap();
        std::fs::write(dir.path().join("sub").join("b.SQL"), "select 2").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "no").unwrap();
        let files = list_sql_files(dir.path());
        assert_eq!(
            files,
            vec![
                ("a.sql".to_string(), "select 1".to_string()),
                ("sub/b.SQL".to_string(), "select 2".to_string())
            ]
        );
    }

    #[test]
    fn existing_files_get_a_numeric_suffix() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(free_path(dir.path(), "q.sql"), dir.path().join("q.sql"));
        std::fs::write(dir.path().join("q.sql"), "x").unwrap();
        assert_eq!(free_path(dir.path(), "q.sql"), dir.path().join("q (2).sql"));
        std::fs::write(dir.path().join("q (2).sql"), "x").unwrap();
        assert_eq!(free_path(dir.path(), "q.sql"), dir.path().join("q (3).sql"));
    }

    #[test]
    fn relative_paths_cannot_escape() {
        assert_eq!(safe_relative("a/b.sql"), Some(PathBuf::from("a/b.sql")));
        assert_eq!(safe_relative("../x.sql"), None);
        assert_eq!(safe_relative("/etc/passwd"), None);
        assert_eq!(safe_relative("a/../../x"), None);
        assert_eq!(safe_relative(""), None);
    }
}
