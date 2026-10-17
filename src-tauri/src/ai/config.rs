//! AI settings: which providers are set up, what each feature uses, and what may be shared.
//! Non-secret values live in `ai.json`; API keys and tokens live only in the OS keychain.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const AI_FILE: &str = "ai.json";
pub const AI_VERSION: u32 = 1;

/// Ids of the providers that exist once each. Custom endpoints get `custom-<n>`.
pub const COPILOT_ID: &str = "copilot";
pub const ANTHROPIC_ID: &str = "anthropic";
pub const OPENAI_ID: &str = "openai";
pub const LOCAL_ID: &str = "local";

pub const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
pub const OPENAI_BASE: &str = "https://api.openai.com/v1";
pub const LOCAL_BASE: &str = "http://localhost:11434";
/// Claude's default chat model (spec: ai-providers › Model list).
pub const CLAUDE_DEFAULT_MODEL: &str = "claude-sonnet-5-5";

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Anthropic,
    Openai,
    /// A custom endpoint that speaks the OpenAI chat/completions API.
    CustomOpenai,
    /// A custom endpoint that speaks the Anthropic messages API.
    CustomAnthropic,
    Local,
}

impl ProviderKind {
    pub fn speaks_anthropic(self) -> bool {
        matches!(self, Self::Anthropic | Self::CustomAnthropic)
    }

    /// Whether a secret (API key or token) is part of the setup.
    pub fn has_secret(self) -> bool {
        !matches!(self, Self::Local)
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStyle {
    /// `Authorization: Bearer <secret>`.
    #[default]
    Bearer,
    /// `<header name>: <secret>`.
    Header,
    None,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub id: String,
    pub kind: ProviderKind,
    /// Shown in lists and the model picker.
    pub name: String,
    pub base_url: String,
    /// The chat model id as the endpoint names it.
    pub model: String,
    pub auth: AuthStyle,
    /// Header that carries the secret when `auth` is `header`.
    pub auth_header: String,
    /// Extra headers sent with every request. Not secret: they are kept in `ai.json`.
    pub extra_headers: Vec<(String, String)>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: ProviderKind::Openai,
            name: String::new(),
            base_url: String::new(),
            model: String::new(),
            auth: AuthStyle::Bearer,
            auth_header: String::new(),
            extra_headers: Vec::new(),
        }
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductionPolicy {
    /// Schema only, never row data (default).
    #[default]
    SchemaOnly,
    /// No AI at all on Production connections.
    Disabled,
    /// The same rules as other connections.
    SameAsOthers,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Privacy {
    /// Table, column and index names and types.
    pub schema: bool,
    /// The SQL in the editor and error messages.
    pub sql: bool,
    /// Rows the user attaches to a message (at most 20).
    pub rows: bool,
    pub production: ProductionPolicy,
}

impl Default for Privacy {
    fn default() -> Self {
        Self {
            schema: true,
            sql: true,
            rows: false,
            production: ProductionPolicy::SchemaOnly,
        }
    }
}

/// Which provider serves each feature. `None` is Off for inline completions and "same as chat"
/// for the two error/SQL features.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Routing {
    pub inline: Option<String>,
    pub chat: Option<String>,
    pub fix: Option<String>,
    pub nl_sql: Option<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CopilotPrefs {
    /// Offer Copilot for inline completions.
    pub inline: bool,
    /// Use Copilot for chat as well.
    pub chat: bool,
}

impl Default for CopilotPrefs {
    fn default() -> Self {
        Self {
            inline: true,
            chat: false,
        }
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub version: u32,
    /// Master switch (default off until a provider is set up).
    pub enabled: bool,
    pub providers: Vec<ProviderConfig>,
    pub routing: Routing,
    pub privacy: Privacy,
    pub copilot: CopilotPrefs,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            version: AI_VERSION,
            enabled: false,
            providers: Vec::new(),
            routing: Routing::default(),
            privacy: Privacy::default(),
            copilot: CopilotPrefs::default(),
        }
    }
}

impl AiSettings {
    pub fn provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.iter().find(|p| p.id == id)
    }

    /// Normalise what came from disk or the UI: unique ids, trimmed text, and routing that only
    /// points at providers that exist.
    pub fn sanitized(mut self) -> Self {
        self.version = AI_VERSION;
        let mut seen = std::collections::HashSet::new();
        self.providers
            .retain(|p| !p.id.trim().is_empty() && seen.insert(p.id.clone()));
        for p in &mut self.providers {
            p.name = p.name.trim().to_string();
            p.base_url = p.base_url.trim().trim_end_matches('/').to_string();
            p.model = p.model.trim().to_string();
            p.auth_header = p.auth_header.trim().to_string();
            p.extra_headers.retain(|(k, _)| !k.trim().is_empty());
        }
        let known = |id: &Option<String>, providers: &[ProviderConfig], copilot: bool| match id {
            Some(i) => (copilot && i == COPILOT_ID) || providers.iter().any(|p| &p.id == i),
            None => true,
        };
        let providers = self.providers.clone();
        if !known(&self.routing.inline, &providers, true) {
            self.routing.inline = None;
        }
        for r in [
            &mut self.routing.chat,
            &mut self.routing.fix,
            &mut self.routing.nl_sql,
        ] {
            if !known(r, &providers, true) {
                *r = None;
            }
        }
        self
    }
}

/// `http://` to anything but this machine sends a token unencrypted.
pub fn is_plain_http_remote(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "http" {
        return false;
    }
    !matches!(
        u.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
    )
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug)]
pub struct LoadOutcome {
    pub settings: AiSettings,
    /// Set when the file could not be parsed: where the bad file was moved to.
    pub backup: Option<PathBuf>,
}

/// Read `ai.json`. A missing file yields defaults (AI off); an unreadable one is moved aside.
pub fn load(dir: &Path) -> LoadOutcome {
    let path = dir.join(AI_FILE);
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<AiSettings>(&text) {
            Ok(s) => LoadOutcome {
                settings: s.sanitized(),
                backup: None,
            },
            Err(_) => recover(dir, &path),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LoadOutcome {
            settings: AiSettings::default(),
            backup: None,
        },
        Err(_) => recover(dir, &path),
    }
}

fn recover(dir: &Path, path: &Path) -> LoadOutcome {
    let backup = dir.join(format!("{AI_FILE}.corrupt-{}", timestamp()));
    let backup = fs::rename(path, &backup).ok().map(|_| backup);
    LoadOutcome {
        settings: AiSettings::default(),
        backup,
    }
}

/// Write atomically (temp file + rename).
pub fn save(dir: &Path, settings: &AiSettings) -> AppResult<()> {
    let io = |e: std::io::Error| {
        AppError::new("ai_settings_io", "Could not save the AI settings").with_detail(e.to_string())
    };
    fs::create_dir_all(dir).map_err(io)?;
    let json = serde_json::to_string_pretty(&settings.clone().sanitized()).map_err(|e| {
        AppError::new("ai_settings_serialize", "Could not save the AI settings")
            .with_detail(e.to_string())
    })?;
    let tmp = dir.join(format!("{AI_FILE}.tmp"));
    fs::write(&tmp, json).map_err(io)?;
    fs::rename(&tmp, dir.join(AI_FILE)).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str) -> ProviderConfig {
        ProviderConfig {
            id: id.into(),
            kind: ProviderKind::Anthropic,
            name: " Claude ".into(),
            base_url: "https://api.anthropic.com/".into(),
            model: CLAUDE_DEFAULT_MODEL.into(),
            ..Default::default()
        }
    }

    /// (spec: ai-providers › Fresh install)
    #[test]
    fn a_fresh_install_has_ai_off_and_nothing_set_up() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(dir.path()).settings;
        assert!(!s.enabled);
        assert!(s.providers.is_empty());
        assert_eq!(s.privacy, Privacy::default());
        assert!(s.privacy.schema && s.privacy.sql && !s.privacy.rows);
        assert_eq!(s.privacy.production, ProductionPolicy::SchemaOnly);
        assert!(!dir.path().join(AI_FILE).exists(), "loading writes nothing");
    }

    #[test]
    fn round_trips_and_trims() {
        let dir = tempfile::tempdir().unwrap();
        let s = AiSettings {
            enabled: true,
            providers: vec![provider("anthropic")],
            ..Default::default()
        };
        save(dir.path(), &s).unwrap();
        let back = load(dir.path()).settings;
        assert_eq!(back.providers[0].name, "Claude");
        assert_eq!(back.providers[0].base_url, "https://api.anthropic.com");
        assert!(back.enabled);
    }

    /// (spec: ai-providers › Provider removed)
    #[test]
    fn routing_to_a_removed_provider_falls_back() {
        let s = AiSettings {
            providers: vec![provider("anthropic")],
            routing: Routing {
                inline: Some("copilot".into()),
                chat: Some("gone".into()),
                fix: Some("anthropic".into()),
                nl_sql: None,
            },
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.routing.inline.as_deref(), Some("copilot"));
        assert_eq!(s.routing.chat, None);
        assert_eq!(s.routing.fix.as_deref(), Some("anthropic"));
    }

    #[test]
    fn duplicate_and_blank_ids_are_dropped() {
        let s = AiSettings {
            providers: vec![provider("a"), provider("a"), provider("  ")],
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.providers.len(), 1);
    }

    #[test]
    fn a_corrupt_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(AI_FILE), "{ nope").unwrap();
        let out = load(dir.path());
        assert!(!out.settings.enabled);
        assert!(out.backup.is_some());
    }

    /// (spec: ai-providers › Plain HTTP)
    #[test]
    fn plain_http_is_flagged_unless_it_is_this_machine() {
        assert!(is_plain_http_remote("http://llm.internal.example.com/v1"));
        assert!(!is_plain_http_remote("https://llm.internal.example.com/v1"));
        assert!(!is_plain_http_remote("http://localhost:11434"));
        assert!(!is_plain_http_remote("http://127.0.0.1:1234/v1"));
        assert!(!is_plain_http_remote("not a url"));
    }
}
