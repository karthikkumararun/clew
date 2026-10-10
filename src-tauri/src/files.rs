//! SQL file access for consoles. The WebView never gets a general file system: it can read and
//! write only paths the user picked in a dialog (opened here, in Rust) and files inside the
//! connections' Scripts folders. Picked paths are remembered across restarts in
//! `<app data>/allowed-files.json`, which only this module writes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::error::{AppError, AppResult};

const ALLOWED_FILE: &str = "allowed-files.json";
/// Remembered paths beyond this are dropped, oldest first.
const MAX_ALLOWED: usize = 5000;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub text: String,
    /// Modification time in ms since the epoch, when the platform reports one.
    #[ts(type = "number | null")]
    pub mtime_ms: Option<u64>,
}

/// Emits a changed path to the WebView.
pub type Notify = Arc<dyn Fn(&str) + Send + Sync>;

/// Make a path absolute and, where it (or its folder) exists, canonical, so that `./a/../b.sql`
/// and a symlink to it name the same file.
pub fn normalize(path: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(path) {
        return c;
    }
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|d| d.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    match (
        abs.parent().and_then(|p| std::fs::canonicalize(p).ok()),
        abs.file_name(),
    ) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => abs,
    }
}

pub struct FileAccess {
    store: PathBuf,
    /// Insertion order is kept so the oldest entries can be dropped.
    allowed: Mutex<Vec<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Arc<Mutex<HashSet<PathBuf>>>,
    notify: Notify,
}

impl std::fmt::Debug for FileAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileAccess").finish_non_exhaustive()
    }
}

impl FileAccess {
    pub fn new(data_dir: &Path, notify: Notify) -> Self {
        let store = data_dir.join(ALLOWED_FILE);
        let allowed: Vec<PathBuf> = std::fs::read_to_string(&store)
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
            .map(|v| v.into_iter().map(PathBuf::from).collect())
            .unwrap_or_default();
        Self {
            store,
            allowed: Mutex::new(allowed),
            watcher: Mutex::new(None),
            watched: Arc::new(Mutex::new(HashSet::new())),
            notify,
        }
    }

    fn persist(&self, allowed: &[PathBuf]) {
        let list: Vec<String> = allowed
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if let Ok(json) = serde_json::to_string(&list) {
            let tmp = self.store.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.store);
            }
        }
    }

    /// Remember a path the user picked in a dialog.
    pub fn allow(&self, path: &Path) {
        let path = normalize(path);
        let mut allowed = self.allowed.lock().unwrap();
        if allowed.contains(&path) {
            return;
        }
        allowed.push(path);
        if allowed.len() > MAX_ALLOWED {
            let drop = allowed.len() - MAX_ALLOWED;
            allowed.drain(..drop);
        }
        self.persist(&allowed);
    }

    /// Whether the WebView may read / write `path`: picked by the user, or inside one of `roots`
    /// (the connections' Scripts folders).
    pub fn is_allowed(&self, path: &Path, roots: &[PathBuf]) -> bool {
        let path = normalize(path);
        if self.allowed.lock().unwrap().contains(&path) {
            return true;
        }
        roots.iter().any(|r| path.starts_with(normalize(r)))
    }

    fn check(&self, path: &str, roots: &[PathBuf]) -> AppResult<PathBuf> {
        let p = PathBuf::from(path);
        if !self.is_allowed(&p, roots) {
            return Err(AppError::new(
                "access_denied",
                "That file wasn't opened from a file dialog or a Scripts folder",
            ));
        }
        Ok(normalize(&p))
    }

    /// Read an allowed file.
    pub fn read(&self, path: &str, roots: &[PathBuf]) -> AppResult<OpenedFile> {
        let p = self.check(path, roots)?;
        read_file(&p)
    }

    /// Write an allowed file (replacing it atomically). Returns its new modification time.
    pub fn write(&self, path: &str, text: &str, roots: &[PathBuf]) -> AppResult<Option<u64>> {
        let p = self.check(path, roots)?;
        write_file(&p, text)?;
        Ok(mtime_ms(&p))
    }

    /// Write a file the user just chose in a save dialog and remember it.
    pub fn write_picked(&self, path: &Path, text: &str) -> AppResult<()> {
        write_file(&normalize(path), text)?;
        self.allow(path);
        Ok(())
    }

    /// Start reporting changes to an allowed file.
    pub fn watch(&self, path: &str, roots: &[PathBuf]) -> AppResult<()> {
        let p = self.check(path, roots)?;
        let Some(dir) = p.parent().map(Path::to_path_buf) else {
            return Ok(());
        };
        let mut watcher = self.watcher.lock().unwrap();
        if watcher.is_none() {
            let watched = self.watched.clone();
            let notify = self.notify.clone();
            let created = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                let set = watched.lock().unwrap();
                for changed in &event.paths {
                    if set.contains(&normalize(changed)) {
                        notify(&changed.to_string_lossy());
                    }
                }
            })
            .map_err(|e| {
                AppError::new("io", "Couldn't watch the file").with_detail(e.to_string())
            })?;
            *watcher = Some(created);
        }
        self.watched.lock().unwrap().insert(p);
        // Watch the folder: editors that save by replacing the file would drop a file watch.
        if let Some(w) = watcher.as_mut() {
            let _ = w.watch(&dir, RecursiveMode::NonRecursive);
        }
        Ok(())
    }

    pub fn unwatch(&self, path: &str) {
        self.watched
            .lock()
            .unwrap()
            .remove(&normalize(Path::new(path)));
    }
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

pub fn read_file(path: &Path) -> AppResult<OpenedFile> {
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::new("not_found", "That file no longer exists"),
        _ => AppError::new("io", "Couldn't read the file").with_detail(e.to_string()),
    })?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::new(
            "too_large",
            "That file is too large to open in a console",
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::new("io", "Couldn't read the file").with_detail(e.to_string()))?;
    Ok(OpenedFile {
        path: path.to_string_lossy().into_owned(),
        // Not valid UTF-8: show it with replacement characters rather than refuse to open.
        text: String::from_utf8_lossy(&bytes).into_owned(),
        mtime_ms: mtime_ms(path),
    })
}

fn write_file(path: &Path, text: &str) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| {
            AppError::new("io", "Couldn't create the folder").with_detail(e.to_string())
        })?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.clew-tmp"));
    std::fs::write(&tmp, text)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            AppError::new("io", "Couldn't save the file").with_detail(e.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn access(dir: &Path) -> (FileAccess, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let a = FileAccess::new(
            dir,
            Arc::new(move |_| {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        );
        (a, hits)
    }

    #[test]
    fn only_picked_paths_and_script_folders_are_accessible() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let (a, _) = access(data.path());
        let file = work.path().join("q.sql");
        std::fs::write(&file, "select 1").unwrap();

        // Nothing is allowed until the user picks it.
        let err = a.read(file.to_str().unwrap(), &[]).unwrap_err();
        assert_eq!(err.code, "access_denied");
        assert_eq!(
            a.write(file.to_str().unwrap(), "x", &[]).unwrap_err().code,
            "access_denied"
        );

        a.allow(&file);
        assert_eq!(
            a.read(file.to_str().unwrap(), &[]).unwrap().text,
            "select 1"
        );

        // A sibling is still off limits, and `..` can't reach it either.
        let other = work.path().join("secret.txt");
        std::fs::write(&other, "no").unwrap();
        assert!(!a.is_allowed(&other, &[]));
        let sneaky = work.path().join("sub").join("..").join("secret.txt");
        assert!(!a.is_allowed(&sneaky, &[]));
    }

    #[test]
    fn files_in_a_scripts_folder_are_allowed_without_a_dialog() {
        let data = tempfile::tempdir().unwrap();
        let scripts = tempfile::tempdir().unwrap();
        let (a, _) = access(data.path());
        let file = scripts.path().join("monthly.sql");
        std::fs::write(&file, "select 2").unwrap();
        let roots = vec![scripts.path().to_path_buf()];
        assert_eq!(
            a.read(file.to_str().unwrap(), &roots).unwrap().text,
            "select 2"
        );
        // The folder's parent is not part of the grant.
        let parent_file = scripts.path().parent().unwrap().join("outside.sql");
        assert!(!a.is_allowed(&parent_file, &roots));
    }

    #[test]
    fn picked_paths_survive_a_restart() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let file = work.path().join("kept.sql");
        std::fs::write(&file, "select 3").unwrap();
        {
            let (a, _) = access(data.path());
            a.allow(&file);
        }
        let (again, _) = access(data.path());
        assert_eq!(
            again.read(file.to_str().unwrap(), &[]).unwrap().text,
            "select 3"
        );
    }

    #[test]
    fn saving_writes_the_whole_file_and_reports_a_new_mtime() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let (a, _) = access(data.path());
        let file = work.path().join("new.sql");
        a.write_picked(&file, "select 1").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "select 1");
        assert!(a
            .write(file.to_str().unwrap(), "select 2;\n", &[])
            .unwrap()
            .is_some());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "select 2;\n");
        // No temp file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(work.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, ["new.sql"]);
    }

    #[test]
    fn reading_reports_missing_and_non_utf8_files() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let (a, _) = access(data.path());
        let gone = work.path().join("gone.sql");
        a.allow(&gone);
        assert_eq!(
            a.read(gone.to_str().unwrap(), &[]).unwrap_err().code,
            "not_found"
        );

        let odd = work.path().join("odd.sql");
        std::fs::write(&odd, [b's', b'e', 0xff, b'x']).unwrap();
        a.allow(&odd);
        assert_eq!(
            a.read(odd.to_str().unwrap(), &[]).unwrap().text,
            "se\u{fffd}x"
        );
    }

    #[test]
    fn a_watched_file_reports_changes_and_an_unwatched_one_does_not() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let (a, hits) = access(data.path());
        let watched = work.path().join("w.sql");
        let quiet = work.path().join("q.sql");
        std::fs::write(&watched, "a").unwrap();
        std::fs::write(&quiet, "a").unwrap();
        a.allow(&watched);
        a.allow(&quiet);
        a.watch(watched.to_str().unwrap(), &[]).unwrap();

        std::fs::write(&quiet, "changed").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "an unwatched file is not reported"
        );

        std::fs::write(&watched, "changed").unwrap();
        for _ in 0..50 {
            if hits.load(Ordering::SeqCst) > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            hits.load(Ordering::SeqCst) > 0,
            "a watched file is reported"
        );

        a.unwatch(watched.to_str().unwrap());
        let before = hits.load(Ordering::SeqCst);
        std::fs::write(&watched, "again").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(hits.load(Ordering::SeqCst), before);
    }
}
