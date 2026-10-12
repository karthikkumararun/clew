//! SSH host-key verification: `~/.ssh/known_hosts` (read-only) plus Clew's own file
//! (`<app data>/known_hosts`, read-write), with an interactive prompt for unknown keys.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use russh::keys::{known_hosts, Error as KeysError, HashAlg, PublicKey};
use serde::Serialize;
use tokio::sync::oneshot;

use crate::drivers::{DriverError, DriverResult, ErrorCode};

/// What the user is shown when a bastion's key is not known yet.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    /// e.g. `ssh-ed25519`
    pub key_type: String,
    /// `SHA256:...`, the same form `ssh` prints.
    pub fingerprint: String,
}

#[async_trait]
pub trait HostKeyPrompter: Send + Sync {
    /// Ask whether to trust the key. `false` rejects the connection.
    async fn confirm(&self, prompt: HostKeyPrompt) -> bool;
}

/// Rejects every unknown key. Used when nobody can answer (and in tests).
pub struct RejectUnknown;

#[async_trait]
impl HostKeyPrompter for RejectUnknown {
    async fn confirm(&self, _: HostKeyPrompt) -> bool {
        false
    }
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// Found in a known-hosts file and equal.
    Known,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct KnownHosts {
    /// The user's own file, never written.
    pub user_file: Option<PathBuf>,
    /// Clew's file; accepted keys are appended here.
    pub app_file: PathBuf,
}

impl KnownHosts {
    pub fn new(app_data_dir: &std::path::Path) -> Self {
        // End-to-end runs never read the developer's real ~/.ssh/known_hosts.
        #[cfg(feature = "e2e")]
        let user_file = if crate::testmode::active() {
            None
        } else {
            std::env::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
        };
        #[cfg(not(feature = "e2e"))]
        let user_file = std::env::home_dir().map(|h| h.join(".ssh").join("known_hosts"));
        Self {
            user_file,
            app_file: app_data_dir.join("known_hosts"),
        }
    }

    /// `host_key_mismatch` when either file holds a *different* key of the same algorithm.
    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> DriverResult<HostKeyStatus> {
        let mut known = false;
        for path in self.user_file.iter().chain(std::iter::once(&self.app_file)) {
            match known_hosts::check_known_hosts_path(host, port, key, path) {
                Ok(true) => known = true,
                Ok(false) => {}
                Err(KeysError::KeyChanged { line }) => {
                    return Err(DriverError::new(
                        ErrorCode::HostKeyMismatch,
                        format!(
                            "The SSH host key for {host}:{port} has changed. Refusing to connect; nothing was sent."
                        ),
                    )
                    .with_detail(format!(
                        "Recorded key differs at {}:{line}. Presented fingerprint: {}",
                        path.display(),
                        fingerprint(key)
                    )));
                }
                Err(e) => {
                    return Err(DriverError::internal("Could not read the known-hosts file")
                        .with_detail(format!("{}: {e}", path.display())))
                }
            }
        }
        Ok(if known {
            HostKeyStatus::Known
        } else {
            HostKeyStatus::Unknown
        })
    }

    /// Remember an accepted key in Clew's own file.
    pub fn learn(&self, host: &str, port: u16, key: &PublicKey) -> DriverResult<()> {
        known_hosts::learn_known_hosts_path(host, port, key, &self.app_file).map_err(|e| {
            DriverError::internal("Could not save the host key")
                .with_detail(format!("{}: {e}", self.app_file.display()))
        })
    }
}

/// Answers to prompts shown in the UI, keyed by prompt id.
#[derive(Debug, Default)]
pub struct PendingPrompts {
    next: AtomicU64,
    waiting: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl PendingPrompts {
    pub fn register(&self) -> (String, oneshot::Receiver<bool>) {
        let id = format!("hostkey-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    /// Deliver the user's answer. Returns false for an unknown or already-answered prompt.
    pub fn answer(&self, prompt_id: &str, accept: bool) -> bool {
        match self.waiting.lock().unwrap().remove(prompt_id) {
            Some(tx) => tx.send(accept).is_ok(),
            None => false,
        }
    }

    fn forget(&self, prompt_id: &str) {
        self.waiting.lock().unwrap().remove(prompt_id);
    }
}

/// Emits a `host_key_prompt` event to the UI and waits for the answer command.
pub struct EventPrompter {
    pub pending: Arc<PendingPrompts>,
    pub emit: Arc<dyn Fn(HostKeyPrompt) + Send + Sync>,
    pub timeout: Duration,
}

#[async_trait]
impl HostKeyPrompter for EventPrompter {
    async fn confirm(&self, mut prompt: HostKeyPrompt) -> bool {
        let (id, rx) = self.pending.register();
        prompt.prompt_id = id.clone();
        (self.emit)(prompt);
        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(accepted)) => accepted,
            _ => {
                self.pending.forget(&id);
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Fixed throwaway public keys (generated once; the private halves are not kept anywhere).
    const KEYS: [&str; 3] = [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAmdgevPmDKocTg+omGdtTHH8xtTp1tS9tCNX4BYNOcT",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM2DzlJpJsfMpIYBVtkSxAPL2RvzryPp9LN5aLZ+e1B4",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC+v9kllYMYUIKrkiOHzf0LToN0r7QcNRvliNebfS3MS",
    ];

    fn key_n(n: usize) -> PublicKey {
        PublicKey::from_openssh(KEYS[n]).unwrap()
    }

    fn hosts(dir: &tempfile::TempDir) -> KnownHosts {
        KnownHosts {
            user_file: Some(dir.path().join("user_known_hosts")),
            app_file: dir.path().join("app").join("known_hosts"),
        }
    }

    #[test]
    fn an_unseen_host_is_unknown_even_when_no_files_exist() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            hosts(&dir).check("bastion", 22, &key_n(0)).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn accepted_keys_are_remembered_in_the_app_file_only() {
        let dir = tempfile::tempdir().unwrap();
        let kh = hosts(&dir);
        let k = key_n(0);
        kh.learn("bastion", 2222, &k).unwrap();
        assert_eq!(kh.check("bastion", 2222, &k).unwrap(), HostKeyStatus::Known);
        assert!(
            !dir.path().join("user_known_hosts").exists(),
            "the user's file is never written"
        );
        assert_eq!(
            kh.check("bastion", 22, &k).unwrap(),
            HostKeyStatus::Unknown,
            "port is part of the identity"
        );
    }

    #[test]
    fn keys_in_the_users_file_are_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let kh = hosts(&dir);
        let k = key_n(0);
        known_hosts::learn_known_hosts_path("bastion", 22, &k, kh.user_file.as_ref().unwrap())
            .unwrap();
        assert_eq!(kh.check("bastion", 22, &k).unwrap(), HostKeyStatus::Known);
    }

    #[test]
    fn a_changed_key_is_a_mismatch_in_either_file() {
        let dir = tempfile::tempdir().unwrap();
        let kh = hosts(&dir);
        kh.learn("bastion", 22, &key_n(0)).unwrap();
        let err = kh.check("bastion", 22, &key_n(1)).unwrap_err();
        assert_eq!(err.code, ErrorCode::HostKeyMismatch);
        assert!(err.detail.unwrap().contains("SHA256:"));

        let kh2 = hosts(&tempfile::tempdir().unwrap());
        known_hosts::learn_known_hosts_path("b2", 22, &key_n(2), kh2.user_file.as_ref().unwrap())
            .unwrap();
        assert_eq!(
            kh2.check("b2", 22, &key_n(1)).unwrap_err().code,
            ErrorCode::HostKeyMismatch
        );
    }

    #[test]
    fn fingerprints_look_like_openssh() {
        assert!(fingerprint(&key_n(0)).starts_with("SHA256:"));
    }

    #[tokio::test]
    async fn the_event_prompter_waits_for_the_answer() {
        let pending = Arc::new(PendingPrompts::default());
        let seen = Arc::new(Mutex::new(None::<HostKeyPrompt>));
        let seen2 = seen.clone();
        let prompter = EventPrompter {
            pending: pending.clone(),
            emit: Arc::new(move |p| *seen2.lock().unwrap() = Some(p)),
            timeout: Duration::from_secs(5),
        };
        let p = HostKeyPrompt {
            prompt_id: String::new(),
            host: "bastion".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
        };
        let task = tokio::spawn(async move { prompter.confirm(p).await });
        let id = loop {
            if let Some(p) = seen.lock().unwrap().clone() {
                break p.prompt_id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert!(pending.answer(&id, true));
        assert!(task.await.unwrap());
        assert!(!pending.answer(&id, true), "answers are one-shot");
    }

    #[tokio::test]
    async fn an_unanswered_prompt_times_out_as_rejected() {
        let prompter = EventPrompter {
            pending: Arc::new(PendingPrompts::default()),
            emit: Arc::new(|_| {}),
            timeout: Duration::from_millis(50),
        };
        let p = HostKeyPrompt {
            prompt_id: String::new(),
            host: "h".into(),
            port: 22,
            key_type: "k".into(),
            fingerprint: "f".into(),
        };
        assert!(!prompter.confirm(p).await);
    }
}
