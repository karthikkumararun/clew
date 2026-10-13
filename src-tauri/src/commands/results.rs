//! Commands behind editable query results: which table a result edits, and reading rows back.

use tauri::State;

use crate::drivers::{ColumnMeta, Value};
use crate::editability::{EditResolution, TableRef};
use crate::error::AppResult;
use crate::state::AppState;

/// Can the result of `statement` be edited, and through which table? `chosen` is the table the
/// user picked in a joined result (the first available table in `FROM` order when absent). The
/// answer is an edit plan or the specific reason the result is read-only.
#[tauri::command]
pub async fn results_resolve_edit(
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    statement: String,
    columns: Vec<ColumnMeta>,
    chosen: Option<TableRef>,
) -> AppResult<EditResolution> {
    Ok(crate::editability::resolve_edit(
        &state.sessions,
        &state.editability,
        &connection_id,
        &session_id,
        &statement,
        &columns,
        chosen.as_ref(),
    )
    .await?)
}

/// Read rows back by key after a submit, on the console's own session. One entry per key, in the
/// order of `keys`: the values of `columns`, or an empty list when the row no longer exists.
#[tauri::command]
pub async fn changes_refetch(
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    target: TableRef,
    columns: Vec<String>,
    key_columns: Vec<String>,
    keys: Vec<Vec<Value>>,
) -> AppResult<Vec<Vec<Value>>> {
    let driver = state.sessions.driver_id(&connection_id)?;
    crate::changes::refetch(
        &state.sessions,
        &driver,
        &session_id,
        &target,
        &columns,
        &key_columns,
        &keys,
    )
    .await
}
