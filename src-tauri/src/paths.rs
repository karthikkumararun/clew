use std::path::{Path, PathBuf};

pub const APP_DIR_NAME: &str = "Clew";
pub const CONNECTIONS_FILE: &str = "connections.json";

/// `<platform data dir>/Clew`: `~/Library/Application Support/Clew` on macOS, `%APPDATA%\Clew` on Windows.
pub fn app_data_dir(platform_data_dir: &Path) -> PathBuf {
    platform_data_dir.join(APP_DIR_NAME)
}

/// Shorten a path under the user's home to `~/...` for display (macOS/Linux style).
pub fn display_path(path: &Path, home: Option<&Path>) -> String {
    if cfg!(not(windows)) {
        if let Some(rel) = home.and_then(|h| path.strip_prefix(h).ok()) {
            return format!("~/{}", rel.display());
        }
    }
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_is_named_clew() {
        let dir = app_data_dir(Path::new("/x/Application Support"));
        assert!(dir.ends_with("Clew"));
    }

    #[cfg(not(windows))]
    #[test]
    fn home_prefix_is_shortened() {
        let home = Path::new("/Users/ada");
        let file = home.join("Library/Application Support/Clew/connections.json");
        assert_eq!(
            display_path(&file, Some(home)),
            "~/Library/Application Support/Clew/connections.json"
        );
    }

    #[test]
    fn paths_outside_home_are_left_alone() {
        let file = Path::new("/opt/clew/connections.json");
        let shown = display_path(file, Some(Path::new("/Users/ada")));
        assert_eq!(shown, file.display().to_string());
    }
}
