//! Graph (Neo4j) commands. Thin: the session manager guards and runs them.

use tauri::State;

use crate::drivers::graph::{GraphRequest, GraphResult, GraphSchema};
use crate::error::AppResult;
use crate::state::AppState;

/// Run Cypher in a READ or WRITE transaction and return the first batch. A statement the
/// safeguards want confirmed fails with `confirmation_required` until `confirmation_token`
/// (from `safety_check`) answers it.
#[tauri::command]
pub async fn graph_query(
    state: State<'_, AppState>,
    session_id: String,
    request: GraphRequest,
    confirmation_token: Option<String>,
) -> AppResult<GraphResult> {
    Ok(state
        .sessions
        .graph_query(&session_id, request, confirmation_token)
        .await?)
}

/// The next batch of an open result: its own records, nodes and relationships.
#[tauri::command]
pub async fn graph_fetch_more(
    state: State<'_, AppState>,
    session_id: String,
    cursor_id: String,
) -> AppResult<GraphResult> {
    Ok(state
        .sessions
        .graph_fetch_more(&session_id, &cursor_id)
        .await?)
}

/// A node's relationships and neighbours (`limit` of them, default 25), in a READ transaction.
#[tauri::command]
pub async fn graph_expand(
    state: State<'_, AppState>,
    session_id: String,
    element_id: String,
    limit: Option<u32>,
) -> AppResult<GraphResult> {
    Ok(state
        .sessions
        .graph_expand(&session_id, &element_id, limit.unwrap_or(25))
        .await?)
}

/// Labels and relationship types with counts, property keys, indexes and constraints.
#[tauri::command]
pub async fn graph_schema(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
) -> AppResult<GraphSchema> {
    Ok(state
        .sessions
        .graph_schema(&connection_id, database.as_deref())
        .await?)
}

#[tauri::command]
pub async fn graph_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<String>> {
    Ok(state.sessions.graph_databases(&connection_id).await?)
}

/// `MATCH (n) WHERE elementId(n) = $id SET n += $props`, parameterised. `kind` is `node`
/// (default) or `relationship`. A `null` property value removes the property.
#[tauri::command]
pub async fn graph_update_properties(
    state: State<'_, AppState>,
    session_id: String,
    element_id: String,
    properties: serde_json::Map<String, serde_json::Value>,
    kind: Option<String>,
    confirmation_token: Option<String>,
) -> AppResult<GraphResult> {
    Ok(state
        .sessions
        .graph_update_properties(
            &session_id,
            &element_id,
            kind.as_deref().unwrap_or("node"),
            properties,
            confirmation_token,
        )
        .await?)
}

/// What the safeguards say about a property edit, before it is sent.
#[tauri::command]
pub async fn graph_update_safety_check(
    state: State<'_, AppState>,
    session_id: String,
    kind: Option<String>,
) -> AppResult<crate::sessions::GuardReport> {
    Ok(state
        .sessions
        .graph_update_safety_check(&session_id, kind.as_deref().unwrap_or("node"))
        .await?)
}
