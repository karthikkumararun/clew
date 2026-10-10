//! SSH tunnel tests against the docker-compose bastion (`docker compose up -d --build --wait`,
//! after `scripts/gen-test-certs.sh`). Run with `cargo test --features integration`.
#![cfg(feature = "integration")]

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use clew_lib::drivers::{DriverError, ErrorCode, Secret, SshAuth, SshConfig};
use clew_lib::transport::hostkey::{fingerprint, HostKeyPrompt, HostKeyPrompter, KnownHosts};
use clew_lib::transport::ssh::{SshEnv, SshTunnel};
use russh::keys::PublicKey;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const BASTION_PORT: u16 = 2222;

/// The agent tests change a process-wide environment variable and sshd throttles bursts of
/// logins, so every test in this file takes turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn keys_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docker/bastion/keys")
}

fn key(name: &str) -> String {
    keys_dir().join(name).to_string_lossy().into_owned()
}

struct Answering {
    accept: bool,
    calls: AtomicUsize,
    last: Mutex<Option<HostKeyPrompt>>,
}

impl Answering {
    fn new(accept: bool) -> Arc<Self> {
        Arc::new(Self {
            accept,
            calls: AtomicUsize::new(0),
            last: Mutex::new(None),
        })
    }
}

#[async_trait]
impl HostKeyPrompter for Answering {
    async fn confirm(&self, prompt: HostKeyPrompt) -> bool {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.last.lock().unwrap() = Some(prompt);
        self.accept
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    env: SshEnv,
    prompter: Arc<Answering>,
    known_hosts: KnownHosts,
}

fn fixture(accept_unknown: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let known_hosts = KnownHosts {
        user_file: None,
        app_file: dir.path().join("known_hosts"),
    };
    let prompter = Answering::new(accept_unknown);
    Fixture {
        env: SshEnv {
            known_hosts: known_hosts.clone(),
            prompter: prompter.clone(),
        },
        _dir: dir,
        prompter,
        known_hosts,
    }
}

fn cfg(auth: SshAuth) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port: BASTION_PORT,
        user: "tunnel".into(),
        auth,
    }
}

fn password(p: &str) -> SshAuth {
    SshAuth::Password {
        password: Secret::new(p),
    }
}

async fn open(f: &Fixture, auth: SshAuth) -> Result<SshTunnel, DriverError> {
    // `postgres` resolves inside the compose network, from the bastion's point of view.
    SshTunnel::open(
        &cfg(auth),
        "postgres",
        5432,
        f.env.clone(),
        Duration::from_secs(10),
    )
    .await
}

/// Talk to PostgreSQL through the tunnel: an SSLRequest is answered with a single byte.
async fn postgres_answers(port: u16) -> bool {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(&[0, 0, 0, 8, 4, 210, 22, 47]).await.unwrap();
    let mut b = [0u8; 1];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut b))
        .await
        .expect("timed out waiting for PostgreSQL")
        .unwrap();
    b[0] == b'S' || b[0] == b'N'
}

fn host_key() -> PublicKey {
    let text = std::fs::read_to_string(keys_dir().join("host_ed25519.pub")).unwrap();
    PublicKey::from_openssh(text.trim()).unwrap()
}

#[tokio::test]
async fn password_auth_forwards_to_the_database() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let tunnel = open(&f, password("tunnelpw")).await.unwrap();
    assert_eq!(tunnel.via(), "via SSH 127.0.0.1");
    assert!(tunnel.is_alive());
    assert!(postgres_answers(tunnel.local_port()).await);
}

#[tokio::test]
async fn the_wrong_password_is_auth_failed_and_is_not_echoed() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let err = open(&f, password("not-the-password")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(!format!("{err:?}").contains("not-the-password"));
}

#[tokio::test]
async fn key_file_auth() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let tunnel = open(
        &f,
        SshAuth::KeyFile {
            path: key("client_ed25519"),
            passphrase: None,
        },
    )
    .await
    .unwrap();
    assert!(postgres_answers(tunnel.local_port()).await);
}

#[tokio::test]
async fn key_file_with_a_passphrase() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let tunnel = open(
        &f,
        SshAuth::KeyFile {
            path: key("client_pass_ed25519"),
            passphrase: Some(Secret::new("testpass")),
        },
    )
    .await
    .unwrap();
    assert!(postgres_answers(tunnel.local_port()).await);
}

#[tokio::test]
async fn a_protected_key_without_its_passphrase_says_so() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let err = open(
        &f,
        SshAuth::KeyFile {
            path: key("client_pass_ed25519"),
            passphrase: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(err.message.contains("passphrase"), "{}", err.message);
}

#[tokio::test]
async fn a_wrong_passphrase_is_reported_without_echoing_it() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let err = open(
        &f,
        SshAuth::KeyFile {
            path: key("client_pass_ed25519"),
            passphrase: Some(Secret::new("wrong-pass")),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(!format!("{err:?}").contains("wrong-pass"));
}

#[tokio::test]
async fn a_missing_key_file_is_a_clear_error() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let err = open(
        &f,
        SshAuth::KeyFile {
            path: "/no/such/key".into(),
            passphrase: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(err.message.contains("/no/such/key"));
}

#[cfg(unix)]
#[tokio::test]
async fn agent_auth_uses_a_key_held_by_the_agent() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("agent.sock");
    let agent = Command::new("ssh-agent")
        .args(["-D", "-a"])
        .arg(&sock)
        .spawn()
        .expect("ssh-agent must be installed to run this test");
    struct Kill(std::process::Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }
    let _agent = Kill(agent);
    for _ in 0..50 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let add = Command::new("ssh-add")
        .arg(key("client_ed25519"))
        .env("SSH_AUTH_SOCK", &sock)
        .output()
        .unwrap();
    assert!(
        add.status.success(),
        "{}",
        String::from_utf8_lossy(&add.stderr)
    );

    // Only this test uses the agent, so setting the variable for the process is safe here.
    // SAFETY: no other test in this binary reads SSH_AUTH_SOCK.
    unsafe { std::env::set_var("SSH_AUTH_SOCK", &sock) };

    let f = fixture(true);
    let tunnel = open(&f, SshAuth::Agent).await.unwrap();
    assert!(postgres_answers(tunnel.local_port()).await);
}

#[cfg(unix)]
#[tokio::test]
async fn agent_auth_without_an_agent_is_a_clear_error() {
    let _serial = SERIAL.lock().await;
    // An agent socket that does not exist.
    let f = fixture(true);
    let saved = std::env::var_os("SSH_AUTH_SOCK");
    // SAFETY: see above; this test runs the agent-less path only.
    unsafe { std::env::set_var("SSH_AUTH_SOCK", "/nonexistent/agent.sock") };
    let err = open(&f, SshAuth::Agent).await.unwrap_err();
    match saved {
        Some(v) => unsafe { std::env::set_var("SSH_AUTH_SOCK", v) },
        None => unsafe { std::env::remove_var("SSH_AUTH_SOCK") },
    }
    assert_eq!(err.code, ErrorCode::AuthFailed);
}

#[tokio::test]
async fn an_unknown_host_key_prompts_and_accepting_remembers_it() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let _t = open(&f, password("tunnelpw")).await.unwrap();
    assert_eq!(f.prompter.calls.load(Ordering::SeqCst), 1);
    let prompt = f.prompter.last.lock().unwrap().clone().unwrap();
    assert_eq!(prompt.fingerprint, fingerprint(&host_key()));
    assert_eq!(prompt.key_type, "ssh-ed25519");
    assert_eq!(prompt.port, BASTION_PORT);

    // remembered: the second connection does not ask again
    let _t2 = open(&f, password("tunnelpw")).await.unwrap();
    assert_eq!(f.prompter.calls.load(Ordering::SeqCst), 1);
    assert!(std::fs::read_to_string(&f.known_hosts.app_file)
        .unwrap()
        .contains("[127.0.0.1]:2222"));
}

#[tokio::test]
async fn rejecting_an_unknown_host_key_connects_to_nothing() {
    let _serial = SERIAL.lock().await;
    let f = fixture(false);
    let err = open(&f, password("tunnelpw")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(err.message.contains("host key"));
    assert!(
        !f.known_hosts.app_file.exists(),
        "a rejected key is not stored"
    );
}

#[tokio::test]
async fn a_changed_host_key_is_refused_without_prompting_or_sending_credentials() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    // Record a *different* key for the bastion.
    let other = PublicKey::from_openssh(
        std::fs::read_to_string(keys_dir().join("client_ed25519.pub"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    f.known_hosts
        .learn("127.0.0.1", BASTION_PORT, &other)
        .unwrap();

    let err = open(&f, password("tunnelpw")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HostKeyMismatch);
    assert_eq!(f.prompter.calls.load(Ordering::SeqCst), 0);
    assert!(err.detail.unwrap().contains(&fingerprint(&host_key())));
}

#[tokio::test]
async fn an_unreachable_ssh_host_fails_fast_and_names_it() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let mut c = cfg(password("x"));
    c.port = 1; // nothing listens here
    let err = SshTunnel::open(&c, "postgres", 5432, f.env.clone(), Duration::from_secs(3))
        .await
        .unwrap_err();
    assert!(matches!(
        err.code,
        ErrorCode::ConnectionLost | ErrorCode::Timeout
    ));
    assert!(err.message.contains("127.0.0.1:1"), "{}", err.message);
}

#[tokio::test]
async fn dropping_the_tunnel_closes_the_local_port() {
    let _serial = SERIAL.lock().await;
    let f = fixture(true);
    let tunnel = open(&f, password("tunnelpw")).await.unwrap();
    let port = tunnel.local_port();
    drop(tunnel);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}
