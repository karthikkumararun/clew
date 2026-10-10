//! SSH local-forward tunnels (agent, key file or password authentication).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle, Handler};
use russh::keys::{
    agent::client::AgentClient, ssh_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate,
};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use super::hostkey::{fingerprint, HostKeyPrompt, HostKeyPrompter, HostKeyStatus, KnownHosts};
use crate::drivers::{DriverError, DriverResult, ErrorCode, SshAuth, SshConfig};

/// Everything the tunnel needs from the app: where known hosts live and who answers prompts.
#[derive(Clone)]
pub struct SshEnv {
    pub known_hosts: KnownHosts,
    pub prompter: Arc<dyn HostKeyPrompter>,
}

/// An open tunnel: connections to `127.0.0.1:local_port` are forwarded to the database host.
/// Dropping it closes the listener and the SSH connection.
pub struct SshTunnel {
    local_port: u16,
    via: String,
    accept_task: JoinHandle<()>,
    // keep the SSH connection alive for as long as the tunnel
    _handle: Arc<Handle<ClientHandler>>,
}

impl SshTunnel {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// Text for the status bar: `via SSH <host>`.
    pub fn via(&self) -> &str {
        &self.via
    }

    pub fn is_alive(&self) -> bool {
        !self._handle.is_closed() && !self.accept_task.is_finished()
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

impl std::fmt::Debug for SshTunnel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshTunnel")
            .field("local_port", &self.local_port)
            .field("via", &self.via)
            .finish()
    }
}

pub struct ClientHandler {
    host: String,
    port: u16,
    env: SshEnv,
    /// Why the key was refused, so the caller can report it instead of a generic error.
    refusal: Arc<Mutex<Option<DriverError>>>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = server_public_key else {
            *self.refusal.lock().unwrap() = Some(DriverError::new(
                ErrorCode::HostKeyMismatch,
                "The SSH server presented a certificate, which Clew does not support yet",
            ));
            return Ok(false);
        };
        match self.env.known_hosts.check(&self.host, self.port, key) {
            Ok(HostKeyStatus::Known) => Ok(true),
            Ok(HostKeyStatus::Unknown) => {
                let prompt = HostKeyPrompt {
                    prompt_id: String::new(),
                    host: self.host.clone(),
                    port: self.port,
                    key_type: key.algorithm().to_string(),
                    fingerprint: fingerprint(key),
                };
                if self.env.prompter.confirm(prompt).await {
                    if let Err(e) = self.env.known_hosts.learn(&self.host, self.port, key) {
                        *self.refusal.lock().unwrap() = Some(e);
                        return Ok(false);
                    }
                    Ok(true)
                } else {
                    *self.refusal.lock().unwrap() = Some(DriverError::new(
                        ErrorCode::Cancelled,
                        format!(
                            "The SSH host key for {}:{} was not accepted",
                            self.host, self.port
                        ),
                    ));
                    Ok(false)
                }
            }
            Err(e) => {
                *self.refusal.lock().unwrap() = Some(e);
                Ok(false)
            }
        }
    }
}

fn auth_failed(message: impl Into<String>) -> DriverError {
    DriverError::new(ErrorCode::AuthFailed, message)
}

fn ssh_error(cfg: &SshConfig, e: impl std::fmt::Display) -> DriverError {
    DriverError::new(
        ErrorCode::ConnectionLost,
        format!(
            "Could not open the SSH connection to {}:{}",
            cfg.host, cfg.port
        ),
    )
    .with_detail(e.to_string())
}

fn is_success(r: &AuthResult) -> bool {
    matches!(r, AuthResult::Success)
}

async fn auth_with_agent<R>(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    agent: &mut AgentClient<R>,
) -> DriverResult<bool>
where
    R: tokio::io::AsyncRead
        + tokio::io::AsyncWrite
        + Unpin
        + Send
        + 'static
        + russh::keys::agent::client::AgentStream,
{
    let identities = agent.request_identities().await.map_err(|e| {
        auth_failed("Could not list the keys in the SSH agent").with_detail(e.to_string())
    })?;
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    for identity in identities {
        let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let alg: Option<HashAlg> = if matches!(key.algorithm(), ssh_key::Algorithm::Rsa { .. }) {
            hash
        } else {
            None
        };
        match handle
            .authenticate_publickey_with(user, key, alg, agent)
            .await
        {
            Ok(r) if is_success(&r) => return Ok(true),
            _ => continue,
        }
    }
    Ok(false)
}

async fn authenticate(handle: &mut Handle<ClientHandler>, cfg: &SshConfig) -> DriverResult<()> {
    let ok = match &cfg.auth {
        SshAuth::Password { password } => is_success(
            &handle
                .authenticate_password(&cfg.user, password.expose())
                .await
                .map_err(|e| ssh_error(cfg, e))?,
        ),
        SshAuth::KeyFile { path, passphrase } => {
            let key = russh::keys::load_secret_key(path, passphrase.as_ref().map(|p| p.expose()))
                .map_err(|e| {
                let text = e.to_string();
                if text.to_ascii_lowercase().contains("encrypted") && passphrase.is_none() {
                    auth_failed(format!("The SSH key {path} is protected by a passphrase"))
                } else if passphrase.is_some() && text.to_ascii_lowercase().contains("crypto") {
                    auth_failed(format!("The passphrase for the SSH key {path} is wrong"))
                } else {
                    auth_failed(format!("Could not read the SSH key {path}")).with_detail(text)
                }
            })?;
            let hash = if matches!(key.algorithm(), ssh_key::Algorithm::Rsa { .. }) {
                handle
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten()
            } else {
                None
            };
            is_success(
                &handle
                    .authenticate_publickey(
                        &cfg.user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| ssh_error(cfg, e))?,
            )
        }
        SshAuth::Agent => connect_agent_and_auth(handle, &cfg.user).await?,
    };
    if ok {
        Ok(())
    } else {
        Err(auth_failed(format!(
            "The SSH server {}:{} rejected the credentials for user \"{}\"",
            cfg.host, cfg.port, cfg.user
        )))
    }
}

#[cfg(unix)]
async fn connect_agent_and_auth(
    handle: &mut Handle<ClientHandler>,
    user: &str,
) -> DriverResult<bool> {
    let mut agent = AgentClient::connect_env().await.map_err(|e| {
        auth_failed("Could not reach the SSH agent (is SSH_AUTH_SOCK set?)")
            .with_detail(e.to_string())
    })?;
    auth_with_agent(handle, user, &mut agent).await
}

#[cfg(windows)]
async fn connect_agent_and_auth(
    handle: &mut Handle<ClientHandler>,
    user: &str,
) -> DriverResult<bool> {
    // The Windows OpenSSH agent first, then Pageant.
    if let Ok(mut agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        if auth_with_agent(handle, user, &mut agent).await? {
            return Ok(true);
        }
    }
    let mut agent = AgentClient::connect_pageant().await.map_err(|e| {
        auth_failed("Could not reach an SSH agent (OpenSSH agent or Pageant)")
            .with_detail(e.to_string())
    })?;
    auth_with_agent(handle, user, &mut agent).await
}

impl SshTunnel {
    /// Connect to the bastion, authenticate, and start forwarding a local ephemeral port to
    /// `remote_host:remote_port` as seen from the bastion.
    pub async fn open(
        cfg: &SshConfig,
        remote_host: &str,
        remote_port: u16,
        env: SshEnv,
        connect_timeout: Duration,
    ) -> DriverResult<SshTunnel> {
        let refusal = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host: cfg.host.clone(),
            port: cfg.port,
            env,
            refusal: refusal.clone(),
        };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let connecting = client::connect(config, (cfg.host.as_str(), cfg.port), handler);
        let mut handle = match tokio::time::timeout(connect_timeout, connecting).await {
            Err(_) => {
                return Err(DriverError::new(
                    ErrorCode::Timeout,
                    format!(
                        "Could not reach the SSH host {}:{} within {}s",
                        cfg.host,
                        cfg.port,
                        connect_timeout.as_secs()
                    ),
                ))
            }
            Ok(Err(e)) => {
                // A refused host key is the real reason when the handler recorded one.
                return Err(refusal
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap_or_else(|| ssh_error(cfg, e)));
            }
            Ok(Ok(h)) => h,
        };

        authenticate(&mut handle, cfg).await?;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| {
            DriverError::internal("Could not open a local port for the tunnel")
                .with_detail(e.to_string())
        })?;
        let local_port = listener
            .local_addr()
            .map_err(|e| {
                DriverError::internal("Could not open a local port for the tunnel")
                    .with_detail(e.to_string())
            })?
            .port();

        let handle = Arc::new(handle);
        let forward = handle.clone();
        let (host, port) = (remote_host.to_string(), remote_port);
        let accept_task = tokio::spawn(async move {
            loop {
                let Ok((mut local, peer)) = listener.accept().await else {
                    return;
                };
                let forward = forward.clone();
                let host = host.clone();
                tokio::spawn(async move {
                    let Ok(channel) = forward
                        .channel_open_direct_tcpip(
                            host,
                            port as u32,
                            "127.0.0.1",
                            peer.port() as u32,
                        )
                        .await
                    else {
                        return;
                    };
                    let mut remote = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                });
            }
        });

        Ok(SshTunnel {
            local_port,
            via: format!("via SSH {}", cfg.host),
            accept_task,
            _handle: handle,
        })
    }
}
