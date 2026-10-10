use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_VERSION: u32 = 1;
const GRID_PAGE_SIZES: [u32; 3] = [100, 500, 1000];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    /// Editor font size in px (11–20).
    pub editor_font_size: u32,
    /// Rows per data-grid page: 100, 500 or 1000.
    pub grid_page_size: u32,
    pub confirm_close_unsaved: bool,
    /// Opt-in update check.
    pub check_for_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            editor_font_size: 13,
            grid_page_size: 500,
            confirm_close_unsaved: true,
            check_for_updates: false,
        }
    }
}

impl Settings {
    /// Pull out-of-range values back to something valid.
    pub fn sanitized(mut self) -> Self {
        let defaults = Settings::default();
        self.version = SETTINGS_VERSION;
        self.editor_font_size = self.editor_font_size.clamp(11, 20);
        if !GRID_PAGE_SIZES.contains(&self.grid_page_size) {
            self.grid_page_size = defaults.grid_page_size;
        }
        self
    }
}

#[derive(Debug)]
pub struct LoadOutcome {
    pub settings: Settings,
    /// Set when the file could not be parsed: where the bad file was moved to.
    pub backup: Option<PathBuf>,
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read `settings.json` from `dir`. A missing file yields defaults. An unparseable file is
/// moved aside (`settings.json.corrupt-<unix time>`), defaults are written and returned.
pub fn load(dir: &Path) -> LoadOutcome {
    let path = dir.join(SETTINGS_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LoadOutcome {
                settings: Settings::default(),
                backup: None,
            }
        }
        Err(_) => return recover(dir, &path),
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(s) => LoadOutcome {
            settings: s.sanitized(),
            backup: None,
        },
        Err(_) => recover(dir, &path),
    }
}

fn recover(dir: &Path, path: &Path) -> LoadOutcome {
    let backup = dir.join(format!("{SETTINGS_FILE}.corrupt-{}", timestamp()));
    let backup = fs::rename(path, &backup).ok().map(|_| backup);
    let settings = Settings::default();
    let _ = save(dir, &settings);
    LoadOutcome { settings, backup }
}

/// Write atomically (temp file + rename) so a crash never leaves a half-written file.
pub fn save(dir: &Path, settings: &Settings) -> AppResult<()> {
    let io = |e: std::io::Error| {
        AppError::new("settings_io", "Could not save settings").with_detail(e.to_string())
    };
    fs::create_dir_all(dir).map_err(io)?;
    let json = serde_json::to_string_pretty(&settings.clone().sanitized()).map_err(|e| {
        AppError::new("settings_serialize", "Could not save settings").with_detail(e.to_string())
    })?;
    let tmp = dir.join(format!("{SETTINGS_FILE}.tmp"));
    fs::write(&tmp, json).map_err(io)?;
    fs::rename(&tmp, dir.join(SETTINGS_FILE)).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults_without_notice() {
        let dir = tempfile::tempdir().unwrap();
        let out = load(dir.path());
        assert_eq!(out.settings, Settings::default());
        assert!(out.backup.is_none());
    }

    #[test]
    fn defaults_match_the_spec() {
        let s = Settings::default();
        assert_eq!(s.editor_font_size, 13);
        assert_eq!(s.grid_page_size, 500);
        assert!(s.confirm_close_unsaved);
        assert!(!s.check_for_updates);
    }

    #[test]
    fn round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            editor_font_size: 15,
            grid_page_size: 1000,
            confirm_close_unsaved: false,
            check_for_updates: true,
            ..Settings::default()
        };
        save(dir.path(), &s).unwrap();
        assert_eq!(load(dir.path()).settings, s);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_defaults_used() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), "{ not json").unwrap();
        let out = load(dir.path());
        assert_eq!(out.settings, Settings::default());
        let backup = out.backup.expect("backup path");
        assert_eq!(fs::read_to_string(backup).unwrap(), "{ not json");
        // defaults were written back so the next launch is clean
        assert!(load(dir.path()).backup.is_none());
    }

    #[test]
    fn partial_file_fills_in_defaults() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"version":1,"editorFontSize":16}"#,
        )
        .unwrap();
        let s = load(dir.path()).settings;
        assert_eq!(s.editor_font_size, 16);
        assert_eq!(s.grid_page_size, 500);
    }

    #[test]
    fn out_of_range_values_are_pulled_back() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"editorFontSize":99,"gridPageSize":7}"#,
        )
        .unwrap();
        let s = load(dir.path()).settings;
        assert_eq!(s.editor_font_size, 20);
        assert_eq!(s.grid_page_size, 500);
    }
}
