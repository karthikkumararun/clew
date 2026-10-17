//! The AI assistant's backend: providers, the data-sharing policy, context assembly and the chat
//! loop. Every network call happens here, in Rust, to an endpoint the user configured.

pub mod chat;
pub mod chats;
pub mod config;
pub mod context;
pub mod copilot;
pub mod policy;
pub mod providers;
pub mod sse;
pub mod tools;

#[cfg(test)]
mod test_server;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tokio::sync::mpsc::unbounded_channel;
use tokio_util::sync::CancellationToken;

use crate::connections::secrets::{SecretError, SecretKind, SecretStore};
use crate::drivers::introspect::SchemaSnapshot;
use crate::drivers::Secret;
use crate::error::{AppError, AppResult};
use config::{AiSettings, AuthStyle, ProviderConfig, ProviderKind, COPILOT_ID};
use providers::{ChatEvent, ChatProvider, ChatRequest, ModelInfo, Msg, ProviderError};

/// Which feature asks for a provider (spec: ai-providers › Feature routing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Chat,
    Fix,
    NlSql,
    Inline,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    #[ts(type = "number")]
    pub millis: u64,
    /// "Reachable · model responded in 640 ms".
    pub message: String,
}

/// (connection id, database)
type SnapshotKey = (String, String);

pub struct AiService {
    data_dir: PathBuf,
    secrets: Arc<dyn SecretStore>,
    settings: Mutex<AiSettings>,
    running: Mutex<HashMap<String, CancellationToken>>,
    /// Recent schema snapshots, so ghost text doesn't query the database on every pause.
    snapshots: Mutex<HashMap<SnapshotKey, (Instant, Arc<SchemaSnapshot>)>>,
}

impl std::fmt::Debug for AiService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AiService")
    }
}

fn secret_err(e: SecretError) -> AppError {
    match e {
        SecretError::TooLarge => {
            AppError::new("ai_secret_too_large", "That key is too long to store")
        }
        SecretError::Unavailable(detail) => AppError::new(
            "keychain_unavailable",
            "The system keychain isn't available, so the key couldn't be saved or read",
        )
        .with_detail(detail),
    }
}

/// The keychain account of a provider's secret is `ai:<provider id>:ai-key`.
fn secret_owner(provider_id: &str) -> String {
    format!("ai:{provider_id}")
}

impl AiService {
    /// Load `ai.json`. The second value is the backup path when the file was unreadable.
    pub fn new(data_dir: PathBuf, secrets: Arc<dyn SecretStore>) -> (Self, Option<PathBuf>) {
        let loaded = config::load(&data_dir);
        (
            Self {
                data_dir,
                secrets,
                settings: Mutex::new(loaded.settings),
                running: Mutex::new(HashMap::new()),
                snapshots: Mutex::new(HashMap::new()),
            },
            loaded.backup,
        )
    }

    pub fn settings(&self) -> AiSettings {
        self.settings.lock().unwrap().clone()
    }

    /// Save settings; the secrets of providers that were removed are deleted from the keychain.
    pub fn set_settings(&self, next: AiSettings) -> AppResult<AiSettings> {
        let next = next.sanitized();
        config::save(&self.data_dir, &next)?;
        let removed: Vec<String> = {
            let mut cur = self.settings.lock().unwrap();
            let gone = cur
                .providers
                .iter()
                .filter(|p| next.provider(&p.id).is_none())
                .map(|p| p.id.clone())
                .collect();
            *cur = next.clone();
            gone
        };
        for id in removed {
            let _ = self.secrets.delete(&secret_owner(&id), SecretKind::AiKey);
        }
        Ok(next)
    }

    pub fn has_secret(&self, provider_id: &str) -> bool {
        matches!(
            self.secrets
                .get(&secret_owner(provider_id), SecretKind::AiKey),
            Ok(Some(_))
        )
    }

    pub fn set_secret(&self, provider_id: &str, secret: &Secret) -> AppResult<()> {
        self.secrets
            .set(&secret_owner(provider_id), SecretKind::AiKey, secret)
            .map_err(secret_err)
    }

    pub fn clear_secret(&self, provider_id: &str) -> AppResult<()> {
        self.secrets
            .delete(&secret_owner(provider_id), SecretKind::AiKey)
            .map_err(secret_err)
    }

    fn secret(&self, provider_id: &str) -> AppResult<Option<String>> {
        Ok(self
            .secrets
            .get(&secret_owner(provider_id), SecretKind::AiKey)
            .map_err(secret_err)?
            .map(|s| s.expose().to_string()))
    }

    /// Whether a provider can be used: it has the secret its kind needs.
    pub fn is_configured(&self, cfg: &ProviderConfig) -> bool {
        if !cfg.kind.has_secret() || cfg.auth == AuthStyle::None {
            return !cfg.base_url.is_empty();
        }
        self.has_secret(&cfg.id)
    }

    /// The provider that serves `route`, or the one explicitly picked.
    pub fn resolve(&self, route: Route, explicit: Option<&str>) -> AppResult<ProviderConfig> {
        let settings = self.settings();
        let pick = explicit.map(str::to_string).or_else(|| match route {
            Route::Chat => settings.routing.chat.clone(),
            Route::Fix => settings
                .routing
                .fix
                .clone()
                .or(settings.routing.chat.clone()),
            Route::NlSql => settings
                .routing
                .nl_sql
                .clone()
                .or(settings.routing.chat.clone()),
            Route::Inline => settings.routing.inline.clone(),
        });
        let none = || AppError::new("ai_no_provider", "Connect a model to start");
        let cfg = match pick {
            Some(id) if id == COPILOT_ID => {
                return Err(AppError::new(
                    "ai_copilot_unavailable",
                    "GitHub Copilot isn't available for this feature yet",
                ))
            }
            Some(id) => settings.provider(&id).cloned().ok_or_else(none)?,
            None if route == Route::Inline => return Err(none()),
            None => settings
                .providers
                .iter()
                .find(|p| self.is_configured(p))
                .cloned()
                .ok_or_else(none)?,
        };
        if !self.is_configured(&cfg) {
            return Err(none());
        }
        Ok(cfg)
    }

    /// Chat is refused until AI is switched on (spec: ai-providers › Fresh install): nothing is
    /// sent anywhere before then.
    pub fn ensure_enabled(&self) -> AppResult<()> {
        if self.settings().enabled {
            Ok(())
        } else {
            Err(AppError::new(
                "ai_disabled",
                "AI features are turned off in Settings › AI assistant",
            ))
        }
    }

    /// The provider for a feature, ready to use. This is the only way a request reaches the
    /// network on the user's behalf, so it is where "nothing is sent until AI is on and a provider
    /// is set up" (spec: ai-providers › Fresh install) is enforced.
    pub fn open(
        &self,
        route: Route,
        explicit: Option<&str>,
    ) -> AppResult<(ProviderConfig, Box<dyn ChatProvider>)> {
        self.ensure_enabled()?;
        let cfg = self.resolve(route, explicit)?;
        let provider = self.provider(&cfg, None)?;
        Ok((cfg, provider))
    }

    /// A provider for a configuration. `secret` overrides the stored one (for Test connection
    /// before Save).
    pub fn provider(
        &self,
        cfg: &ProviderConfig,
        secret: Option<&Secret>,
    ) -> AppResult<Box<dyn ChatProvider>> {
        let secret = match secret {
            Some(s) => Some(s.expose().to_string()),
            None if cfg.kind.has_secret() => self.secret(&cfg.id)?,
            None => None,
        };
        Ok(providers::build(cfg, secret))
    }

    pub async fn models(
        &self,
        cfg: &ProviderConfig,
        secret: Option<&Secret>,
    ) -> AppResult<Vec<ModelInfo>> {
        self.provider(cfg, secret)?
            .models()
            .await
            .map_err(provider_error)
    }

    /// A minimal request that proves the endpoint, the key and the model work.
    pub async fn test(
        &self,
        cfg: &ProviderConfig,
        secret: Option<&Secret>,
    ) -> AppResult<TestResult> {
        let provider = self.provider(cfg, secret)?;
        let model = if cfg.model.is_empty() {
            // Without a model, listing models is the best proof the endpoint and key work.
            let started = Instant::now();
            provider.models().await.map_err(provider_error)?;
            return Ok(TestResult {
                ok: true,
                millis: started.elapsed().as_millis() as u64,
                message: format!(
                    "Reachable · answered in {} ms",
                    started.elapsed().as_millis()
                ),
            });
        } else {
            cfg.model.clone()
        };
        let req = ChatRequest {
            model,
            system: String::new(),
            messages: vec![Msg::User("Reply with the single word OK.".into())],
            tools: Vec::new(),
            max_tokens: 16,
            temperature: Some(0.0),
        };
        let (tx, mut rx) = unbounded_channel();
        let started = Instant::now();
        let cancel = CancellationToken::new();
        let timeout = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            provider.chat(req, tx, cancel.clone()),
        )
        .await;
        cancel.cancel();
        match timeout {
            Err(_) => {
                return Err(AppError::new(
                    "ai_unreachable",
                    "The endpoint didn't answer within 30 seconds",
                ))
            }
            Ok(r) => r.map_err(provider_error)?,
        }
        let mut got = false;
        while let Ok(ev) = rx.try_recv() {
            got |= matches!(ev, ChatEvent::Text(_) | ChatEvent::Done);
        }
        if !got {
            return Err(AppError::new(
                "ai_protocol",
                "The endpoint answered with nothing",
            ));
        }
        let ms = started.elapsed().as_millis() as u64;
        Ok(TestResult {
            ok: true,
            millis: ms,
            message: format!("Reachable · model responded in {ms} ms"),
        })
    }

    pub fn cached_snapshot(
        &self,
        connection_id: &str,
        database: &str,
        max_age: std::time::Duration,
    ) -> Option<Arc<SchemaSnapshot>> {
        let map = self.snapshots.lock().unwrap();
        let (at, snap) = map.get(&(connection_id.to_string(), database.to_string()))?;
        (at.elapsed() <= max_age).then(|| snap.clone())
    }

    pub fn remember_snapshot(
        &self,
        connection_id: &str,
        database: &str,
        snapshot: SchemaSnapshot,
    ) -> Arc<SchemaSnapshot> {
        let snap = Arc::new(snapshot);
        self.snapshots.lock().unwrap().insert(
            (connection_id.to_string(), database.to_string()),
            (Instant::now(), snap.clone()),
        );
        snap
    }

    /// Register a running request so `cancel` can stop it.
    pub fn start(&self, request_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.running
            .lock()
            .unwrap()
            .insert(request_id.to_string(), token.clone());
        token
    }

    pub fn finish(&self, request_id: &str) {
        self.running.lock().unwrap().remove(request_id);
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        match self.running.lock().unwrap().get(request_id) {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }
}

pub fn provider_error(e: ProviderError) -> AppError {
    AppError::new(e.code(), e.message)
}

impl From<chat::ChatError> for AppError {
    fn from(e: chat::ChatError) -> Self {
        AppError::new(e.code, e.message)
    }
}

/// The model to use for a request: an explicit pick, else the provider's configured model.
pub fn model_for(cfg: &ProviderConfig, explicit: Option<&str>) -> String {
    match explicit.filter(|m| !m.is_empty()) {
        Some(m) => m.to_string(),
        None if !cfg.model.is_empty() => cfg.model.clone(),
        None if cfg.kind == ProviderKind::Anthropic => config::CLAUDE_DEFAULT_MODEL.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests;
