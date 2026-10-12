//! End-to-end test mode. Compiled only with `--features e2e` and switched on by `CLEW_E2E=1`.
//!
//! Test mode gives a run its own data directory, a file-backed secret store instead of the OS
//! keychain, native dialogs answered from a queue file, no optional network calls and a fixed
//! clock. Release builds do not contain any of it (CI checks the feature tree and the binary).

use std::fs;
use std::path::{Path, PathBuf};

use crate::connections::secrets::{
    account, SecretError, SecretKind, SecretStore, MAX_SECRET_BYTES,
};
use crate::drivers::Secret;

pub const ENV_ACTIVE: &str = "CLEW_E2E";
pub const ENV_DATA_DIR: &str = "CLEW_DATA_DIR";
pub const ENV_DIALOG_QUEUE: &str = "CLEW_E2E_DIALOG_QUEUE";
pub const ENV_NOW: &str = "CLEW_E2E_NOW";
/// A queue line with this text answers a dialog as cancelled.
pub const CANCEL: &str = "CANCEL";
const SECRETS_FILE: &str = "e2e-secrets.json";

fn env_flag() -> bool {
    std::env::var(ENV_ACTIVE).is_ok_and(|v| v == "1")
}

/// Test mode is on: this is an `e2e` build and `CLEW_E2E=1`.
pub fn active() -> bool {
    env_flag()
}

/// `CLEW_DATA_DIR`, when test mode is on. Replaces the platform data directory entirely.
pub fn data_dir_override() -> Option<PathBuf> {
    if !active() {
        return None;
    }
    std::env::var_os(ENV_DATA_DIR)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Update checks and the Copilot download stay off in test mode, whatever the settings say.
pub fn network_extras_disabled() -> bool {
    active()
}

/// `CLEW_E2E_NOW` (RFC 3339), so relative-time text ("5 minutes ago") is deterministic.
pub fn fixed_now() -> Option<String> {
    if !active() {
        return None;
    }
    std::env::var(ENV_NOW).ok().filter(|v| !v.is_empty())
}

/// Take the next answer for a native dialog from the queue file: `Some(path)`, or `None` for
/// cancel (also when the queue is empty or unset, so a forgotten answer never hangs a run).
pub fn next_dialog_answer() -> Option<String> {
    let queue = std::env::var_os(ENV_DIALOG_QUEUE).map(PathBuf::from)?;
    pop_line(&queue)
}

fn pop_line(queue: &Path) -> Option<String> {
    let text = fs::read_to_string(queue).ok()?;
    let mut lines = text.lines();
    let first = lines.next()?.to_string();
    let rest: Vec<&str> = lines.collect();
    let rewritten = if rest.is_empty() {
        String::new()
    } else {
        format!("{}\n", rest.join("\n"))
    };
    fs::write(queue, rewritten).ok()?;
    (first != CANCEL && !first.is_empty()).then_some(first)
}

/// Secrets in a JSON file in the data directory. Plaintext is fine: it exists only in test builds.
#[derive(Debug)]
pub struct FileSecretStore {
    path: PathBuf,
    lock: std::sync::Mutex<()>,
}

impl FileSecretStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(SECRETS_FILE),
            lock: Default::default(),
        }
    }

    fn read(&self) -> Result<serde_json::Map<String, serde_json::Value>, SecretError> {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| SecretError::Unavailable(format!("secret file unreadable: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(SecretError::Unavailable(e.to_string())),
        }
    }

    fn write(&self, map: &serde_json::Map<String, serde_json::Value>) -> Result<(), SecretError> {
        let text =
            serde_json::to_string(map).map_err(|e| SecretError::Unavailable(e.to_string()))?;
        fs::write(&self.path, text).map_err(|e| SecretError::Unavailable(e.to_string()))
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<Secret>, SecretError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self
            .read()?
            .get(&account(connection_id, kind))
            .and_then(|v| v.as_str())
            .map(|s| Secret::new(s.to_string())))
    }

    fn set(
        &self,
        connection_id: &str,
        kind: SecretKind,
        value: &Secret,
    ) -> Result<(), SecretError> {
        if value.expose().len() > MAX_SECRET_BYTES {
            return Err(SecretError::TooLarge);
        }
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read()?;
        map.insert(
            account(connection_id, kind),
            serde_json::Value::from(value.expose()),
        );
        self.write(&map)
    }

    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), SecretError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read()?;
        if map.remove(&account(connection_id, kind)).is_some() {
            self.write(&map)?;
        }
        Ok(())
    }
}

/// Next scripted answer for a native dialog (`null` = cancel).
#[tauri::command]
pub fn e2e_dialog_next() -> Option<String> {
    next_dialog_answer()
}

/// Restart the process with the same environment (same data directory), so a journey can seed
/// files first and then relaunch, or check what survives a restart.
#[tauri::command]
pub fn e2e_restart(app: tauri::AppHandle) {
    app.restart()
}

/// Quit the process. `e2e_restart` leaves a new process that the WebDriver service does not own,
/// so the run ends by asking it to exit. It exits a moment later so the test runner can still
/// close its WebDriver session; closing it against a dead server is reported as a failed run.
#[tauri::command]
pub fn e2e_exit(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        app.exit(0)
    });
}

/// The fixed clock, if the run set one.
#[tauri::command]
pub fn e2e_now() -> Option<String> {
    fixed_now()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_round_trips_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        assert!(store.get("c1", SecretKind::Password).unwrap().is_none());
        store
            .set("c1", SecretKind::Password, &Secret::new("pw".to_string()))
            .unwrap();
        let got = store.get("c1", SecretKind::Password).unwrap().unwrap();
        assert_eq!(got.expose(), "pw");
        store.delete("c1", SecretKind::Password).unwrap();
        assert!(store.get("c1", SecretKind::Password).unwrap().is_none());
        store.delete("c1", SecretKind::Password).unwrap();
    }

    #[test]
    fn file_store_refuses_oversized_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        let big = Secret::new("x".repeat(MAX_SECRET_BYTES + 1));
        assert_eq!(
            store.set("c1", SecretKind::Password, &big),
            Err(SecretError::TooLarge)
        );
    }

    #[test]
    fn dialog_queue_pops_in_order_then_cancels() {
        let dir = tempfile::tempdir().unwrap();
        let queue = dir.path().join("q.txt");
        fs::write(&queue, "/a/one.json\nCANCEL\n/b/two.json\n").unwrap();
        assert_eq!(pop_line(&queue).as_deref(), Some("/a/one.json"));
        assert_eq!(pop_line(&queue), None); // CANCEL
        assert_eq!(pop_line(&queue).as_deref(), Some("/b/two.json"));
        assert_eq!(pop_line(&queue), None); // empty queue
    }
}
