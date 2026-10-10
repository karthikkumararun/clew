use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::paths;

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
