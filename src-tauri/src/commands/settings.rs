use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::settings::{self, Settings};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    pub settings: Settings,
    /// Non-blocking notice for the UI (e.g. a corrupt file was reset).
    pub notice: Option<String>,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> SettingsPayload {
    let out = settings::load(&state.data_dir);
    SettingsPayload {
        settings: out.settings,
        notice: out.backup.map(|b| {
            format!(
                "Settings could not be read, so defaults are in use. The old file was kept as {}.",
                b.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            )
        }),
    }
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: Settings) -> AppResult<Settings> {
    let clean = settings.sanitized();
    settings::save(&state.data_dir, &clean)?;
    Ok(clean)
}
