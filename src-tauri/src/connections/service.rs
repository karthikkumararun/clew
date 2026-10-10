//! Saved-connection operations: list, save, delete, duplicate, groups, and `resolve` (turn a saved
//! connection into the fully resolved config a driver connects with).
//!
//! Secrets never leave this process: the WebView can *send* a password when saving or answering a
//! prompt, but nothing here ever sends one back.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::model::{
    Connection, ConnectionsFile, Group, OracleConnectBy, PasswordMode, Settings, SshAuthKind,
};
use super::secrets::{SecretError, SecretKind, SecretStore};
use super::store::{ConnectionsStore, LoadOutcome, Op};
use crate::drivers::{
    DriverError, ErrorCode, ResolvedConfig, Secret, SshAuth, SshConfig, Target, TlsConfig,
};
use crate::error::{AppError, AppResult};

/// What to do with one stored secret when saving.
#[derive(Debug, Clone, Default, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SecretUpdate {
    /// Leave whatever is stored alone.
    #[default]
    Keep,
    /// Store this value.
    Set { value: Secret },
    /// Remove the stored secret.
    Clear,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub connection: Connection,
    #[serde(default)]
    pub password: SecretUpdate,
    #[serde(default)]
    pub ssh_passphrase: SecretUpdate,
    #[serde(default)]
    pub ssh_password: SecretUpdate,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub connection: Connection,
    /// Non-fatal problems, e.g. the keychain refused the password.
    pub warnings: Vec<String>,
}

/// Which secrets are in the keychain, so the dialog can show "saved" without reading them back.
#[derive(Debug, Clone, Copy, Default, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub password: bool,
    pub ssh_passphrase: bool,
    pub ssh_password: bool,
    /// The keychain could not be read, so the flags above are unknown (false).
    pub keychain_unavailable: bool,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PasswordPrompt {
    pub prompt_id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub user: Option<String>,
    /// `database` or `ssh`
    pub purpose: String,
}

#[async_trait]
pub trait PasswordPrompter: Send + Sync {
    /// Ask the user. `None` means they cancelled.
    async fn ask(&self, prompt: PasswordPrompt) -> Option<Secret>;
}

/// Answers to password prompts shown in the UI, keyed by prompt id.
#[derive(Default)]
pub struct PendingPasswords {
    next: AtomicU64,
    waiting: Mutex<HashMap<String, oneshot::Sender<Option<Secret>>>>,
}

impl std::fmt::Debug for PendingPasswords {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PendingPasswords")
    }
}

impl PendingPasswords {
    pub fn register(&self) -> (String, oneshot::Receiver<Option<Secret>>) {
        let id = format!("pwd-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    /// Deliver the user's answer (`None` = cancelled). False for an unknown prompt.
    pub fn answer(&self, prompt_id: &str, password: Option<Secret>) -> bool {
        match self.waiting.lock().unwrap().remove(prompt_id) {
            Some(tx) => tx.send(password).is_ok(),
            None => false,
        }
    }

    fn forget(&self, prompt_id: &str) {
        self.waiting.lock().unwrap().remove(prompt_id);
    }
}

/// Emits a `password_prompt` event and waits for the `password_answer` command.
pub struct EventPasswordPrompter {
    pub pending: Arc<PendingPasswords>,
    pub emit: Arc<dyn Fn(PasswordPrompt) + Send + Sync>,
    pub timeout: Duration,
}

#[async_trait]
impl PasswordPrompter for EventPasswordPrompter {
    async fn ask(&self, mut prompt: PasswordPrompt) -> Option<Secret> {
        let (id, rx) = self.pending.register();
        prompt.prompt_id = id.clone();
        (self.emit)(prompt);
        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(answer)) => answer,
            _ => {
                self.pending.forget(&id);
                None
            }
        }
    }
}

/// Secrets supplied by the dialog for a connection that is not (fully) saved yet, e.g. to test it.
#[derive(Default)]
struct Overrides {
    password: Option<Secret>,
    ssh_passphrase: Option<Secret>,
    ssh_password: Option<Secret>,
    /// Never prompt for a missing keychain password; connect without one.
    no_prompt: bool,
}

impl Overrides {
    fn get(&self, kind: SecretKind) -> Option<Secret> {
        match kind {
            SecretKind::Password => self.password.clone(),
            SecretKind::SshPassphrase => self.ssh_passphrase.clone(),
            SecretKind::SshPassword => self.ssh_password.clone(),
        }
    }
}

pub struct ConnectionService {
    store: Mutex<ConnectionsStore>,
    pub(crate) secrets: Arc<dyn SecretStore>,
    prompter: Arc<dyn PasswordPrompter>,
    /// Passwords typed for "ask every time" connections, kept until the connection is closed.
    session_secrets: Mutex<HashMap<(String, SecretKind), Secret>>,
}

impl std::fmt::Debug for ConnectionService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConnectionService")
    }
}

pub const KEYCHAIN_WARNING: &str =
    "Couldn't save the password to the keychain — you'll be asked when connecting";

fn not_found(id: &str) -> AppError {
    AppError::new(
        "connection_not_found",
        format!("There is no saved connection \"{id}\""),
    )
}

/// `~` and `~/...` to the user's home directory.
pub fn expand_home(path: &str) -> String {
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        if let Some(home) = std::env::home_dir() {
            let rest = path[1..].trim_start_matches(['/', '\\']);
            return if rest.is_empty() {
                home.to_string_lossy().into_owned()
            } else {
                home.join(rest).to_string_lossy().into_owned()
            };
        }
    }
    path.to_string()
}

impl ConnectionService {
    pub fn new(
        data_dir: &std::path::Path,
        secrets: Arc<dyn SecretStore>,
        prompter: Arc<dyn PasswordPrompter>,
    ) -> (Self, LoadOutcome) {
        let (store, outcome) = ConnectionsStore::open(data_dir);
        (
            Self {
                store: Mutex::new(store),
                secrets,
                prompter,
                session_secrets: Mutex::new(HashMap::new()),
            },
            outcome,
        )
    }

    pub fn file_path(&self) -> PathBuf {
        self.store.lock().unwrap().path().to_path_buf()
    }

    pub fn list(&self) -> AppResult<ConnectionsFile> {
        let mut store = self.store.lock().unwrap();
        store.refresh_if_changed()?;
        Ok(store.file().clone())
    }

    pub fn get(&self, id: &str) -> AppResult<Connection> {
        self.list()?
            .connections
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| not_found(id))
    }

    /// Store or replace a connection and apply its secret updates. A keychain failure is a warning,
    /// never an error: the connection is saved and the user is asked for the password when connecting.
    pub fn save(&self, req: SaveRequest) -> AppResult<SaveOutcome> {
        let mut connection = req.connection;
        if connection.id.is_empty() {
            connection.id = Connection::new_id();
        }
        connection.name = connection.name.trim().to_string();
        if connection.name.is_empty() {
            return Err(AppError::new(
                "invalid_connection",
                "A connection needs a name",
            ));
        }
        if connection.driver.is_empty() {
            return Err(AppError::new(
                "invalid_connection",
                "A connection needs a driver",
            ));
        }

        self.store
            .lock()
            .unwrap()
            .apply(Op::UpsertConnection(connection.clone()))?;

        let mut warnings = Vec::new();
        let mode = connection.settings.password_mode();
        // Only a keychain-mode connection keeps a stored password.
        let password = if mode == PasswordMode::Keychain {
            req.password
        } else {
            SecretUpdate::Clear
        };
        self.apply_secret(
            &connection.id,
            SecretKind::Password,
            password,
            KEYCHAIN_WARNING,
            &mut warnings,
        );
        self.apply_secret(
            &connection.id,
            SecretKind::SshPassphrase,
            req.ssh_passphrase,
            "Couldn't save the SSH passphrase to the keychain — you'll be asked when connecting",
            &mut warnings,
        );
        self.apply_secret(
            &connection.id,
            SecretKind::SshPassword,
            req.ssh_password,
            "Couldn't save the SSH password to the keychain — you'll be asked when connecting",
            &mut warnings,
        );
        // saving may change how an "ask" password is remembered
        self.session_secrets
            .lock()
            .unwrap()
            .retain(|(id, _), _| id != &connection.id);
        Ok(SaveOutcome {
            connection,
            warnings,
        })
    }

    fn apply_secret(
        &self,
        id: &str,
        kind: SecretKind,
        update: SecretUpdate,
        warning: &str,
        warnings: &mut Vec<String>,
    ) {
        let result = match update {
            SecretUpdate::Keep => return,
            SecretUpdate::Clear => self.secrets.delete(id, kind),
            SecretUpdate::Set { value } => {
                if value.expose().is_empty() {
                    self.secrets.delete(id, kind)
                } else {
                    self.secrets.set(id, kind, &value)
                }
            }
        };
        match result {
            Ok(()) => {}
            Err(SecretError::TooLarge) => {
                warnings.push(format!("{warning} (it is too large for the keychain)"))
            }
            Err(SecretError::Unavailable(_)) => warnings.push(warning.to_string()),
        }
    }

    /// Delete a connection and its keychain secrets.
    pub fn delete(&self, id: &str) -> AppResult<Vec<String>> {
        self.store
            .lock()
            .unwrap()
            .apply(Op::DeleteConnection(id.to_string()))?;
        let mut warnings = Vec::new();
        for kind in SecretKind::ALL {
            if self.secrets.delete(id, kind).is_err() {
                warnings
                    .push("Some saved secrets could not be removed from the keychain".to_string());
                break;
            }
        }
        self.forget_session_secrets(id);
        Ok(warnings)
    }

    /// Copy a connection (and its secrets) under a new id and name `<name> (copy)`.
    pub fn duplicate(&self, id: &str) -> AppResult<SaveOutcome> {
        let original = self.get(id)?;
        let mut copy = original.clone();
        copy.id = Connection::new_id();
        copy.name = self.unique_name(&format!("{} (copy)", original.name))?;
        copy.last_used_at = None;
        self.store
            .lock()
            .unwrap()
            .apply(Op::UpsertConnection(copy.clone()))?;

        let mut warnings = Vec::new();
        for kind in SecretKind::ALL {
            match self.secrets.get(id, kind) {
                Ok(Some(secret)) => {
                    if self.secrets.set(&copy.id, kind, &secret).is_err() {
                        warnings.push("Some saved secrets could not be copied".to_string());
                    }
                }
                Ok(None) => {}
                Err(_) => warnings.push("Some saved secrets could not be copied".to_string()),
            }
        }
        warnings.dedup();
        Ok(SaveOutcome {
            connection: copy,
            warnings,
        })
    }

    fn unique_name(&self, wanted: &str) -> AppResult<String> {
        let existing: Vec<String> = self
            .list()?
            .connections
            .into_iter()
            .map(|c| c.name)
            .collect();
        if !existing.contains(&wanted.to_string()) {
            return Ok(wanted.to_string());
        }
        (2..)
            .map(|n| format!("{wanted} {n}"))
            .find(|n| !existing.contains(n))
            .ok_or_else(|| AppError::new("internal", "no free name"))
    }

    pub fn save_group(&self, mut group: Group) -> AppResult<Group> {
        group.name = group.name.trim().to_string();
        if group.name.is_empty() {
            return Err(AppError::new("invalid_group", "A group needs a name"));
        }
        if group.id.is_empty() {
            group.id = Connection::new_group_id();
        }
        self.store
            .lock()
            .unwrap()
            .apply(Op::UpsertGroup(group.clone()))?;
        Ok(group)
    }

    /// Delete a group; its connections move to "Ungrouped".
    pub fn delete_group(&self, id: &str) -> AppResult<()> {
        self.store
            .lock()
            .unwrap()
            .apply(Op::DeleteGroup(id.to_string()))
    }

    pub fn touch_last_used(&self, id: &str, at: &str) -> AppResult<()> {
        self.store.lock().unwrap().apply(Op::TouchLastUsed {
            id: id.to_string(),
            at: at.to_string(),
        })
    }

    pub fn secret_status(&self, id: &str) -> SecretStatus {
        let mut status = SecretStatus::default();
        for kind in SecretKind::ALL {
            match self.secrets.get(id, kind) {
                Ok(found) => {
                    let present = found.is_some();
                    match kind {
                        SecretKind::Password => status.password = present,
                        SecretKind::SshPassphrase => status.ssh_passphrase = present,
                        SecretKind::SshPassword => status.ssh_password = present,
                    }
                }
                Err(_) => status.keychain_unavailable = true,
            }
        }
        status
    }

    /// Forget passwords typed for "ask every time" (when the connection is closed).
    pub fn forget_session_secrets(&self, id: &str) {
        self.session_secrets
            .lock()
            .unwrap()
            .retain(|(cid, _), _| cid != id);
    }

    async fn secret_for(
        &self,
        connection: &Connection,
        kind: SecretKind,
        mode: PasswordMode,
        optional: bool,
        overrides: &Overrides,
    ) -> Result<Option<Secret>, DriverError> {
        if mode == PasswordMode::None {
            return Ok(None);
        }
        if let Some(secret) = overrides.get(kind) {
            return Ok(Some(secret));
        }
        if mode == PasswordMode::Keychain {
            // A locked keychain or a missing entry both fall back to asking.
            if let Ok(Some(secret)) = self.secrets.get(&connection.id, kind) {
                return Ok(Some(secret));
            }
            if optional || overrides.no_prompt {
                return Ok(None);
            }
        }
        if let Some(s) = self
            .session_secrets
            .lock()
            .unwrap()
            .get(&(connection.id.clone(), kind))
        {
            return Ok(Some(s.clone()));
        }
        let purpose = if kind == SecretKind::Password {
            "database"
        } else {
            "ssh"
        };
        let user = if kind == SecretKind::Password {
            connection.settings.user().map(str::to_string)
        } else {
            connection.ssh.as_ref().map(|s| s.user.clone())
        };
        let answer = self
            .prompter
            .ask(PasswordPrompt {
                prompt_id: String::new(),
                connection_id: connection.id.clone(),
                connection_name: connection.name.clone(),
                user,
                purpose: purpose.to_string(),
            })
            .await;
        match answer {
            Some(secret) => {
                self.session_secrets
                    .lock()
                    .unwrap()
                    .insert((connection.id.clone(), kind), secret.clone());
                Ok(Some(secret))
            }
            None => Err(DriverError::new(
                ErrorCode::Cancelled,
                "Password entry was cancelled",
            )),
        }
    }

    /// Turn a saved connection into a [`ResolvedConfig`], filling in secrets (asking for any that
    /// are "ask every time" or missing from the keychain).
    pub async fn resolve(&self, id: &str) -> Result<ResolvedConfig, DriverError> {
        let c = self
            .get(id)
            .map_err(|e| DriverError::new(ErrorCode::Internal, e.message))?;
        self.resolve_connection(&c).await
    }

    pub async fn resolve_connection(&self, c: &Connection) -> Result<ResolvedConfig, DriverError> {
        self.resolve_with(c, &Overrides::default()).await
    }

    /// Resolve an unsaved dialog draft for "Test connection": typed secrets win over stored ones
    /// and nothing is prompted for or saved.
    pub async fn resolve_draft(&self, req: &SaveRequest) -> Result<ResolvedConfig, DriverError> {
        let value = |u: &SecretUpdate| match u {
            SecretUpdate::Set { value } if !value.expose().is_empty() => Some(value.clone()),
            _ => None,
        };
        let overrides = Overrides {
            password: value(&req.password),
            ssh_passphrase: value(&req.ssh_passphrase),
            ssh_password: value(&req.ssh_password),
            no_prompt: true,
        };
        self.resolve_with(&req.connection, &overrides).await
    }

    async fn resolve_with(
        &self,
        c: &Connection,
        overrides: &Overrides,
    ) -> Result<ResolvedConfig, DriverError> {
        let mut options = c.advanced.properties.clone();
        let mode = c.settings.password_mode();
        let target = match &c.settings {
            Settings::Network { host, port, .. } => Target::Network {
                host: host.clone(),
                port: *port,
            },
            Settings::Oracle {
                host,
                port,
                connect_by,
                role,
                wallet_dir,
                ..
            } => {
                let (by, value) = match connect_by {
                    OracleConnectBy::ServiceName { value } => ("service_name", value),
                    OracleConnectBy::Sid { value } => ("sid", value),
                    OracleConnectBy::TnsAlias { value } => ("tns_alias", value),
                    OracleConnectBy::EasyConnect { value } => ("easy_connect", value),
                };
                options.insert("oracle.connect_by".into(), by.into());
                options.insert("oracle.connect_value".into(), value.clone());
                if let Some(r) = role {
                    options.insert("oracle.role".into(), r.clone());
                }
                if let Some(w) = wallet_dir {
                    options.insert("oracle.wallet_dir".into(), expand_home(w));
                }
                Target::Network {
                    host: host.clone(),
                    port: *port,
                }
            }
            Settings::File {
                path,
                create_if_missing,
            } => Target::File {
                path: expand_home(path),
                create_if_missing: *create_if_missing,
                read_only: false,
            },
            Settings::Uri { uri, .. } => Target::Uri { uri: uri.clone() },
            Settings::Keyvalue {
                host,
                port,
                db_index,
                ..
            } => {
                options.insert("db_index".into(), db_index.to_string());
                Target::Network {
                    host: host.clone(),
                    port: *port,
                }
            }
            Settings::Neo4j {
                protocol,
                host,
                port,
                ..
            } => {
                options.insert("neo4j.protocol".into(), protocol.clone());
                Target::Network {
                    host: host.clone(),
                    port: *port,
                }
            }
        };

        let password = self
            .secret_for(c, SecretKind::Password, mode, false, overrides)
            .await?;

        let ssh = match c.ssh.as_ref().filter(|s| s.enabled) {
            None => None,
            Some(s) => {
                let auth = match s.auth {
                    SshAuthKind::Agent => SshAuth::Agent,
                    SshAuthKind::Key => SshAuth::KeyFile {
                        path: expand_home(s.key_file.as_deref().unwrap_or("~/.ssh/id_ed25519")),
                        // a key without a passphrase is normal, so a missing one is not asked for
                        passphrase: self
                            .secret_for(
                                c,
                                SecretKind::SshPassphrase,
                                PasswordMode::Keychain,
                                true,
                                overrides,
                            )
                            .await?,
                    },
                    SshAuthKind::Password => SshAuth::Password {
                        password: self
                            .secret_for(
                                c,
                                SecretKind::SshPassword,
                                PasswordMode::Keychain,
                                false,
                                overrides,
                            )
                            .await?
                            .unwrap_or_default(),
                    },
                };
                Some(SshConfig {
                    host: s.host.clone(),
                    port: s.port,
                    user: s.user.clone(),
                    auth,
                })
            }
        };

        let tls = TlsConfig {
            mode: c.tls.mode,
            ca_file: c.tls.ca_file.as_deref().map(expand_home),
            client_cert: c.tls.client_cert.as_deref().map(expand_home),
            client_key: c.tls.client_key.as_deref().map(expand_home),
        };

        Ok(ResolvedConfig {
            driver: c.driver.clone(),
            target,
            user: c.settings.user().map(str::to_string),
            password,
            database: c.settings.database().map(str::to_string),
            ssh,
            tls,
            connect_timeout_secs: c.advanced.connect_timeout_sec.max(1),
            query_timeout_secs: (c.advanced.query_timeout_sec > 0)
                .then_some(c.advanced.query_timeout_sec),
            read_only: c.safeguards.read_only_by_default,
            options,
            on_connect: c.advanced.on_connect.clone(),
        })
    }
}

#[cfg(test)]
mod tests;
