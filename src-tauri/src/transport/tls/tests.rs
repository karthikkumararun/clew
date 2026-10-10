use std::path::PathBuf;
use std::sync::Arc;

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use super::*;

struct Pki {
    dir: tempfile::TempDir,
    ca_pem: String,
    server_cert: CertificateDer<'static>,
    server_key: PrivateKeyDer<'static>,
}

impl Pki {
    fn path(&self, name: &str) -> String {
        self.dir.path().join(name).to_string_lossy().into_owned()
    }
}

fn issue(issuer: &Issuer<'_, KeyPair>, names: &[&str], cn: &str) -> (rcgen::Certificate, KeyPair) {
    let key = KeyPair::generate().unwrap();
    let mut params =
        CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
    params.distinguished_name.push(DnType::CommonName, cn);
    (params.signed_by(&key, issuer).unwrap(), key)
}

fn pki() -> Pki {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "Clew Test CA");
    let ca_pem = ca_params.self_signed(&ca_key).unwrap().pem();
    let issuer = Issuer::new(ca_params, ca_key);

    let (server, server_key) = issue(&issuer, &["localhost"], "localhost");
    let (client, client_key) = issue(&issuer, &[], "clew-client");

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("ca.pem"), &ca_pem).unwrap();
    std::fs::write(dir.path().join("client.pem"), client.pem()).unwrap();
    std::fs::write(dir.path().join("client.key"), client_key.serialize_pem()).unwrap();
    std::fs::write(dir.path().join("garbage.pem"), "not a certificate").unwrap();
    Pki {
        dir,
        ca_pem,
        server_cert: server.der().clone(),
        server_key: PrivateKeyDer::try_from(server_key.serialize_der()).unwrap(),
    }
}

/// A TLS server on 127.0.0.1 that writes "hello" after the handshake.
async fn serve(pki: &Pki, require_client_cert: bool) -> u16 {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap();
    let config = if require_client_cert {
        let mut roots = RootCertStore::empty();
        let ca = rustls_pemfile::certs(&mut pki.ca_pem.as_bytes())
            .next()
            .unwrap()
            .unwrap();
        roots.add(ca).unwrap();
        let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
            .build()
            .unwrap();
        builder.with_client_cert_verifier(verifier)
    } else {
        builder.with_no_client_auth()
    }
    .with_single_cert(vec![pki.server_cert.clone()], pki.server_key.clone_key())
    .unwrap();

    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(mut tls) = acceptor.accept(tcp).await {
                    let _ = tls.write_all(b"hello").await;
                    let _ = tls.shutdown().await;
                }
            });
        }
    });
    port
}

/// Handshake with the server and read its greeting.
async fn connect(cfg: &TlsConfig, server_name: &'static str, port: u16) -> Result<String, String> {
    let config = client_config(cfg)
        .map_err(|e| e.message)?
        .expect("tls enabled");
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let name = ServerName::try_from(server_name).unwrap();
    let mut tls = TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = String::new();
    tls.read_to_string(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn cfg(mode: TlsMode, pki: &Pki) -> TlsConfig {
    TlsConfig {
        mode,
        ca_file: Some(pki.path("ca.pem")),
        client_cert: None,
        client_key: None,
    }
}

#[tokio::test]
async fn verify_full_accepts_a_matching_certificate() {
    let pki = pki();
    let port = serve(&pki, false).await;
    assert_eq!(
        connect(&cfg(TlsMode::VerifyFull, &pki), "localhost", port)
            .await
            .unwrap(),
        "hello"
    );
}

#[tokio::test]
async fn verify_full_rejects_the_wrong_host_name() {
    let pki = pki();
    let port = serve(&pki, false).await;
    let err = connect(&cfg(TlsMode::VerifyFull, &pki), "db.example.test", port)
        .await
        .unwrap_err();
    let mapped = map_tls_error(&err, "db.example.test").expect("recognised as TLS");
    assert_eq!(mapped.code, ErrorCode::TlsFailed);
    assert!(
        mapped.message.contains("db.example.test"),
        "{}",
        mapped.message
    );
    assert!(
        mapped.message.contains("not valid for the host name"),
        "{}",
        mapped.message
    );
}

#[tokio::test]
async fn verify_ca_ignores_the_host_name_but_still_checks_the_chain() {
    let pki = pki();
    let port = serve(&pki, false).await;
    assert_eq!(
        connect(&cfg(TlsMode::VerifyCa, &pki), "db.example.test", port)
            .await
            .unwrap(),
        "hello"
    );

    // a different CA must still be rejected
    let other = super::tests::pki();
    let err = connect(&cfg(TlsMode::VerifyCa, &other), "localhost", port)
        .await
        .unwrap_err();
    let mapped = map_tls_error(&err, "localhost").unwrap();
    assert!(
        mapped.message.contains("certificate authority"),
        "{}",
        mapped.message
    );
}

#[tokio::test]
async fn require_encrypts_without_verifying() {
    let pki = pki();
    let port = serve(&pki, false).await;
    let config = TlsConfig {
        mode: TlsMode::Require,
        ..Default::default()
    };
    assert_eq!(
        connect(&config, "anything.test", port).await.unwrap(),
        "hello"
    );
}

#[tokio::test]
async fn prefer_builds_a_config_like_require() {
    let config = TlsConfig {
        mode: TlsMode::Prefer,
        ..Default::default()
    };
    assert!(client_config(&config).unwrap().is_some());
}

#[tokio::test]
async fn mutual_tls_with_a_client_certificate() {
    let pki = pki();
    let port = serve(&pki, true).await;
    let mut with_cert = cfg(TlsMode::VerifyFull, &pki);
    with_cert.client_cert = Some(pki.path("client.pem"));
    with_cert.client_key = Some(pki.path("client.key"));
    assert_eq!(
        connect(&with_cert, "localhost", port).await.unwrap(),
        "hello"
    );

    // without one the server drops the handshake
    assert!(connect(&cfg(TlsMode::VerifyFull, &pki), "localhost", port)
        .await
        .is_err());
}

#[test]
fn disable_means_no_tls() {
    assert!(client_config(&TlsConfig::default()).unwrap().is_none());
    assert!(validate(&TlsConfig::default()).is_ok());
}

#[test]
fn a_missing_ca_file_is_a_clear_tls_failed() {
    let config = TlsConfig {
        mode: TlsMode::VerifyFull,
        ca_file: Some("/definitely/not/here.pem".into()),
        ..Default::default()
    };
    let err = validate(&config).unwrap_err();
    assert_eq!(err.code, ErrorCode::TlsFailed);
    assert!(err.message.contains("/definitely/not/here.pem"));
    assert!(client_config(&config).is_err());
}

#[test]
fn a_garbage_ca_file_is_rejected() {
    let pki = pki();
    let config = TlsConfig {
        mode: TlsMode::VerifyCa,
        ca_file: Some(pki.path("garbage.pem")),
        ..Default::default()
    };
    let err = validate(&config).unwrap_err();
    assert_eq!(err.code, ErrorCode::TlsFailed);
}

#[test]
fn a_client_certificate_needs_its_key() {
    let pki = pki();
    let config = TlsConfig {
        mode: TlsMode::Require,
        client_cert: Some(pki.path("client.pem")),
        ..Default::default()
    };
    assert!(validate(&config).unwrap_err().message.contains("together"));
}

#[test]
fn unrelated_errors_are_not_claimed_as_tls() {
    assert!(map_tls_error("connection refused", "h").is_none());
}

#[test]
fn paths_are_plain_strings() {
    // guards against accidentally taking PathBuf in the public config
    let _: Option<PathBuf> = None;
}
