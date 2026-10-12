//! Export a result or table to a file the user picks in a save dialog.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::drivers::{ColumnMeta, Value};
use crate::error::{AppError, AppResult};
use crate::exporter::{self, FileExportOptions, FileExportSummary, FileFormat};
use crate::state::AppState;

/// Progress sent while an export streams to disk.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ExportEvent {
    /// The user chose a file and the export is running.
    Started { path: String },
    Progress {
        #[ts(type = "number")]
        rows: u64,
        #[ts(type = "number")]
        bytes: u64,
    },
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportQueryRequest {
    /// Chosen by the caller so it can cancel before the call returns.
    pub export_id: String,
    pub connection_id: String,
    pub sql: String,
    pub format: FileFormat,
    pub options: FileExportOptions,
    pub default_name: String,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRowsRequest {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub format: FileFormat,
    pub options: FileExportOptions,
    pub default_name: String,
}

async fn pick_path(
    app: AppHandle,
    name: String,
    format: FileFormat,
) -> AppResult<Option<std::path::PathBuf>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        if let Some(answer) = super::scripted_dialog() {
            return answer;
        }
        app.dialog()
            .file()
            .set_title("Export")
            .set_file_name(format!("{name}.{}", format.extension()))
            .add_filter(format.extension().to_uppercase(), &[format.extension()])
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?;
    picked
        .map(|p| {
            p.into_path().map_err(|e| {
                AppError::new("io", "That location isn't a file path").with_detail(e.to_string())
            })
        })
        .transpose()
}

/// Re-run `sql` and stream every row into a file. Returns nothing when the save dialog is
/// cancelled; a cancelled export deletes the partial file.
#[tauri::command]
pub async fn export_query(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExportQueryRequest,
    on_event: Channel<ExportEvent>,
) -> AppResult<Option<FileExportSummary>> {
    let Some(path) = pick_path(app, request.default_name.clone(), request.format).await? else {
        return Ok(None);
    };
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .exports
        .lock()
        .unwrap()
        .insert(request.export_id.clone(), cancel.clone());
    let _ = on_event.send(ExportEvent::Started {
        path: path.to_string_lossy().into_owned(),
    });
    let progress_channel = on_event.clone();
    let progress: Arc<dyn Fn(u64, u64) + Send + Sync> = Arc::new(move |rows, bytes| {
        let _ = progress_channel.send(ExportEvent::Progress { rows, bytes });
    });
    let result = exporter::export_query(
        &state.sessions,
        exporter::QueryExport {
            connection_id: request.connection_id,
            sql: request.sql,
            format: request.format,
            options: request.options,
            path,
            cancel,
            progress,
        },
    )
    .await;
    state.exports.lock().unwrap().remove(&request.export_id);
    result.map(Some)
}

/// Ask a running export to stop; it deletes its partial file.
#[tauri::command]
pub fn export_cancel(state: State<'_, AppState>, export_id: String) {
    if let Some(flag) = state.exports.lock().unwrap().get(&export_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Write rows the grid already holds.
#[tauri::command]
pub async fn export_rows(
    app: AppHandle,
    request: ExportRowsRequest,
) -> AppResult<Option<FileExportSummary>> {
    let Some(path) = pick_path(app, request.default_name, request.format).await? else {
        return Ok(None);
    };
    exporter::export_rows(
        &path,
        request.format,
        &request.options,
        &request.columns,
        &request.rows,
    )
    .map(Some)
}

/// Ask where to save a file with the given extension (`json`, `jsonl`, `csv`). `None` when the
/// dialog is cancelled. Used by exports that the driver itself writes (MongoDB collections).
#[tauri::command]
pub async fn export_pick_path(
    app: AppHandle,
    default_name: String,
    extension: String,
) -> AppResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        if let Some(answer) = super::scripted_dialog() {
            return answer;
        }
        app.dialog()
            .file()
            .set_title("Export")
            .set_file_name(format!("{default_name}.{extension}"))
            .add_filter(extension.to_uppercase(), &[extension.as_str()])
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?;
    picked
        .map(|p| {
            p.into_path()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| {
                    AppError::new("io", "That location isn't a file path")
                        .with_detail(e.to_string())
                })
        })
        .transpose()
}
