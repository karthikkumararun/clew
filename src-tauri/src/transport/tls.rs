//! TLS options for network drivers.
//!
//! sqlx-based drivers hand the mode and file paths to sqlx (see [`validate`] for the up-front
//! checks and [`map_tls_error`] for turning handshake failures into `tls_failed`). Drivers that
//! use rustls directly build a client config with [`client_config`].

use std::fs;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error as TlsError, RootCertStore,
    SignatureScheme,
};

use crate::drivers::{DriverError, DriverResult, ErrorCode, TlsConfig, TlsMode};

fn tls_failed(message: impl Into<String>) -> DriverError {
    DriverError::new(ErrorCode::TlsFailed, message)
}

fn read_pem(path: &str, what: &str) -> DriverResult<Vec<u8>> {
    fs::read(path).map_err(|e| {
        tls_failed(format!("Could not read the {what} file {path}")).with_detail(e.to_string())
    })
}

fn parse_certs(pem: &[u8], path: &str, what: &str) -> DriverResult<Vec<CertificateDer<'static>>> {
    let certs: Vec<_> = rustls_pemfile::certs(&mut &pem[..])
        .collect::<Result<_, _>>()
        .map_err(|e| {
            tls_failed(format!(
                "The {what} file {path} is not a valid PEM certificate"
            ))
            .with_detail(e.to_string())
        })?;
    if certs.is_empty() {
        return Err(tls_failed(format!(
            "The {what} file {path} contains no certificates"
        )));
    }
    Ok(certs)
}

fn parse_key(pem: &[u8], path: &str) -> DriverResult<PrivateKeyDer<'static>> {
    rustls_pemfile::private_key(&mut &pem[..])
        .map_err(|e| {
            tls_failed(format!("The client key file {path} is not a valid PEM key"))
                .with_detail(e.to_string())
        })?
        .ok_or_else(|| {
            tls_failed(format!(
                "The client key file {path} contains no private key"
            ))
        })
}

/// Check that every configured file exists and parses, so problems surface with a clear message
/// before any connection is attempted.
pub fn validate(cfg: &TlsConfig) -> DriverResult<()> {
    if cfg.mode == TlsMode::Disable {
        return Ok(());
    }
    if let Some(ca) = &cfg.ca_file {
        parse_certs(&read_pem(ca, "CA certificate")?, ca, "CA certificate")?;
    }
    match (&cfg.client_cert, &cfg.client_key) {
        (Some(cert), Some(key)) => {
            parse_certs(
                &read_pem(cert, "client certificate")?,
                cert,
                "client certificate",
            )?;
            parse_key(&read_pem(key, "client key")?, key)?;
        }
        (None, None) => {}
        _ => {
            return Err(tls_failed(
                "A client certificate and a client key must be given together",
            ))
        }
    }
    Ok(())
}

/// Trust roots: the CA file when given, otherwise the OS trust store.
pub fn load_roots(ca_file: Option<&str>) -> DriverResult<RootCertStore> {
    let mut roots = RootCertStore::empty();
    match ca_file {
        Some(path) => {
            for cert in parse_certs(&read_pem(path, "CA certificate")?, path, "CA certificate")? {
                roots.add(cert).map_err(|e| {
                    tls_failed(format!("Invalid CA certificate in {path}"))
                        .with_detail(e.to_string())
                })?;
            }
        }
        None => {
            let native = rustls_native_certs::load_native_certs();
            for cert in native.certs {
                let _ = roots.add(cert);
            }
            if roots.is_empty() {
                return Err(tls_failed(
                    "No trusted CA certificates were found in the operating system",
                )
                .with_hint("Provide a CA certificate file in the connection's TLS settings"));
            }
        }
    }
    Ok(roots)
}

/// `verify-ca`: the chain must be trusted, but the certificate need not match the host name.
#[derive(Debug)]
struct CaOnlyVerifier(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for CaOnlyVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
        {
            Err(TlsError::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

/// `require`: encrypt, but trust whatever certificate the server presents.
#[derive(Debug)]
struct AcceptAnyVerifier(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyVerifier {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Make `ring` the process-wide default. Clew's own TLS code names its provider explicitly, but
/// reqwest and tiberius bring `aws-lc-rs` along, and with two compiled in rustls refuses to guess
/// for code that doesn't name one.
pub fn install_default_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// A rustls client config for the given options, or `None` when TLS is disabled. `prefer` is
/// returned as a config too: the driver decides whether to fall back to plaintext on failure.
pub fn client_config(cfg: &TlsConfig) -> DriverResult<Option<Arc<ClientConfig>>> {
    if cfg.mode == TlsMode::Disable {
        return Ok(None);
    }
    validate(cfg)?;
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| tls_failed("Could not set up TLS").with_detail(e.to_string()))?;

    let builder = match cfg.mode {
        TlsMode::Disable => unreachable!(),
        TlsMode::Prefer | TlsMode::Require => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyVerifier(provider))),
        TlsMode::VerifyCa | TlsMode::VerifyFull => {
            let roots = Arc::new(load_roots(cfg.ca_file.as_deref())?);
            let webpki = WebPkiServerVerifier::builder_with_provider(roots.clone(), provider)
                .build()
                .map_err(|e| {
                    tls_failed("Could not set up certificate verification")
                        .with_detail(e.to_string())
                })?;
            if cfg.mode == TlsMode::VerifyCa {
                builder
                    .dangerous()
                    .with_custom_certificate_verifier(Arc::new(CaOnlyVerifier(webpki)))
            } else {
                builder.with_webpki_verifier(webpki)
            }
        }
    };

    let config = match (&cfg.client_cert, &cfg.client_key) {
        (Some(cert), Some(key)) => {
            let certs = parse_certs(
                &read_pem(cert, "client certificate")?,
                cert,
                "client certificate",
            )?;
            let key = parse_key(&read_pem(key, "client key")?, key)?;
            builder.with_client_auth_cert(certs, key).map_err(|e| {
                tls_failed("The client certificate and key do not match").with_detail(e.to_string())
            })?
        }
        _ => builder.with_no_client_auth(),
    };
    Ok(Some(Arc::new(config)))
}

/// Turn a handshake / driver error text into a `tls_failed` error that names the problem.
/// Returns `None` when the text does not look TLS-related.
pub fn map_tls_error(text: &str, host: &str) -> Option<DriverError> {
    let lower = text.to_ascii_lowercase();
    let message = if lower.contains("notvalidforname") || lower.contains("not valid for name") {
        format!("The server certificate is not valid for the host name \"{host}\" (certificate name mismatch)")
    } else if lower.contains("unknownissuer") || lower.contains("unknown issuer") {
        "The server certificate was issued by an unknown certificate authority".to_string()
    } else if lower.contains("badsignature") || lower.contains("bad signature") {
        "The server certificate is not signed by the trusted certificate authority".to_string()
    } else if lower.contains("expired") {
        "The server certificate has expired".to_string()
    } else if lower.contains("notvalidyet") || lower.contains("not valid yet") {
        "The server certificate is not valid yet".to_string()
    } else if lower.contains("certificate") || lower.contains("tls") || lower.contains("ssl") {
        "The TLS connection could not be established".to_string()
    } else {
        return None;
    };
    Some(tls_failed(message).with_detail(text.to_string()))
}

#[cfg(test)]
mod tests;
