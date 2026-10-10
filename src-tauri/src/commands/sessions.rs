use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::drivers::{
    ExecRequest, ExecSummary, FullValueRequest, NodePath, ResolvedConfig, ResultEvent, ResultId,
    SchemaSnapshot, ServerInfo, TreeNode, Value,
};
use crate::error::AppResult;
use crate::sessions::Emit;
use crate::state::AppState;

fn emitter(channel: Channel<ResultEvent>) -> Emit {
    Arc::new(move |event| channel.send(event).is_ok())
}

/// Connect, run a trivial round-trip and report the server. Saves nothing.
#[tauri::command]
pub async fn connection_test(
    state: State<'_, AppState>,
    config: ResolvedConfig,
) -> AppResult<ServerInfo> {
    Ok(state.sessions.test_connection(&config).await?)
}

/// Register a connection and open its metadata pool.
#[tauri::command]
pub async fn connection_connect(
    state: State<'_, AppState>,
    connection_id: String,
    config: ResolvedConfig,
) -> AppResult<()> {
    Ok(state.sessions.connect(&connection_id, config).await?)
}

#[tauri::command]
pub async fn connection_disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<()> {
    state.sessions.disconnect(&connection_id).await;
    Ok(())
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    pub session_id: String,
    pub server: ServerInfo,
    /// `via SSH <host>` when tunnelled.
    pub transport: Option<String>,
}

#[tauri::command]
pub async fn session_open(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<OpenedSession> {
    let opened = state.sessions.open_session(&connection_id).await?;
    Ok(OpenedSession {
        session_id: opened.session_id,
        server: opened.server,
        transport: opened.transport,
    })
}

#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    Ok(state.sessions.close_session(&session_id).await?)
}

/// Execute a statement or script. Results stream over `on_event`; the returned summary is the
/// last statement's. Failures are emitted as events *and* returned.
#[tauri::command]
pub async fn query_execute(
    state: State<'_, AppState>,
    session_id: String,
    request: ExecRequest,
    on_event: Channel<ResultEvent>,
) -> AppResult<Option<ExecSummary>> {
    Ok(state
        .sessions
        .execute(&session_id, request, emitter(on_event))
        .await?)
}

/// Pull more rows of an open result. Returns whether more remain.
#[tauri::command]
pub async fn query_fetch_more(
    state: State<'_, AppState>,
    session_id: String,
    result_id: ResultId,
    count: usize,
    on_event: Channel<ResultEvent>,
) -> AppResult<bool> {
    Ok(state
        .sessions
        .fetch_more(&session_id, result_id, count, emitter(on_event))
        .await?)
}

#[tauri::command]
pub async fn query_cancel(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    Ok(state.sessions.cancel(&session_id).await?)
}

/// The untruncated value of one cell (for values the grid received with `truncated: true`).
#[tauri::command]
pub async fn value_fetch_full(
    state: State<'_, AppState>,
    session_id: String,
    request: FullValueRequest,
) -> AppResult<Value> {
    Ok(state
        .sessions
        .fetch_full_value(&session_id, request)
        .await?)
}

#[tauri::command]
pub async fn introspect_children(
    state: State<'_, AppState>,
    connection_id: String,
    path: NodePath,
) -> AppResult<Vec<TreeNode>> {
    Ok(state.sessions.introspect(&connection_id, &path).await?)
}

/// The `CREATE` statement of a table, view, routine or trigger.
#[tauri::command]
pub async fn introspect_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    path: NodePath,
) -> AppResult<String> {
    Ok(state.sessions.ddl(&connection_id, &path).await?)
}

/// The SELECT (and count) behind a table's Data view, for the connection's dialect.
#[tauri::command]
pub fn table_query_sql(
    state: State<'_, AppState>,
    connection_id: String,
    request: crate::table_query::TableQueryRequest,
) -> AppResult<crate::table_query::TableQuery> {
    let driver = state.sessions.driver_id(&connection_id)?;
    Ok(crate::table_query::build(&driver, &request))
}

/// Structure, indexes, foreign keys and statistics of a table.
#[tauri::command]
pub async fn table_meta(
    state: State<'_, AppState>,
    connection_id: String,
    path: NodePath,
) -> AppResult<crate::drivers::table_meta::TableMeta> {
    Ok(state.sessions.table_meta(&connection_id, &path).await?)
}

/// Exact `SELECT count(*)` of a table or view, to replace the explorer's estimate.
#[tauri::command]
pub async fn explorer_count_rows(
    state: State<'_, AppState>,
    connection_id: String,
    path: NodePath,
) -> AppResult<i64> {
    Ok(state.sessions.count_rows(&connection_id, &path).await?)
}

#[tauri::command]
pub async fn completion_snapshot(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<SchemaSnapshot> {
    Ok(state
        .sessions
        .completion_snapshot(&connection_id, &database)
        .await?)
}

/// The user's answer to a `host_key_prompt` event.
#[tauri::command]
pub fn host_key_answer(state: State<'_, AppState>, prompt_id: String, accept: bool) -> bool {
    state.host_key_prompts.answer(&prompt_id, accept)
}

/// Make a database / schema the session's default (the toolbar chip menu). Returns the
/// statement that was run.
#[tauri::command]
pub async fn session_switch_namespace(
    state: State<'_, AppState>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
) -> AppResult<String> {
    Ok(state
        .sessions
        .switch_namespace(&session_id, database.as_deref(), schema.as_deref())
        .await?)
}

/// A connection's executed statements, newest first. `query` filters by a substring of the text;
/// `before` is the cursor returned with the previous page.
#[tauri::command]
pub async fn history_list(
    state: State<'_, AppState>,
    connection_id: String,
    query: Option<String>,
    before: Option<i64>,
) -> AppResult<crate::history::HistoryPage> {
    state
        .store
        .history_list(
            &connection_id,
            query.as_deref(),
            before,
            crate::history::PAGE_SIZE,
        )
        .await
}

/// Delete one connection's history, or all of it when `connection_id` is empty. Returns how
/// many entries were deleted.
#[tauri::command]
pub async fn history_clear(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<u64> {
    state.store.history_clear(connection_id.as_deref()).await
}
