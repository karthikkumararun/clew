//! Chat providers. All network calls happen here, in Rust: keys never enter the WebView.

pub mod anthropic;
pub mod openai;

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use super::config::{AuthStyle, ProviderConfig, ProviderKind};

/// No bytes for this long means the stream is dead.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    /// Display name; the id when the provider has none.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema of the arguments.
    pub schema: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Msg {
    User(String),
    Assistant {
        text: String,
        calls: Vec<ToolCall>,
    },
    /// The answer to one tool call.
    ToolResult {
        call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: String,
    pub messages: Vec<Msg>,
    pub tools: Vec<ToolDef>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatEvent {
    Text(String),
    Tool(ToolCall),
    /// The model finished its turn.
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// 401 / 403.
    Auth,
    /// 404 on the model.
    NotFound,
    /// 429.
    RateLimited,
    /// 5xx or an overloaded server.
    Server,
    /// The server could not be reached.
    Unreachable,
    Cancelled,
    /// A reply that could not be understood.
    Protocol,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderError {
    pub kind: ErrorKind,
    /// Safe to show: never holds a key.
    pub message: String,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self.kind {
            ErrorKind::Auth => "ai_auth",
            ErrorKind::NotFound => "ai_model_not_found",
            ErrorKind::RateLimited => "ai_rate_limited",
            ErrorKind::Server => "ai_server",
            ErrorKind::Unreachable => "ai_unreachable",
            ErrorKind::Cancelled => "cancelled",
            ErrorKind::Protocol => "ai_protocol",
            ErrorKind::Other => "ai_error",
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[async_trait]
pub trait ChatProvider: Send + Sync {
    async fn models(&self) -> ProviderResult<Vec<ModelInfo>>;

    /// Stream one assistant turn into `tx`. Returns when the turn is over, the stream failed or
    /// `cancel` fired.
    async fn chat(
        &self,
        req: ChatRequest,
        tx: UnboundedSender<ChatEvent>,
        cancel: CancellationToken,
    ) -> ProviderResult<()>;
}

/// How a request is authenticated, with the secret already read from the keychain.
#[derive(Clone)]
pub struct Credentials {
    pub style: AuthStyle,
    pub header: String,
    pub secret: Option<String>,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("style", &self.style)
            .field("header", &self.header)
            .field("secret", &self.secret.as_ref().map(|_| "***"))
            .finish()
    }
}

/// Add the credentials and the provider's extra headers to a request.
pub fn authorize(
    mut rb: reqwest::RequestBuilder,
    creds: &Credentials,
    extra: &[(String, String)],
) -> reqwest::RequestBuilder {
    if let Some(secret) = creds.secret.as_deref().filter(|s| !s.is_empty()) {
        match creds.style {
            AuthStyle::Bearer => rb = rb.bearer_auth(secret),
            AuthStyle::Header if !creds.header.is_empty() => {
                rb = rb.header(creds.header.as_str(), secret)
            }
            _ => {}
        }
    }
    for (k, v) in extra {
        rb = rb.header(k.as_str(), v.as_str());
    }
    rb
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// What a failed HTTP status means to the user. Never includes the response body's headers.
pub fn status_error(status: reqwest::StatusCode, body: &str) -> ProviderError {
    let detail = error_message_from_body(body);
    let suffix = detail.map(|d| format!(": {d}")).unwrap_or_default();
    match status.as_u16() {
        401 => ProviderError::new(ErrorKind::Auth, "The API key was rejected (401)"),
        403 => ProviderError::new(
            ErrorKind::Auth,
            format!("The provider refused the request (403){suffix}"),
        ),
        404 => ProviderError::new(
            ErrorKind::NotFound,
            format!("The endpoint or model wasn't found (404){suffix}"),
        ),
        429 => ProviderError::new(
            ErrorKind::RateLimited,
            format!("The provider is rate limiting requests (429){suffix}"),
        ),
        500..=599 => ProviderError::new(
            ErrorKind::Server,
            format!("The provider had a problem ({}){suffix}", status.as_u16()),
        ),
        c => ProviderError::new(
            ErrorKind::Other,
            format!("The provider answered {c}{suffix}"),
        ),
    }
}

/// `error.message` of a JSON error body, if there is one.
fn error_message_from_body(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let m = v
        .pointer("/error/message")
        .or_else(|| v.get("message"))
        .and_then(|m| m.as_str())?;
    Some(m.chars().take(300).collect())
}

/// A send failure: the endpoint did not answer.
pub fn send_error(e: &reqwest::Error, base_url: &str) -> ProviderError {
    let host = url::Url::parse(base_url)
        .ok()
        .map(|u| match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => base_url.to_string(),
        })
        .unwrap_or_else(|| base_url.to_string());
    if e.is_timeout() {
        return ProviderError::new(
            ErrorKind::Unreachable,
            format!("{host} didn't answer in time"),
        );
    }
    if e.is_connect() {
        return ProviderError::new(
            ErrorKind::Unreachable,
            format!("Nothing is listening on {host}"),
        );
    }
    ProviderError::new(ErrorKind::Unreachable, format!("Couldn't reach {host}"))
}

/// Build the provider for a configuration and its secret.
pub fn build(cfg: &ProviderConfig, secret: Option<String>) -> Box<dyn ChatProvider> {
    let creds = Credentials {
        style: cfg.auth,
        header: cfg.auth_header.clone(),
        secret,
    };
    if cfg.kind.speaks_anthropic() {
        Box::new(anthropic::Anthropic::new(cfg, creds))
    } else {
        Box::new(openai::OpenAi::new(
            cfg,
            creds,
            cfg.kind == ProviderKind::Local,
        ))
    }
}
