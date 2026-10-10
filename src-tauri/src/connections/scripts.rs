//! Each connection's Scripts folder: SQL files linked to it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::model::Connection;
use super::service::{expand_home, ConnectionService, SaveRequest, SecretUpdate};
use crate::error::{AppError, AppResult};

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

/// One SQL file in a connection's Scripts folder (content is read when it is opened).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFile {
    /// File name without folders, e.g. `monthly_revenue.sql`.
    pub name: String,
    /// Path relative to the Scripts folder with `/` separators.
    pub rel_path: String,
    /// Absolute path.
    pub path: String,
}

/// Every `.sql` file under `dir`, sorted by relative path. Reads no content.
pub fn list_script_files(dir: &Path) -> Vec<ScriptFile> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<ScriptFile>) {
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
                && path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("sql"))
            {
                if let Ok(rel) = path.strip_prefix(base) {
                    let rel_path = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/");
                    out.push(ScriptFile {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        rel_path,
                        path: path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

/// Show a file or folder in Finder / Explorer.
fn reveal_in_file_manager(path: &Path, is_file: bool) -> AppResult<()> {
    let result = if cfg!(target_os = "macos") {
        let mut cmd = std::process::Command::new("open");
        if is_file {
            cmd.arg("-R");
        }
        cmd.arg(path).status()
    } else if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("explorer");
        if is_file {
            cmd.arg(format!("/select,{}", path.display()));
        } else {
            cmd.arg(path);
        }
        // Explorer reports a non-zero exit code even on success.
        cmd.status().map(|_| std::process::ExitStatus::default())
    } else {
        std::process::Command::new("xdg-open")
            .arg(if is_file {
                path.parent().unwrap_or(path)
            } else {
                path
            })
            .status()
    };
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err(AppError::new("io", "Couldn't open the file manager")),
        Err(e) => {
            Err(AppError::new("io", "Couldn't open the file manager").with_detail(e.to_string()))
        }
    }
}

/// A connection's Scripts folder, for the save dialog and the Advanced tab.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ScriptsInfo {
    pub path: String,
    /// Set by the user (not the default for the name).
    pub custom: bool,
    pub exists: bool,
}

/// Offered after a rename: the default folder still carries the old name.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FolderRename {
    pub from: String,
    pub to: String,
}

impl ConnectionService {
    /// The Scripts folder of every connection (the places consoles may read and write freely).
    pub fn scripts_dirs(&self) -> Vec<PathBuf> {
        self.list()
            .map(|f| f.connections.iter().filter_map(scripts_dir_of).collect())
            .unwrap_or_default()
    }

    /// The SQL files in the connection's Scripts folder (none when the folder doesn't exist).
    pub fn scripts_list(&self, id: &str) -> AppResult<Vec<ScriptFile>> {
        let c = self.get(id)?;
        let dir = scripts_dir_of(&c)
            .ok_or_else(|| AppError::new("not_found", "Couldn't work out the Scripts folder"))?;
        Ok(list_script_files(&dir))
    }

    /// Create an empty script (never overwriting) and return its absolute path.
    pub fn scripts_create(&self, id: &str, name: &str) -> AppResult<String> {
        let c = self.get(id)?;
        let dir = scripts_dir_of(&c)
            .ok_or_else(|| AppError::new("not_found", "Couldn't work out the Scripts folder"))?;
        let mut file_name = sanitize_dir_name(name.trim());
        if !file_name.to_ascii_lowercase().ends_with(".sql") {
            file_name.push_str(".sql");
        }
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::new("io", "Couldn't create the Scripts folder").with_detail(e.to_string())
        })?;
        let path = free_path(&dir, &file_name);
        std::fs::write(&path, "").map_err(|e| {
            AppError::new("io", "Couldn't create the script").with_detail(e.to_string())
        })?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Show the Scripts folder, or one file in it (`rel_path`), in the file manager.
    pub fn scripts_reveal(&self, id: &str, rel_path: Option<&str>) -> AppResult<()> {
        let c = self.get(id)?;
        let dir = scripts_dir_of(&c)
            .ok_or_else(|| AppError::new("not_found", "Couldn't work out the Scripts folder"))?;
        match rel_path {
            Some(rel) => {
                let rel = safe_relative(rel).ok_or_else(|| {
                    AppError::new("invalid", "That path isn't inside the Scripts folder")
                })?;
                let path = dir.join(rel);
                if !path.exists() {
                    return Err(AppError::new("not_found", "That file no longer exists"));
                }
                reveal_in_file_manager(&path, true)
            }
            None => {
                std::fs::create_dir_all(&dir).map_err(|e| {
                    AppError::new("io", "Couldn't create the Scripts folder")
                        .with_detail(e.to_string())
                })?;
                reveal_in_file_manager(&dir, false)
            }
        }
    }

    pub fn scripts_info(&self, id: &str) -> AppResult<ScriptsInfo> {
        let c = self.get(id)?;
        let dir = scripts_dir_of(&c)
            .ok_or_else(|| AppError::new("not_found", "Couldn't work out the Scripts folder"))?;
        Ok(ScriptsInfo {
            custom: c
                .scripts_dir
                .as_deref()
                .is_some_and(|d| !d.trim().is_empty()),
            exists: dir.exists(),
            path: dir.to_string_lossy().into_owned(),
        })
    }

    /// Rename a connection. Its links to SQL files are kept: when the folder follows the name and
    /// exists, the caller is offered to rename it too (see [`Self::finish_folder_rename`]).
    pub fn rename(&self, id: &str, name: &str) -> AppResult<Option<FolderRename>> {
        let mut c = self.get(id)?;
        let old_default = (c.scripts_dir.is_none())
            .then(|| default_scripts_dir(&c.name))
            .flatten();
        c.name = name.trim().to_string();
        let new_default = default_scripts_dir(&c.name);
        self.save(SaveRequest {
            connection: c,
            password: SecretUpdate::Keep,
            ssh_passphrase: SecretUpdate::Keep,
            ssh_password: SecretUpdate::Keep,
        })?;
        Ok(match (old_default, new_default) {
            (Some(from), Some(to)) if from != to && from.exists() => Some(FolderRename {
                from: from.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
            }),
            _ => None,
        })
    }

    /// Apply the user's answer to a [`FolderRename`] offer. Declining pins the old folder so the
    /// linked files stay linked.
    pub fn finish_folder_rename(
        &self,
        id: &str,
        offer: &FolderRename,
        rename_folder: bool,
    ) -> AppResult<()> {
        let mut c = self.get(id)?;
        let from = PathBuf::from(&offer.from);
        let to = PathBuf::from(&offer.to);
        if rename_folder && !to.exists() && from.exists() {
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::rename(&from, &to).map_err(|e| {
                AppError::new("io", "Couldn't rename the Scripts folder").with_detail(e.to_string())
            })?;
        } else if from.exists() {
            c.scripts_dir = Some(offer.from.clone());
            self.save(SaveRequest {
                connection: c,
                password: SecretUpdate::Keep,
                ssh_passphrase: SecretUpdate::Keep,
                ssh_password: SecretUpdate::Keep,
            })?;
        }
        Ok(())
    }
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

#[cfg(test)]
mod service_tests {
    use super::*;
    use crate::connections::secrets::MemoryStore;
    use crate::connections::service::{PasswordPrompt, PasswordPrompter};
    use crate::connections::store::tests::conn;
    use crate::drivers::Secret;
    use async_trait::async_trait;
    use std::sync::Arc;

    struct NoPrompt;
    #[async_trait]
    impl PasswordPrompter for NoPrompt {
        async fn ask(&self, _: PasswordPrompt) -> Option<Secret> {
            None
        }
    }

    // HOME decides the default folder; tests that change it must not run in parallel.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_home<T>(f: impl FnOnce(&std::path::Path, ConnectionService) -> T) -> T {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let old = std::env::var_os("HOME");
        // SAFETY: serialized by HOME_LOCK; no other test in this module reads HOME concurrently.
        unsafe { std::env::set_var("HOME", home.path()) };
        let (svc, _) = ConnectionService::new(
            &home.path().join("data"),
            Arc::new(MemoryStore::default()),
            Arc::new(NoPrompt),
        );
        let out = f(home.path(), svc);
        match old {
            Some(v) => unsafe { std::env::set_var("HOME", v) },
            None => unsafe { std::env::remove_var("HOME") },
        }
        out
    }

    fn save(svc: &ConnectionService, c: Connection) {
        svc.save(SaveRequest {
            connection: c,
            password: SecretUpdate::Keep,
            ssh_passphrase: SecretUpdate::Keep,
            ssh_password: SecretUpdate::Keep,
        })
        .unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn the_default_folder_follows_the_name_and_reports_existence() {
        with_home(|home, svc| {
            save(&svc, conn("c1", "staging-mysql"));
            let info = svc.scripts_info("c1").unwrap();
            assert_eq!(
                info.path,
                home.join("Documents/Clew/Scripts/staging-mysql")
                    .to_string_lossy()
            );
            assert!(!info.custom && !info.exists);
        });
    }

    #[test]
    #[cfg(unix)]
    fn renaming_offers_to_move_the_folder_and_declining_keeps_the_link() {
        with_home(|home, svc| {
            save(&svc, conn("c1", "old"));
            let old_dir = home.join("Documents/Clew/Scripts/old");
            std::fs::create_dir_all(&old_dir).unwrap();
            std::fs::write(old_dir.join("a.sql"), "select 1").unwrap();

            let offer = svc.rename("c1", "new").unwrap().expect("offer");
            assert!(offer.from.ends_with("Scripts/old") && offer.to.ends_with("Scripts/new"));
            // decline: the connection stays linked to the old folder
            svc.finish_folder_rename("c1", &offer, false).unwrap();
            let info = svc.scripts_info("c1").unwrap();
            assert!(info.custom && info.path.ends_with("Scripts/old"));
            assert!(old_dir.join("a.sql").exists());

            // a never-linked connection renamed with its folder accepted
            save(&svc, conn("c2", "second"));
            let d2 = home.join("Documents/Clew/Scripts/second");
            std::fs::create_dir_all(&d2).unwrap();
            let offer2 = svc.rename("c2", "third").unwrap().unwrap();
            svc.finish_folder_rename("c2", &offer2, true).unwrap();
            assert!(!d2.exists() && home.join("Documents/Clew/Scripts/third").exists());
            assert!(svc.scripts_info("c2").unwrap().exists);
        });
    }

    #[test]
    #[cfg(unix)]
    fn no_offer_without_a_folder_or_for_a_custom_one() {
        with_home(|home, svc| {
            save(&svc, conn("c1", "plain"));
            assert!(svc.rename("c1", "plainer").unwrap().is_none());
            let mut custom = conn("c2", "custom");
            custom.scripts_dir = Some(home.join("mine").to_string_lossy().into_owned());
            save(&svc, custom);
            std::fs::create_dir_all(home.join("Documents/Clew/Scripts/custom")).unwrap();
            assert!(svc.rename("c2", "renamed").unwrap().is_none());
        });
    }

    #[test]
    fn script_files_list_sorted_without_reading_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("reports")).unwrap();
        std::fs::write(dir.path().join("b.sql"), "select 1").unwrap();
        std::fs::write(dir.path().join("A.SQL"), "select 2").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "no").unwrap();
        std::fs::write(dir.path().join("reports").join("monthly.sql"), "x").unwrap();
        let files = list_script_files(dir.path());
        let rel: Vec<_> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rel, ["A.SQL", "b.sql", "reports/monthly.sql"]);
        assert_eq!(files[2].name, "monthly.sql");
        assert!(files[2].path.ends_with("monthly.sql"));
        assert!(list_script_files(&dir.path().join("missing")).is_empty());
    }
}
