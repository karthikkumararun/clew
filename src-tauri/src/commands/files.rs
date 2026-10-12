//! SQL files for consoles: dialogs run here, so the WebView only ever holds paths the user chose.

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::connections::scripts::scripts_dir_of;
use crate::error::{AppError, AppResult};
use crate::files::OpenedFile;
use crate::state::AppState;

fn roots(state: &AppState) -> Vec<PathBuf> {
    state.connections.scripts_dirs()
}

fn into_path(p: tauri_plugin_dialog::FilePath) -> AppResult<PathBuf> {
    p.into_path().map_err(|e| {
        AppError::new("io", "That location isn't a file path").with_detail(e.to_string())
    })
}

/// Let the user pick a `.sql` file and read it.
#[tauri::command]
pub async fn file_open_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<OpenedFile>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        if let Some(answer) = super::scripted_dialog() {
            return answer;
        }
        app.dialog()
            .file()
            .set_title("Open SQL file")
            .add_filter("SQL", &["sql"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?;
    let Some(path) = picked else { return Ok(None) };
    let path = into_path(path)?;
    state.files.allow(&path);
    Ok(Some(crate::files::read_file(&crate::files::normalize(
        &path,
    ))?))
}

/// Let the user choose where to save `text`, starting in the connection's Scripts folder, and
/// write it. Returns the chosen path, or nothing when the dialog was cancelled.
#[tauri::command]
pub async fn file_save_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: Option<String>,
    default_name: String,
    text: String,
) -> AppResult<Option<String>> {
    let start = connection_id
        .and_then(|id| state.connections.get(&id).ok())
        .and_then(|c| scripts_dir_of(&c));
    if let Some(dir) = &start {
        // The dialog can only open in a folder that exists.
        let _ = std::fs::create_dir_all(dir);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        if let Some(answer) = super::scripted_dialog() {
            return answer;
        }
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Save SQL file")
            .set_file_name(default_name)
            .add_filter("SQL", &["sql"]);
        if let Some(dir) = start {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?;
    let Some(path) = picked else { return Ok(None) };
    let path = into_path(path)?;
    state.files.write_picked(&path, &text)?;
    Ok(Some(
        crate::files::normalize(&path)
            .to_string_lossy()
            .into_owned(),
    ))
}

/// Read a file the user opened earlier, or one in a Scripts folder.
#[tauri::command]
pub fn file_read(state: State<'_, AppState>, path: String) -> AppResult<OpenedFile> {
    state.files.read(&path, &roots(&state))
}

/// Write a file the user opened earlier, or one in a Scripts folder.
#[tauri::command]
pub fn file_write(
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> AppResult<Option<u64>> {
    state.files.write(&path, &text, &roots(&state))
}

/// Report changes to an open file as `file_changed` events.
#[tauri::command]
pub fn file_watch(state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.files.watch(&path, &roots(&state))
}

#[tauri::command]
pub fn file_unwatch(state: State<'_, AppState>, path: String) {
    state.files.unwatch(&path);
}
