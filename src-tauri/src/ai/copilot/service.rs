//! GitHub Copilot through GitHub's language server (spec: ai-providers › GitHub Copilot sign-in).
//! Clew downloads the component after consent, runs it over stdio and drives GitHub's device
//! flow with it; the user's password never passes through Clew. Inline completions come from the
//! same server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

use super::install::{self, InstallError};
use super::rpc::{Handler, RpcClient, RpcError};

/// How long a device code lives (GitHub's default is 15 minutes).
pub const CODE_LIFETIME: Duration = Duration::from_secs(15 * 60);
/// GitHub's page for entering the code.
pub const VERIFICATION_URI: &str = "https://github.com/login/device";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum CopilotState {
    /// Not signed in (or never set up).
    Out,
    /// The component must be downloaded first; waiting for the user to agree.
    #[serde(rename_all = "camelCase")]
    Consent {
        version: String,
        /// Bytes to download, when the registry says.
        #[ts(type = "number | null")]
        download_bytes: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Downloading {
        #[ts(type = "number")]
        percent: u8,
    },
    /// The component is starting.
    Starting,
    /// Waiting for the user to enter the code on github.com.
    #[serde(rename_all = "camelCase")]
    Pending {
        user_code: String,
        verification_uri: String,
        /// Milliseconds since the epoch.
        #[ts(type = "number")]
        expires_at_ms: i64,
    },
    #[serde(rename_all = "camelCase")]
    In { login: String },
    /// The GitHub account has no Copilot access.
    NoAccess,
    /// The code expired before it was used.
    Expired,
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// Starts the language server. Tests substitute an in-memory one.
#[async_trait]
pub trait Launcher: Send + Sync {
    async fn launch(&self, binary: &Path) -> std::io::Result<Launched>;
}

pub struct Launched {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// Called to stop the server.
    pub stop: Box<dyn FnOnce() + Send>,
}

pub struct ProcessLauncher;

#[async_trait]
impl Launcher for ProcessLauncher {
    async fn launch(&self, binary: &Path) -> std::io::Result<Launched> {
        let mut child = tokio::process::Command::new(binary)
            .arg("--stdio")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let reader = child.stdout.take().expect("piped stdout");
        let writer = child.stdin.take().expect("piped stdin");
        Ok(Launched {
            reader: Box::new(reader),
            writer: Box::new(writer),
            stop: Box::new(move || {
                let _ = child.start_kill();
            }),
        })
    }
}

/// What the server tells the client about itself.
struct ServerHandler;

impl Handler for ServerHandler {
    fn request(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            // One answer per requested item; Clew has no editor settings to give.
            "workspace/configuration" => Ok(Value::Array(
                params["items"]
                    .as_array()
                    .map(|a| a.iter().map(|_| Value::Null).collect())
                    .unwrap_or_default(),
            )),
            "client/registerCapability"
            | "client/unregisterCapability"
            | "window/workDoneProgress/create"
            | "window/showMessageRequest" => Ok(Value::Null),
            // The sign-in page is opened by the user from the settings page, not by the server.
            "window/showDocument" => Ok(json!({ "success": false })),
            _ => Err(RpcError {
                code: RpcError::METHOD_NOT_FOUND,
                message: format!("Method not found: {method}"),
            }),
        }
    }

    fn notification(&self, _method: &str, _params: &Value) {}
}

type Emit = Arc<dyn Fn(&CopilotState) + Send + Sync>;

struct Running {
    client: Arc<RpcClient>,
    stop: Option<Box<dyn FnOnce() + Send>>,
}

pub struct CopilotService {
    data_dir: PathBuf,
    version: String,
    platform: Option<&'static str>,
    registry: String,
    http: reqwest::Client,
    launcher: Arc<dyn Launcher>,
    emit: Emit,
    state: Mutex<CopilotState>,
    running: tokio::sync::Mutex<Option<Running>>,
    /// Bumped by every sign-in attempt and by cancel, so a late answer to an old one is ignored.
    attempt: AtomicU64,
    install_cancel: Mutex<Option<CancellationToken>>,
    /// Documents the server has been told about, with their versions.
    docs: Mutex<HashMap<String, i64>>,
}

impl std::fmt::Debug for CopilotService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CopilotService")
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// UTF-16 position of the end of `prefix`, as LSP counts it.
pub fn utf16_position(prefix: &str) -> (u32, u32) {
    let line = prefix.matches('\n').count() as u32;
    let last = prefix.rsplit('\n').next().unwrap_or("");
    (line, last.encode_utf16().count() as u32)
}

impl CopilotService {
    pub fn new(data_dir: PathBuf, emit: Emit) -> Arc<Self> {
        Self::with(
            data_dir,
            install::VERSION.to_string(),
            install::platform(),
            install::REGISTRY.to_string(),
            Arc::new(ProcessLauncher),
            emit,
        )
    }

    pub fn with(
        data_dir: PathBuf,
        version: String,
        platform: Option<&'static str>,
        registry: String,
        launcher: Arc<dyn Launcher>,
        emit: Emit,
    ) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            version,
            platform,
            registry,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            launcher,
            emit,
            state: Mutex::new(CopilotState::Out),
            running: tokio::sync::Mutex::new(None),
            attempt: AtomicU64::new(0),
            install_cancel: Mutex::new(None),
            docs: Mutex::new(HashMap::new()),
        })
    }

    pub fn state(&self) -> CopilotState {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, next: CopilotState) {
        let changed = {
            let mut s = self.state.lock().unwrap();
            let changed = *s != next;
            *s = next.clone();
            changed
        };
        if changed {
            (self.emit)(&next);
        }
    }

    fn binary(&self) -> Option<PathBuf> {
        install::installed(&self.data_dir, &self.version)
    }

    /// Start the server if needed and answer `initialize`.
    async fn ensure_running(&self) -> Result<Arc<RpcClient>, String> {
        let mut running = self.running.lock().await;
        if let Some(r) = running.as_ref() {
            if !r.client.is_closed() {
                return Ok(r.client.clone());
            }
        }
        if let Some(Running {
            stop: Some(stop), ..
        }) = running.take()
        {
            stop();
        }
        self.docs.lock().unwrap().clear();
        let binary = self
            .binary()
            .ok_or_else(|| "The Copilot component isn't installed".to_string())?;
        let launched = self
            .launcher
            .launch(&binary)
            .await
            .map_err(|e| format!("Couldn't start the Copilot component: {e}"))?;
        let client = RpcClient::new(launched.reader, launched.writer, Arc::new(ServerHandler));
        let version = env!("CARGO_PKG_VERSION");
        let init = tokio::time::timeout(
            REQUEST_TIMEOUT,
            client.request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "clientInfo": { "name": "Clew", "version": version },
                    "workspaceFolders": [],
                    "capabilities": {
                        "workspace": { "workspaceFolders": true, "configuration": true },
                        "window": { "showDocument": { "support": false } },
                    },
                    "initializationOptions": {
                        "editorInfo": { "name": "Clew", "version": version },
                        "editorPluginInfo": { "name": "Clew", "version": version },
                    },
                }),
            ),
        )
        .await;
        if !matches!(init, Ok(Ok(_))) {
            (launched.stop)();
            return Err("The Copilot component didn't start".into());
        }
        client.notify("initialized", json!({})).await;
        // No telemetry from Clew's side of the server either.
        client
            .notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": { "telemetry": { "telemetryLevel": "off" } } }),
            )
            .await;
        *running = Some(Running {
            client: client.clone(),
            stop: Some(launched.stop),
        });
        Ok(client)
    }

    async fn stop_server(&self) {
        let mut running = self.running.lock().await;
        if let Some(Running {
            stop: Some(stop), ..
        }) = running.take()
        {
            stop();
        }
        self.docs.lock().unwrap().clear();
    }

    /// Read the sign-in state without asking the user for anything: used at start-up and by
    /// "Check now". Starts the server when the component is installed.
    pub async fn refresh(&self) {
        if self.binary().is_none() {
            if matches!(
                self.state(),
                CopilotState::Starting | CopilotState::In { .. }
            ) {
                self.set(CopilotState::Out);
            }
            return;
        }
        // Don't disturb an attempt that is in progress.
        if matches!(
            self.state(),
            CopilotState::Pending { .. }
                | CopilotState::Downloading { .. }
                | CopilotState::Consent { .. }
        ) {
            if let CopilotState::Pending { .. } = self.state() {
                self.check_now().await;
            }
            return;
        }
        if matches!(self.state(), CopilotState::Out) {
            self.set(CopilotState::Starting);
        }
        match self.ensure_running().await {
            Ok(_) => self.check_status().await,
            Err(m) => self.set(CopilotState::Error { message: m }),
        }
    }

    /// Ask the server who is signed in and apply the answer.
    async fn check_status(&self) {
        let Ok(client) = self.ensure_running().await else {
            return;
        };
        let reply =
            tokio::time::timeout(REQUEST_TIMEOUT, client.request("checkStatus", json!({}))).await;
        match reply {
            Ok(Ok(v)) => {
                if let Some(next) = status_from(&v) {
                    // "Not signed in" while a code is waiting just means "not yet".
                    if !(matches!(next, CopilotState::Out)
                        && matches!(self.state(), CopilotState::Pending { .. }))
                    {
                        self.set(next);
                    }
                }
            }
            // An older or newer server without this request: the sign-in flow decides.
            Ok(Err(e)) if e.code == RpcError::METHOD_NOT_FOUND => {
                if matches!(self.state(), CopilotState::Starting) {
                    self.set(CopilotState::Out);
                }
            }
            _ => {
                if matches!(self.state(), CopilotState::Starting) {
                    self.set(CopilotState::Out);
                }
            }
        }
    }

    pub async fn check_now(&self) {
        self.check_status().await;
    }

    /// The user pressed "Sign in with GitHub". Without the component this asks for consent.
    pub async fn begin(self: &Arc<Self>) {
        let Some(platform) = self.platform else {
            self.set(CopilotState::Error {
                message: InstallError::Unsupported.to_string(),
            });
            return;
        };
        if self.binary().is_some() {
            self.start_sign_in().await;
            return;
        }
        match install::lookup(&self.http, &self.registry, platform, &self.version).await {
            Ok(release) => self.set(CopilotState::Consent {
                version: self.version.clone(),
                download_bytes: release.download_bytes,
            }),
            Err(e) => self.set(CopilotState::Error {
                message: e.to_string(),
            }),
        }
    }

    /// The user agreed to download the component.
    pub async fn accept_consent(self: &Arc<Self>) {
        let Some(platform) = self.platform else {
            return;
        };
        if !matches!(self.state(), CopilotState::Consent { .. }) {
            return;
        }
        self.set(CopilotState::Downloading { percent: 0 });
        let cancel = CancellationToken::new();
        *self.install_cancel.lock().unwrap() = Some(cancel.clone());
        let result = async {
            let release =
                install::lookup(&self.http, &self.registry, platform, &self.version).await?;
            let me = self.clone();
            let last = Mutex::new(0u8);
            install::install(
                &self.http,
                &release,
                &install::install_dir(&self.data_dir, &self.version),
                &move |done, total| {
                    if let Some(total) = total.filter(|t| *t > 0) {
                        let pct = ((done * 100) / total).min(100) as u8;
                        let mut l = last.lock().unwrap();
                        if pct != *l {
                            *l = pct;
                            me.set(CopilotState::Downloading { percent: pct });
                        }
                    }
                },
                &cancel,
            )
            .await
        }
        .await;
        *self.install_cancel.lock().unwrap() = None;
        match result {
            Ok(_) => self.start_sign_in().await,
            Err(InstallError::Cancelled) => self.set(CopilotState::Out),
            Err(e) => self.set(CopilotState::Error {
                message: e.to_string(),
            }),
        }
    }

    /// The user declined the download, or pressed Cancel during it.
    pub async fn decline_consent(&self) {
        if let Some(c) = self.install_cancel.lock().unwrap().as_ref() {
            c.cancel();
        }
        if matches!(
            self.state(),
            CopilotState::Consent { .. } | CopilotState::Downloading { .. }
        ) {
            self.set(CopilotState::Out);
        }
    }

    async fn start_sign_in(self: &Arc<Self>) {
        let attempt = self.attempt.fetch_add(1, Ordering::SeqCst) + 1;
        self.set(CopilotState::Starting);
        let client = match self.ensure_running().await {
            Ok(c) => c,
            Err(m) => return self.set(CopilotState::Error { message: m }),
        };
        // Already signed in (the server remembers): nothing to ask.
        if let Ok(Ok(v)) =
            tokio::time::timeout(REQUEST_TIMEOUT, client.request("checkStatus", json!({}))).await
        {
            if let Some(next @ CopilotState::In { .. }) = status_from(&v) {
                return self.set(next);
            }
        }
        let reply =
            tokio::time::timeout(REQUEST_TIMEOUT, client.request("signIn", json!({}))).await;
        let v = match reply {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                return self.set(CopilotState::Error {
                    message: format!("Couldn't start the GitHub sign-in: {e}"),
                })
            }
            Err(_) => {
                return self.set(CopilotState::Error {
                    message: "The Copilot component didn't answer".into(),
                })
            }
        };
        // Signed in already: `signIn` can answer with a status.
        if let Some(next @ CopilotState::In { .. }) = status_from(&v) {
            return self.set(next);
        }
        let Some(code) = v["userCode"].as_str() else {
            return self.set(CopilotState::Error {
                message: "GitHub didn't return a sign-in code".into(),
            });
        };
        let command = v["command"].clone();
        self.set(CopilotState::Pending {
            user_code: code.to_string(),
            verification_uri: v["verificationUri"]
                .as_str()
                .unwrap_or(VERIFICATION_URI)
                .to_string(),
            expires_at_ms: now_ms() + CODE_LIFETIME.as_millis() as i64,
        });
        // Finishing the flow waits for the user; it answers when they have authorised (or not).
        let me = self.clone();
        tokio::spawn(async move {
            let result = tokio::time::timeout(
                CODE_LIFETIME,
                client.request(
                    "workspace/executeCommand",
                    json!({
                        "command": command["command"].as_str().unwrap_or("github.copilot.finishDeviceFlow"),
                        "arguments": command["arguments"].clone(),
                    }),
                ),
            )
            .await;
            if me.attempt.load(Ordering::SeqCst) != attempt {
                return; // cancelled or replaced
            }
            match result {
                Ok(Ok(v)) => match status_from(&v) {
                    Some(next) if !matches!(next, CopilotState::Out) => me.set(next),
                    _ => me.set(CopilotState::Expired),
                },
                Ok(Err(e)) if e.code == RpcError::CLOSED => me.set(CopilotState::Out),
                Ok(Err(_)) | Err(_) => me.set(CopilotState::Expired),
            }
        });
    }

    /// Cancel a sign-in that is waiting for the user.
    pub async fn cancel(&self) {
        self.attempt.fetch_add(1, Ordering::SeqCst);
        if let Some(c) = self.install_cancel.lock().unwrap().as_ref() {
            c.cancel();
        }
        self.stop_server().await;
        self.set(CopilotState::Out);
    }

    pub async fn sign_out(&self) {
        self.attempt.fetch_add(1, Ordering::SeqCst);
        if let Ok(client) = self.ensure_running().await {
            let _ =
                tokio::time::timeout(REQUEST_TIMEOUT, client.request("signOut", json!({}))).await;
        }
        self.stop_server().await;
        self.set(CopilotState::Out);
    }

    /// Suggestions at the end of `prefix`, in the document `doc` (one per console).
    pub async fn complete(
        &self,
        doc: &str,
        prefix: &str,
        suffix: &str,
        cancel: CancellationToken,
    ) -> Result<Vec<String>, String> {
        if !matches!(self.state(), CopilotState::In { .. }) {
            return Err("GitHub Copilot isn't signed in".into());
        }
        let client = self.ensure_running().await?;
        let uri = format!("untitled:clew-{doc}.sql");
        let text = format!("{prefix}{suffix}");
        let version = {
            let mut docs = self.docs.lock().unwrap();
            let v = docs.entry(uri.clone()).or_insert(0);
            *v += 1;
            *v
        };
        if version == 1 {
            client
                .notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": "sql", "version": version, "text": text } }),
                )
                .await;
        } else {
            client
                .notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": version },
                        "contentChanges": [{ "text": text }],
                    }),
                )
                .await;
        }
        let (line, character) = utf16_position(prefix);
        let request = client.request(
            "textDocument/inlineCompletion",
            json!({
                "textDocument": { "uri": uri, "version": version },
                "position": { "line": line, "character": character },
                "context": { "triggerKind": 2 },
                "formattingOptions": { "tabSize": 2, "insertSpaces": true },
            }),
        );
        let reply = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            r = tokio::time::timeout(REQUEST_TIMEOUT, request) => r,
        };
        let v = match reply {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => return Err("GitHub Copilot didn't answer in time".into()),
        };
        Ok(items_to_insertions(&v, prefix))
    }
}

/// `checkStatus` / `executeCommand` answers as a state: `OK` and the user, or why not.
fn status_from(v: &Value) -> Option<CopilotState> {
    let status = v["status"].as_str()?;
    match status {
        "OK" | "MaybeOk" | "AlreadySignedIn" => Some(match v["user"].as_str() {
            Some(login) if !login.is_empty() => CopilotState::In {
                login: login.to_string(),
            },
            _ => return None,
        }),
        "NotAuthorized" | "NoTelemetryConsent" => Some(CopilotState::NoAccess),
        "NotSignedIn" | "PromptUserDeviceFlow" => Some(CopilotState::Out),
        _ => None,
    }
}

/// The text to insert at the cursor for each item of an inline completion answer. An item's
/// `range` starts before the cursor when the user has already typed part of it; that part is
/// removed. Items that don't continue the text are dropped.
pub fn items_to_insertions(reply: &Value, prefix: &str) -> Vec<String> {
    let items = reply["items"].as_array().or_else(|| reply.as_array());
    let (line, character) = utf16_position(prefix);
    let mut out: Vec<String> = Vec::new();
    for item in items.into_iter().flatten() {
        let Some(insert) = item["insertText"]
            .as_str()
            .or_else(|| item["insertText"]["value"].as_str())
        else {
            continue;
        };
        let start_line = item["range"]["start"]["line"].as_u64().map(|n| n as u32);
        let start_char = item["range"]["start"]["character"]
            .as_u64()
            .map(|n| n as u32);
        let typed = match (start_line, start_char) {
            (Some(l), Some(c)) if l == line && c <= character => {
                let last = prefix.rsplit('\n').next().unwrap_or("");
                let units: Vec<u16> = last.encode_utf16().collect();
                String::from_utf16_lossy(&units[c as usize..])
            }
            (Some(_), Some(_)) => continue, // starts on another line: not a continuation
            _ => String::new(),
        };
        if let Some(rest) = insert.strip_prefix(typed.as_str()) {
            if !rest.is_empty() && !out.iter().any(|o| o == rest) {
                out.push(rest.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
