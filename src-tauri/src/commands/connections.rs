use tauri::State;

use crate::connections::exchange::{inspect, FileInfo, KdfParams};
use crate::connections::export::{write_atomic, ExportOptions, ExportSummary};
use crate::connections::import::datagrip::{self, DataGripInstall};
use crate::connections::import::{
    CommitOptions, ImportEnv, ImportResult, ImportSource, PasswordSafeInfo, ScanView, Selection,
};
use crate::connections::model::{ConnectionsFile, Group};
use crate::connections::scripts::{FolderRename, ScriptFile, ScriptsInfo};
use crate::connections::service::{SaveOutcome, SaveRequest, SecretStatus};
use crate::connections::url::{parse_url, ParsedUrl};
use crate::drivers::{DriverError, ErrorCode, Secret, ServerInfo};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn connections_list(state: State<'_, AppState>) -> AppResult<ConnectionsFile> {
    state.connections.list()
}

#[tauri::command]
pub fn connections_save(
    state: State<'_, AppState>,
    request: SaveRequest,
) -> AppResult<SaveOutcome> {
    state.connections.save(request)
}

/// Returns warnings (e.g. secrets that could not be removed from the keychain).
#[tauri::command]
pub async fn connections_delete(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<String>> {
    state.sessions.disconnect(&connection_id).await;
    state.connections.delete(&connection_id)
}

#[tauri::command]
pub fn connections_duplicate(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<SaveOutcome> {
    state.connections.duplicate(&connection_id)
}

#[tauri::command]
pub fn groups_save(state: State<'_, AppState>, group: Group) -> AppResult<Group> {
    state.connections.save_group(group)
}

#[tauri::command]
pub fn groups_delete(state: State<'_, AppState>, group_id: String) -> AppResult<()> {
    state.connections.delete_group(&group_id)
}

#[tauri::command]
pub fn connection_secret_status(state: State<'_, AppState>, connection_id: String) -> SecretStatus {
    state.connections.secret_status(&connection_id)
}

/// Answer a `password_prompt` event. `password: null` cancels.
#[tauri::command]
pub fn password_answer(
    state: State<'_, AppState>,
    prompt_id: String,
    password: Option<Secret>,
) -> bool {
    state.password_prompts.answer(&prompt_id, password)
}

/// Parse a pasted connection URL into a prefilled draft.
#[tauri::command]
pub fn connections_parse_url(url: String) -> AppResult<ParsedUrl> {
    parse_url(&url)
}

/// "Test connection" from the dialog: connect with the unsaved draft (typed secrets win over
/// stored ones), report the server, save nothing. Cancellable through `connections_test_cancel`.
#[tauri::command]
pub async fn connections_test(
    state: State<'_, AppState>,
    request: SaveRequest,
    test_id: String,
) -> AppResult<ServerInfo> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .test_cancels
        .lock()
        .unwrap()
        .insert(test_id.clone(), tx);
    let work = async {
        let config = state.connections.resolve_draft(&request).await?;
        state.sessions.test_connection(&config).await
    };
    let result = tokio::select! {
        r = work => r,
        _ = rx => Err(DriverError::new(ErrorCode::Cancelled, "Test cancelled")),
    };
    state.test_cancels.lock().unwrap().remove(&test_id);
    Ok(result?)
}

#[tauri::command]
pub fn connections_test_cancel(state: State<'_, AppState>, test_id: String) {
    if let Some(tx) = state.test_cancels.lock().unwrap().remove(&test_id) {
        let _ = tx.send(());
    }
}

/// What the status bar shows for a connected connection.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedInfo {
    pub server: ServerInfo,
    /// `via SSH <host>` when tunnelled.
    pub transport: Option<String>,
}

/// Connect a saved connection: resolve its secrets (asking when needed), open the tunnel and the
/// metadata pool. Connecting again replaces the previous connection.
#[tauri::command]
pub async fn connections_connect(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ConnectedInfo> {
    let saved = state.connections.get(&connection_id)?;
    let config = state.connections.resolve_connection(&saved).await?;
    state.sessions.connect(&connection_id, config).await?;
    state.sessions.set_policy(
        &connection_id,
        crate::safety::guard::Policy::managed(
            &saved.name,
            &serde_json::to_value(saved.environment)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default(),
            saved.safeguards.confirm_writes,
        ),
    );
    let server = state.sessions.connection_server(&connection_id).await?;
    let _ = state.connections.touch_last_used(
        &connection_id,
        &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    );
    Ok(ConnectedInfo {
        server,
        transport: state.sessions.connection_transport(&connection_id),
    })
}

/// Sessions with an uncommitted transaction, so the UI can ask before disconnecting.
#[tauri::command]
pub fn connections_open_transactions(
    state: State<'_, AppState>,
    connection_id: String,
) -> Vec<String> {
    state.sessions.sessions_in_transaction(&connection_id)
}

/// Close every session and the tunnel; "ask every time" passwords are forgotten.
/// `end_transactions` is `commit`, `rollback`, or absent.
#[tauri::command]
pub async fn connections_disconnect(
    state: State<'_, AppState>,
    connection_id: String,
    end_transactions: Option<String>,
) -> AppResult<()> {
    state.editability.forget(&connection_id);
    match end_transactions.as_deref() {
        Some("commit") => {
            state
                .sessions
                .end_transactions(&connection_id, true)
                .await?
        }
        Some("rollback") => {
            state
                .sessions
                .end_transactions(&connection_id, false)
                .await?
        }
        _ => {}
    }
    state.sessions.disconnect(&connection_id).await;
    state.connections.forget_session_secrets(&connection_id);
    Ok(())
}

/// Counts and warnings for the Export tab; writes nothing.
#[tauri::command]
pub fn connections_export_summary(
    state: State<'_, AppState>,
    connection_ids: Vec<String>,
    options: ExportOptions,
) -> AppResult<ExportSummary> {
    state.connections.export_summary(&connection_ids, options)
}

/// Write the selected connections to `path`. With secrets the file is encrypted with the
/// passphrase (never stored or logged); otherwise it is plain JSON.
#[tauri::command]
pub async fn connections_export(
    state: State<'_, AppState>,
    connection_ids: Vec<String>,
    options: ExportOptions,
    passphrase: Option<Secret>,
    path: String,
) -> AppResult<ExportSummary> {
    let connections = state.connections.clone();
    // Argon2 takes a moment; keep it off the async workers.
    tokio::task::spawn_blocking(move || {
        let created = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let (text, summary) = connections.export_text(
            &connection_ids,
            options,
            passphrase.as_ref().map(Secret::expose),
            &created,
            KdfParams::default(),
        )?;
        write_atomic(std::path::Path::new(&path), &text)?;
        Ok(summary)
    })
    .await
    .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?
}

fn import_env(state: &AppState) -> AppResult<ImportEnv> {
    let scripts_root = crate::connections::scripts::scripts_root().ok_or_else(|| {
        crate::error::AppError::new("not_found", "Couldn't find your Documents folder")
    })?;
    Ok(ImportEnv {
        scripts_root,
        ssh_keys_dir: state.data_dir.join("ssh-keys"),
    })
}

/// DataGrip settings folders on this machine, newest first.
#[tauri::command]
pub fn import_datagrip_discover() -> Vec<DataGripInstall> {
    datagrip::discover()
}

/// How a DataGrip folder keeps its passwords (native keychain, KeePass or nowhere).
#[tauri::command]
pub fn import_datagrip_password_safe(state: State<'_, AppState>, dir: String) -> PasswordSafeInfo {
    state
        .connections
        .password_safe_info(std::path::Path::new(&dir))
}

/// Header of a `.clew` / `.json` export, readable without the passphrase.
#[tauri::command]
pub fn import_clew_inspect(path: String) -> AppResult<FileInfo> {
    let text = std::fs::read_to_string(&path).map_err(|e| {
        crate::error::AppError::new("io", "Couldn't read the file").with_detail(e.to_string())
    })?;
    Ok(inspect(&text)?)
}

/// Read a source into a review list. Nothing is saved yet.
#[tauri::command]
pub async fn import_scan(state: State<'_, AppState>, source: ImportSource) -> AppResult<ScanView> {
    let connections = state.connections.clone();
    // Argon2 and keychain reads are slow; keep them off the async workers.
    tokio::task::spawn_blocking(move || connections.import_scan(source))
        .await
        .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?
}

/// Save the checked rows of a scan.
#[tauri::command]
pub fn import_commit(
    state: State<'_, AppState>,
    scan_id: String,
    selections: Vec<Selection>,
    options: CommitOptions,
) -> AppResult<ImportResult> {
    state
        .connections
        .import_commit(&scan_id, &selections, &options, &import_env(&state)?)
}

#[tauri::command]
pub fn connections_scripts_info(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ScriptsInfo> {
    state.connections.scripts_info(&connection_id)
}

/// The SQL files in a connection's Scripts folder.
#[tauri::command]
pub fn connections_scripts_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<ScriptFile>> {
    state.connections.scripts_list(&connection_id)
}

/// Create an empty script in the connection's Scripts folder; returns its path.
#[tauri::command]
pub fn connections_scripts_new(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<String> {
    state.connections.scripts_create(&connection_id, &name)
}

/// Show the Scripts folder (or one file in it) in Finder / Explorer.
#[tauri::command]
pub fn connections_scripts_reveal(
    state: State<'_, AppState>,
    connection_id: String,
    rel_path: Option<String>,
) -> AppResult<()> {
    state
        .connections
        .scripts_reveal(&connection_id, rel_path.as_deref())
}

/// Rename; returns an offer to rename the Scripts folder too when it follows the name.
#[tauri::command]
pub fn connections_rename(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<Option<FolderRename>> {
    state.connections.rename(&connection_id, &name)
}

#[tauri::command]
pub fn connections_finish_folder_rename(
    state: State<'_, AppState>,
    connection_id: String,
    offer: FolderRename,
    rename_folder: bool,
) -> AppResult<()> {
    state
        .connections
        .finish_folder_rename(&connection_id, &offer, rename_folder)
}
