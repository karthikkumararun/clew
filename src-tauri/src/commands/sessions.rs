use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::drivers::nosql::{DocReply, DocRequest, KvReply, KvRequest};
use crate::drivers::{
    ExecRequest, ExecSummary, FullValueRequest, NodePath, ResolvedConfig, ResultEvent, ResultId,
    SchemaSnapshot, ServerInfo, TreeNode, Value,
};
use crate::error::AppResult;
use crate::sessions::{Emit, SessionEvent, SessionMeta, TxAction};
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
    state.sessions.connect(&connection_id, config).await?;
    state.sessions.set_policy(
        &connection_id,
        crate::safety::guard::Policy::managed(&connection_id, "", false),
    );
    Ok(())
}

#[tauri::command]
pub async fn connection_disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<()> {
    state.sessions.disconnect(&connection_id).await;
    state.editability.forget(&connection_id);
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

/// Open a dedicated session for an editor tab. `isolation` overrides the connection's default
/// isolation level (`advanced.isolation`) for this session; a level the driver lacks is ignored.
#[tauri::command]
pub async fn session_open(
    state: State<'_, AppState>,
    connection_id: String,
    isolation: Option<String>,
) -> AppResult<OpenedSession> {
    let opened = state
        .sessions
        .open_session_with(&connection_id, isolation)
        .await?;
    Ok(OpenedSession {
        session_id: opened.session_id,
        server: opened.server,
        transport: opened.transport,
    })
}

/// Close a session for good (its tab was closed). An open transaction rolls back with it.
#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    Ok(state.sessions.close_session(&session_id).await?)
}

/// Stream session changes to the Sessions panel: first `{kind:"snapshot", sessions}`, then
/// `{kind:"upsert", session}` and `{kind:"removed", id}` as sessions change.
#[tauri::command]
pub fn sessions_subscribe(state: State<'_, AppState>, on_event: Channel<SessionEvent>) {
    let (snapshot, mut rx) = state.sessions.subscribe();
    if on_event
        .send(SessionEvent::Snapshot { sessions: snapshot })
        .is_err()
    {
        return;
    }
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let event = match rx.recv().await {
                Ok(event) => event,
                // fell behind: start over from the current state
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    SessionEvent::Snapshot {
                        sessions: sessions.sessions_list(),
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
}

/// Every session with its state, timing, transaction and isolation details.
#[tauri::command]
pub fn sessions_list(state: State<'_, AppState>) -> Vec<SessionMeta> {
    state.sessions.sessions_list()
}

/// Sessions with an open (or aborted) transaction on any connection, for the quit dialog.
#[tauri::command]
pub fn sessions_open_transactions(state: State<'_, AppState>) -> Vec<SessionMeta> {
    state.sessions.sessions_open_transactions()
}

/// Label a session with its tab's name and id (the editor owns the names).
#[tauri::command]
pub fn session_set_meta(
    state: State<'_, AppState>,
    session_id: String,
    name: Option<String>,
    tab_id: Option<String>,
) -> AppResult<()> {
    Ok(state.sessions.set_session_meta(&session_id, name, tab_id)?)
}

/// Let another tab share the session (its transaction, temporary tables and settings).
#[tauri::command]
pub fn session_attach(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
) -> AppResult<()> {
    Ok(state.sessions.attach_tab(&session_id, &tab_id)?)
}

/// A tab stopped using the session; the session closes when no tab is left. Returns whether it
/// closed.
#[tauri::command]
pub async fn session_detach(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
) -> AppResult<bool> {
    Ok(state.sessions.detach_tab(&session_id, &tab_id).await?)
}

/// Commit the session's transaction (runs `COMMIT` like a typed statement).
#[tauri::command]
pub async fn session_commit(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    Ok(state.sessions.session_commit(&session_id).await?)
}

/// Roll the session's transaction back; also clears a failed (aborted) transaction.
#[tauri::command]
pub async fn session_rollback(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    Ok(state.sessions.session_rollback(&session_id).await?)
}

/// Close the session's connection but keep it for its tab, which reconnects on next use ("Close
/// session" in the panel). `tx_action` settles an open transaction first; absent, it is rolled back
/// by the server.
#[tauri::command]
pub async fn session_disconnect(
    state: State<'_, AppState>,
    session_id: String,
    tx_action: Option<TxAction>,
) -> AppResult<()> {
    Ok(state
        .sessions
        .disconnect_session(&session_id, tx_action)
        .await?)
}

/// Close every session of a connection ("Close all sessions"), keeping them for their tabs.
/// `tx_action` settles open transactions first.
#[tauri::command]
pub async fn session_close_all(
    state: State<'_, AppState>,
    connection_id: String,
    tx_action: Option<TxAction>,
) -> AppResult<()> {
    Ok(state
        .sessions
        .disconnect_sessions_of(&connection_id, tx_action)
        .await?)
}

/// Set the isolation level of the session's next transaction. Fails while a transaction is open.
#[tauri::command]
pub async fn session_set_isolation(
    state: State<'_, AppState>,
    session_id: String,
    level: String,
) -> AppResult<()> {
    Ok(state
        .sessions
        .set_session_isolation(&session_id, &level)
        .await?)
}

/// Execute a statement or script. Results stream over `on_event`; the returned summary is the
/// last statement's. Failures are emitted as events *and* returned.
#[tauri::command]
pub async fn query_execute(
    state: State<'_, AppState>,
    session_id: String,
    request: ExecRequest,
    confirmation_token: Option<String>,
    on_event: Channel<ResultEvent>,
) -> AppResult<Option<ExecSummary>> {
    Ok(state
        .sessions
        .execute_confirmed(&session_id, request, confirmation_token, emitter(on_event))
        .await?)
}

/// Ask the guard about SQL before running it: allowed, blocked (read-only) or needs a
/// confirmation (the report says what to show and carries the token that answers it).
#[tauri::command]
pub async fn safety_check(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    script: bool,
) -> AppResult<crate::sessions::GuardReport> {
    Ok(state
        .sessions
        .safety_check(&session_id, &sql, script)
        .await?)
}

/// Ask the guard about staged table edits (the statements `changes_apply` would run).
#[tauri::command]
pub async fn safety_check_changes(
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    request: crate::changes::ChangeRequest,
) -> AppResult<crate::sessions::GuardReport> {
    let driver = state.sessions.driver_id(&connection_id)?;
    let statements = crate::changes::build(&driver, &request)?;
    let text = crate::sessions::SessionManager::changes_text(&statements);
    Ok(state
        .sessions
        .safety_check(&session_id, &text, true)
        .await?)
}

/// Whether a session currently refuses writes.
#[tauri::command]
pub async fn session_read_only(state: State<'_, AppState>, session_id: String) -> AppResult<bool> {
    Ok(state.sessions.session_read_only(&session_id).await?)
}

/// Switch one session to read-write (or back to read-only). Lasts until the session closes.
#[tauri::command]
pub async fn session_set_read_only(
    state: State<'_, AppState>,
    session_id: String,
    read_only: bool,
) -> AppResult<()> {
    Ok(state
        .sessions
        .set_session_read_only(&session_id, read_only)
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

/// Run a MongoDB request. Documents stream over `on_event`; the reply says what happened.
#[tauri::command]
pub async fn doc_call(
    state: State<'_, AppState>,
    session_id: String,
    request: DocRequest,
    token: Option<String>,
    on_event: Channel<ResultEvent>,
) -> AppResult<DocReply> {
    Ok(state
        .sessions
        .doc_call(&session_id, request, token, emitter(on_event))
        .await?)
}

/// What the safeguards say about a MongoDB request, before it is sent.
#[tauri::command]
pub async fn doc_safety_check(
    state: State<'_, AppState>,
    session_id: String,
    request: DocRequest,
) -> AppResult<crate::sessions::GuardReport> {
    Ok(state
        .sessions
        .doc_safety_check(&session_id, &request)
        .await?)
}

/// Run a Redis request.
#[tauri::command]
pub async fn kv_call(
    state: State<'_, AppState>,
    session_id: String,
    request: KvRequest,
    token: Option<String>,
) -> AppResult<KvReply> {
    Ok(state.sessions.kv_call(&session_id, request, token).await?)
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
    let snapshot = state
        .sessions
        .completion_snapshot(&connection_id, &database)
        .await?;
    if let Ok(driver) = state.sessions.driver_id(&connection_id) {
        super::palette::index_snapshot(&state, &connection_id, &driver, &database, &snapshot);
    }
    Ok(snapshot)
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

/// The SQL a set of staged edits would run, values written out, for the pending bar's preview.
#[tauri::command]
pub fn changes_preview(
    state: State<'_, AppState>,
    connection_id: String,
    request: crate::changes::ChangeRequest,
) -> AppResult<Vec<crate::changes::PreviewStatement>> {
    let driver = state.sessions.driver_id(&connection_id)?;
    let statements = crate::changes::build(&driver, &request)?;
    Ok(crate::changes::preview(&statements))
}

/// Apply staged edits on the tab's session in one transaction. Statement failures come back in
/// the outcome (nothing is changed then); only infrastructure failures are errors.
#[tauri::command]
pub async fn changes_apply(
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    request: crate::changes::ChangeRequest,
    confirmation_token: Option<String>,
) -> AppResult<crate::changes::ApplyOutcome> {
    let driver = state.sessions.driver_id(&connection_id)?;
    let statements = crate::changes::build(&driver, &request)?;
    Ok(state
        .sessions
        .apply_changes_with(
            &session_id,
            &statements,
            confirmation_token,
            request.options(),
        )
        .await?)
}
