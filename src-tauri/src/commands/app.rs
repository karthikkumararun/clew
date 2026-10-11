use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::paths;

/// Set once the user has answered the open-transaction question: the next exit goes through.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Should closing the window / quitting wait for the user? Yes while a transaction is open and
/// the question has not been answered.
pub fn hold_quit(app: &AppHandle) -> bool {
    !QUIT_CONFIRMED.load(Ordering::SeqCst)
        && app
            .try_state::<crate::state::AppState>()
            .is_some_and(|s| s.sessions.any_in_transaction())
}

/// Whether an Oracle Instant Client can be found, and where. `dir` previews a folder that hasn't
/// been saved yet.
#[tauri::command]
pub fn oracle_client_status(dir: Option<String>) -> crate::drivers::oracle::client::ClientStatus {
    crate::drivers::oracle::client::status(dir.as_deref())
}

/// Quit now: the frontend asked about the open transactions and the user settled them.
#[tauri::command]
pub fn app_quit_confirmed(app: AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub data_dir: String,
    pub connections_file: String,
    /// Same path, with the home directory shortened to `~` where that is idiomatic.
    pub connections_file_display: String,
    pub app_version: String,
}

pub fn build_app_paths(
    platform_data_dir: &std::path::Path,
    home: Option<&std::path::Path>,
    version: &str,
) -> AppPaths {
    let data_dir = paths::app_data_dir(platform_data_dir);
    let file = data_dir.join(paths::CONNECTIONS_FILE);
    AppPaths {
        data_dir: data_dir.display().to_string(),
        connections_file: file.display().to_string(),
        connections_file_display: paths::display_path(&file, home),
        app_version: version.to_string(),
    }
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> AppResult<AppPaths> {
    let resolver = app.path();
    let data = resolver.data_dir().map_err(|e| {
        AppError::new("paths", "Could not locate the app data directory").with_detail(e.to_string())
    })?;
    let home = resolver.home_dir().ok();
    Ok(build_app_paths(
        &data,
        home.as_deref(),
        &app.package_info().version.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn builds_connections_file_path_and_version() {
        let p = build_app_paths(Path::new("/data"), None, "0.1.0");
        assert!(p.connections_file.ends_with("connections.json"));
        assert!(p.connections_file.contains("Clew"));
        assert_eq!(p.app_version, "0.1.0");
    }

    #[test]
    fn serializes_camel_case() {
        let p = build_app_paths(Path::new("/data"), None, "0.1.0");
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("connectionsFileDisplay").is_some());
        assert!(v.get("appVersion").is_some());
    }
}
