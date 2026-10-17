use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::chat::{self, AiEvent, ChatInput, Env};
use crate::ai::chats::{ChatSummary, StoredMessage};
use crate::ai::config::{AiSettings, ProviderConfig};
use crate::ai::context::{self, ContextInput};
use crate::ai::policy::{self, Access, ItemKind};
use crate::ai::providers::ModelInfo;
use crate::ai::{model_for, Route, TestResult};
use crate::connections::model::{Connection, Environment, Settings};
use crate::drivers::introspect::SchemaSnapshot;
use crate::drivers::Secret;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// How long a snapshot fetched for ghost-text requests is reused.
const SNAPSHOT_TTL: Duration = Duration::from_secs(30);
/// Characters of text before and after the cursor sent for a completion.
const COMPLETION_WINDOW: usize = 4_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsPayload {
    pub settings: AiSettings,
    /// Which providers have a key or token in the keychain (never the values).
    pub secrets: HashMap<String, bool>,
    pub notice: Option<String>,
}

fn payload(state: &AppState, notice: Option<String>) -> AiSettingsPayload {
    let settings = state.ai.settings();
    let secrets = settings
        .providers
        .iter()
        .map(|p| (p.id.clone(), state.ai.has_secret(&p.id)))
        .collect();
    AiSettingsPayload {
        settings,
        secrets,
        notice,
    }
}

#[tauri::command]
pub fn ai_settings_get(state: State<'_, AppState>) -> AiSettingsPayload {
    payload(&state, None)
}

#[tauri::command]
pub fn ai_settings_set(
    state: State<'_, AppState>,
    settings: AiSettings,
) -> AppResult<AiSettingsPayload> {
    state.ai.set_settings(settings)?;
    Ok(payload(&state, None))
}

/// Store a key or token. It comes in once and never goes back out.
#[tauri::command]
pub fn ai_secret_set(
    state: State<'_, AppState>,
    provider_id: String,
    secret: Secret,
) -> AppResult<()> {
    state.ai.set_secret(&provider_id, &secret)
}

#[tauri::command]
pub fn ai_secret_clear(state: State<'_, AppState>, provider_id: String) -> AppResult<()> {
    state.ai.clear_secret(&provider_id)
}

/// Models offered by a provider. `secret` is a key typed in the form and not saved yet.
#[tauri::command]
pub async fn ai_models(
    state: State<'_, AppState>,
    config: ProviderConfig,
    secret: Option<Secret>,
) -> AppResult<Vec<ModelInfo>> {
    state.ai.models(&config, secret.as_ref()).await
}

#[tauri::command]
pub async fn ai_test_provider(
    state: State<'_, AppState>,
    config: ProviderConfig,
    secret: Option<Secret>,
) -> AppResult<TestResult> {
    state.ai.test(&config, secret.as_ref()).await
}

fn hosts_and_users(c: &Connection) -> (Vec<String>, Vec<String>) {
    let mut hosts = Vec::new();
    let mut users = Vec::new();
    match &c.settings {
        Settings::Network { host, user, .. } | Settings::Oracle { host, user, .. } => {
            hosts.push(host.clone());
            users.extend(user.clone());
        }
        _ => {}
    }
    if let Some(ssh) = &c.ssh {
        hosts.push(ssh.host.clone());
        users.push(ssh.user.clone());
    }
    (hosts, users)
}

fn is_production(c: &Connection) -> bool {
    c.environment == Environment::Production
}

/// What the policy allows for a connection, so the panel can show the Production notice, refuse
/// attachments and turn itself off.
#[tauri::command]
pub fn ai_policy(state: State<'_, AppState>, connection_id: String) -> AppResult<Access> {
    let production = state
        .connections
        .get(&connection_id)
        .map(|c| is_production(&c))
        .unwrap_or(false);
    Ok(policy::access(&state.ai.settings().privacy, production))
}

async fn snapshot_of(
    state: &AppState,
    connection_id: &str,
    database: &str,
    max_age: Option<Duration>,
) -> Option<Arc<SchemaSnapshot>> {
    if let Some(age) = max_age {
        if let Some(s) = state.ai.cached_snapshot(connection_id, database, age) {
            return Some(s);
        }
    }
    let snap = state
        .sessions
        .completion_snapshot(connection_id, database)
        .await
        .ok()?;
    Some(state.ai.remember_snapshot(connection_id, database, snap))
}

/// Run one assistant request. Events stream over `on_event`; stopping returns `cancelled`.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    input: ChatInput,
    on_event: Channel<AiEvent>,
) -> AppResult<()> {
    let route = match input.feature {
        chat::Feature::Chat => Route::Chat,
        chat::Feature::Fix => Route::Fix,
        chat::Feature::NlSql => Route::NlSql,
    };
    let (cfg, provider) = state.ai.open(route, input.provider_id.as_deref())?;
    let conn = state.connections.get(&input.connection_id)?;
    let (hosts, users) = hosts_and_users(&conn);
    let settings = state.ai.settings();
    // Nothing is fetched or sent for a connection the policy switches off.
    let allowed = policy::access(&settings.privacy, is_production(&conn)).allowed;
    let snapshot = if allowed {
        snapshot_of(&state, &input.connection_id, &input.database, None).await
    } else {
        None
    };
    let token = state.ai.start(&input.request_id);
    let model = model_for(&cfg, input.model.as_deref());
    let env = Env {
        settings: &settings,
        driver: &conn.driver,
        production: is_production(&conn),
        hosts: &hosts,
        users: &users,
        snapshot: snapshot.as_deref(),
    };
    let emit = |e: AiEvent| {
        let _ = on_event.send(e);
    };
    let result = chat::run(provider.as_ref(), &model, &input, &env, &emit, token).await;
    state.ai.finish(&input.request_id);
    result.map_err(AppError::from)
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, request_id: String) -> bool {
    state.ai.cancel(&request_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteInput {
    pub request_id: String,
    pub connection_id: String,
    pub database: String,
    pub prefix: String,
    pub suffix: String,
}

/// Ghost-text suggestions at the cursor (spec: ai-inline-completion › Completion context and
/// limits). Empty when AI is off for the connection or the provider has nothing to add.
#[tauri::command]
pub async fn ai_complete(
    state: State<'_, AppState>,
    input: CompleteInput,
) -> AppResult<Vec<String>> {
    let (cfg, provider) = state.ai.open(Route::Inline, None)?;
    let conn = state.connections.get(&input.connection_id)?;
    let settings = state.ai.settings();
    let access = policy::access(&settings.privacy, is_production(&conn));
    if !access.allowed || !access.sql {
        return Ok(Vec::new());
    }
    let prefix: String = {
        let n = input.prefix.chars().count();
        input
            .prefix
            .chars()
            .skip(n.saturating_sub(COMPLETION_WINDOW))
            .collect()
    };
    let suffix: String = input.suffix.chars().take(COMPLETION_WINDOW).collect();
    let mut schema = Vec::new();
    if access.schema {
        if let Some(snap) = snapshot_of(
            &state,
            &input.connection_id,
            &input.database,
            Some(SNAPSHOT_TTL),
        )
        .await
        {
            let both = format!("{prefix}\n{suffix}");
            let (items, _) = context::build(&ContextInput {
                driver: &conn.driver,
                server_version: None,
                snapshot: Some(&snap),
                mentioned: &[],
                statement: Some(&both),
                error: None,
                rows: None,
                hosts: &[],
                users: &[],
            });
            schema = items
                .into_iter()
                .filter(|i| i.kind == ItemKind::Schema)
                .collect();
        }
    }
    let token = state.ai.start(&input.request_id);
    let model = model_for(&cfg, None);
    let result = chat::complete(
        provider.as_ref(),
        &model,
        &conn.driver,
        &prefix,
        &suffix,
        &schema,
        token,
    )
    .await;
    state.ai.finish(&input.request_id);
    result.map_err(crate::ai::provider_error)
}

#[tauri::command]
pub async fn ai_chats_list(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<Vec<ChatSummary>> {
    state.store.ai_chats_list(connection_id.as_deref()).await
}

#[tauri::command]
pub async fn ai_chat_load(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<StoredMessage>> {
    state.store.ai_chat_messages(&chat_id).await
}

/// Create a chat if needed and save one message of it.
#[tauri::command]
pub async fn ai_chat_save(
    state: State<'_, AppState>,
    chat: ChatSummary,
    message: StoredMessage,
) -> AppResult<()> {
    state.store.ai_chat_touch(&chat).await?;
    state.store.ai_message_save(&chat.id, &message).await
}

/// Delete one chat, or every chat of a connection (or all).
#[tauri::command]
pub async fn ai_chats_delete(
    state: State<'_, AppState>,
    chat_id: Option<String>,
    connection_id: Option<String>,
) -> AppResult<u64> {
    state
        .store
        .ai_chats_delete(chat_id.as_deref(), connection_id.as_deref())
        .await
}
