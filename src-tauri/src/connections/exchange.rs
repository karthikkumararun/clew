//! The `.clew` export format: a small readable header plus a payload that is either plain JSON
//! (no secrets inside) or AES-256-GCM ciphertext under a key derived from a passphrase with
//! Argon2id. The header is authenticated as the cipher's associated data, so editing any of it
//! breaks decryption.

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::model::{Connection, Group};
use crate::error::AppError;

pub const FORMAT: &str = "clew-connections";
pub const VERSION: u32 = 1;
pub const MIN_PASSPHRASE_CHARS: usize = 12;

/// Argon2id cost stored in the header. Defaults are OWASP's second recommendation (64 MiB, 3
/// passes); the reader refuses anything wildly larger so a crafted file can't exhaust memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m: 65536,
            t: 3,
            p: 1,
        }
    }
}

const MAX_M: u32 = 262_144;
const MAX_T: u32 = 10;
const MAX_P: u32 = 8;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub connections: u32,
    pub passwords: u32,
    pub ssh_keys: u32,
    pub sql_files: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Encryption {
    pub cipher: String,
    pub kdf: String,
    pub salt: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub nonce: String,
    /// Lets the reader tell a wrong passphrase from a damaged file.
    pub key_check: String,
}

/// Everything but the payload: what is readable without the passphrase, and the AAD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub app: String,
    pub counts: Counts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<Encryption>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileDoc {
    #[serde(flatten)]
    header: Header,
    /// Base64 ciphertext+tag when encrypted, the payload object itself when plain.
    payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyFile {
    pub connection_id: String,
    pub file_name: String,
    pub pem: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFile {
    pub connection_id: String,
    pub rel_path: String,
    pub content: String,
}

/// What an export file carries. `secrets` is keyed `<connection id>:<kind>`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub secrets: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub ssh_keys: Vec<SshKeyFile>,
    #[serde(default)]
    pub sql_files: Vec<SqlFile>,
}

impl ExportPayload {
    pub fn has_secrets(&self) -> bool {
        !self.secrets.is_empty() || !self.ssh_keys.is_empty()
    }

    pub fn counts(&self) -> Counts {
        Counts {
            connections: self.connections.len() as u32,
            passwords: self.secrets.len() as u32,
            ssh_keys: self.ssh_keys.len() as u32,
            sql_files: self.sql_files.len() as u32,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExchangeError {
    NotAClewFile,
    /// The file's version is newer than [`VERSION`].
    Newer(u32),
    NeedsPassphrase,
    WrongPassphrase,
    Damaged,
    WeakPassphrase,
    Invalid(String),
}

impl From<ExchangeError> for AppError {
    fn from(e: ExchangeError) -> Self {
        match e {
            ExchangeError::NotAClewFile => {
                AppError::new("not_clew_file", "This isn't a Clew connections file")
            }
            ExchangeError::Newer(v) => AppError::new(
                "newer_format",
                format!("This file was made by a newer Clew (format version {v}). Update Clew to import it."),
            ),
            ExchangeError::NeedsPassphrase => {
                AppError::new("needs_passphrase", "This file is encrypted; enter its passphrase")
            }
            ExchangeError::WrongPassphrase => {
                AppError::new("wrong_passphrase", "That passphrase doesn't unlock this file")
            }
            ExchangeError::Damaged => AppError::new(
                "damaged_file",
                "This file is damaged or was changed after export",
            ),
            ExchangeError::WeakPassphrase => AppError::new(
                "weak_passphrase",
                format!("Use a passphrase of at least {MIN_PASSPHRASE_CHARS} characters"),
            ),
            ExchangeError::Invalid(m) => AppError::new("invalid_file", m),
        }
    }
}

fn aad(header: &Header) -> Vec<u8> {
    // Struct field order is fixed, so this serialization is stable for a given header.
    serde_json::to_vec(header).expect("header serializes")
}

fn derive(
    passphrase: &str,
    salt: &[u8],
    p: KdfParams,
) -> Result<Zeroizing<[u8; 64]>, ExchangeError> {
    if p.m > MAX_M || p.t > MAX_T || p.p > MAX_P || p.m < 8 || p.t < 1 || p.p < 1 {
        return Err(ExchangeError::Invalid(
            "Unsupported key-derivation settings".into(),
        ));
    }
    let params =
        Params::new(p.m, p.t, p.p, Some(64)).map_err(|e| ExchangeError::Invalid(e.to_string()))?;
    let mut out = Zeroizing::new([0u8; 64]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, out.as_mut())
        .map_err(|e| ExchangeError::Invalid(e.to_string()))?;
    Ok(out)
}

fn key_check(material: &[u8; 64]) -> String {
    B64.encode(Sha256::digest(&material[32..]))
}

/// Build the file text. Encrypts when `passphrase` is given (required if the payload has secrets).
pub fn write_export(
    payload: &ExportPayload,
    app: &str,
    created_at: &str,
    passphrase: Option<&str>,
    kdf: KdfParams,
) -> Result<String, ExchangeError> {
    let counts = payload.counts();
    let json = Zeroizing::new(
        serde_json::to_vec(payload).map_err(|e| ExchangeError::Invalid(e.to_string()))?,
    );
    let mut header = Header {
        format: FORMAT.into(),
        version: VERSION,
        created_at: created_at.into(),
        app: app.into(),
        counts,
        encryption: None,
    };

    let body = match passphrase {
        None if payload.has_secrets() => return Err(ExchangeError::WeakPassphrase),
        None => serde_json::from_slice::<serde_json::Value>(&json)
            .map_err(|e| ExchangeError::Invalid(e.to_string()))?,
        Some(pass) => {
            if pass.chars().count() < MIN_PASSPHRASE_CHARS {
                return Err(ExchangeError::WeakPassphrase);
            }
            let mut salt = [0u8; 16];
            let mut nonce = [0u8; 12];
            OsRng.fill_bytes(&mut salt);
            OsRng.fill_bytes(&mut nonce);
            let material = derive(pass, &salt, kdf)?;
            header.encryption = Some(Encryption {
                cipher: "AES-256-GCM".into(),
                kdf: "argon2id".into(),
                salt: B64.encode(salt),
                m: kdf.m,
                t: kdf.t,
                p: kdf.p,
                nonce: B64.encode(nonce),
                key_check: key_check(&material),
            });
            let cipher = Aes256Gcm::new_from_slice(&material[..32])
                .map_err(|e| ExchangeError::Invalid(e.to_string()))?;
            let ciphertext = cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &json,
                        aad: &aad(&header),
                    },
                )
                .map_err(|_| ExchangeError::Invalid("Encryption failed".into()))?;
            serde_json::Value::String(B64.encode(ciphertext))
        }
    };

    serde_json::to_string_pretty(&FileDoc {
        header,
        payload: body,
    })
    .map_err(|e| ExchangeError::Invalid(e.to_string()))
}

/// What can be read about a file without unlocking it.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub encrypted: bool,
    pub created_at: String,
    pub app: String,
    pub counts: Counts,
}

fn parse(text: &str) -> Result<FileDoc, ExchangeError> {
    let doc: FileDoc = serde_json::from_str(text).map_err(|_| ExchangeError::NotAClewFile)?;
    if doc.header.format != FORMAT {
        return Err(ExchangeError::NotAClewFile);
    }
    if doc.header.version > VERSION {
        return Err(ExchangeError::Newer(doc.header.version));
    }
    Ok(doc)
}

pub fn inspect(text: &str) -> Result<FileInfo, ExchangeError> {
    let doc = parse(text)?;
    Ok(FileInfo {
        encrypted: doc.header.encryption.is_some(),
        created_at: doc.header.created_at,
        app: doc.header.app,
        counts: doc.header.counts,
    })
}

/// Read the payload, unlocking it with `passphrase` when the file is encrypted.
pub fn read_export(text: &str, passphrase: Option<&str>) -> Result<ExportPayload, ExchangeError> {
    let doc = parse(text)?;
    let Some(enc) = doc.header.encryption.clone() else {
        return serde_json::from_value(doc.payload)
            .map_err(|e| ExchangeError::Invalid(e.to_string()));
    };
    let pass = passphrase.ok_or(ExchangeError::NeedsPassphrase)?;
    if enc.cipher != "AES-256-GCM" || enc.kdf != "argon2id" {
        return Err(ExchangeError::Invalid("Unsupported encryption".into()));
    }
    let decode = |s: &str| B64.decode(s).map_err(|_| ExchangeError::Damaged);
    let salt = decode(&enc.salt)?;
    let nonce = decode(&enc.nonce)?;
    if nonce.len() != 12 {
        return Err(ExchangeError::Damaged);
    }
    let ciphertext = decode(doc.payload.as_str().ok_or(ExchangeError::Damaged)?)?;
    let material = derive(
        pass,
        &salt,
        KdfParams {
            m: enc.m,
            t: enc.t,
            p: enc.p,
        },
    )?;
    if key_check(&material) != enc.key_check {
        return Err(ExchangeError::WrongPassphrase);
    }
    let cipher = Aes256Gcm::new_from_slice(&material[..32])
        .map_err(|e| ExchangeError::Invalid(e.to_string()))?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad(&doc.header),
                },
            )
            .map_err(|_| ExchangeError::Damaged)?,
    );
    serde_json::from_slice(&plain).map_err(|e| ExchangeError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::store::tests::conn;

    const FAST: KdfParams = KdfParams { m: 64, t: 1, p: 1 };
    const PASS: &str = "correct horse battery";

    fn payload() -> ExportPayload {
        let mut p = ExportPayload {
            connections: vec![conn("c1", "prod-postgres"), conn("c2", "staging")],
            ..Default::default()
        };
        p.secrets.insert("c1:password".into(), "s3cret-pw".into());
        p.ssh_keys.push(SshKeyFile {
            connection_id: "c1".into(),
            file_name: "id_ed25519".into(),
            pem: "-----BEGIN KEY-----\nTOPSECRETKEYMATERIAL\n-----END KEY-----".into(),
        });
        p.sql_files.push(SqlFile {
            connection_id: "c1".into(),
            rel_path: "a.sql".into(),
            content: "select 1;".into(),
        });
        p
    }

    fn encrypted() -> String {
        write_export(
            &payload(),
            "Clew 0.1.0",
            "2026-10-10T09:00:00Z",
            Some(PASS),
            FAST,
        )
        .unwrap()
    }

    #[test]
    fn round_trips_through_the_passphrase() {
        let text = encrypted();
        assert_eq!(read_export(&text, Some(PASS)).unwrap(), payload());
    }

    #[test]
    fn only_a_small_header_is_readable_and_no_secret_leaks() {
        let text = encrypted();
        for needle in [
            "s3cret-pw",
            "TOPSECRETKEYMATERIAL",
            "prod-postgres",
            "select 1",
        ] {
            assert!(!text.contains(needle), "{needle} visible in the file");
        }
        let info = inspect(&text).unwrap();
        assert!(info.encrypted);
        assert_eq!(
            info.counts,
            Counts {
                connections: 2,
                passwords: 1,
                ssh_keys: 1,
                sql_files: 1
            }
        );
        assert_eq!(info.app, "Clew 0.1.0");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["encryption"]["kdf"], "argon2id");
        assert_eq!(v["encryption"]["cipher"], "AES-256-GCM");
    }

    #[test]
    fn a_wrong_passphrase_is_reported_as_such() {
        assert_eq!(
            read_export(&encrypted(), Some("not the passphrase")).unwrap_err(),
            ExchangeError::WrongPassphrase
        );
        assert_eq!(
            read_export(&encrypted(), None).unwrap_err(),
            ExchangeError::NeedsPassphrase
        );
    }

    #[test]
    fn editing_the_header_or_the_ciphertext_breaks_authentication() {
        let text = encrypted();
        let tampered_header = text.replace("\"passwords\": 1", "\"passwords\": 9");
        assert_ne!(tampered_header, text);
        assert_eq!(
            read_export(&tampered_header, Some(PASS)).unwrap_err(),
            ExchangeError::Damaged
        );

        let tampered_date = text.replace("2026-10-10T09:00:00Z", "2026-10-11T09:00:00Z");
        assert_eq!(
            read_export(&tampered_date, Some(PASS)).unwrap_err(),
            ExchangeError::Damaged
        );

        let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut raw = B64.decode(v["payload"].as_str().unwrap()).unwrap();
        raw[3] ^= 0x01;
        v["payload"] = serde_json::Value::String(B64.encode(raw));
        assert_eq!(
            read_export(&v.to_string(), Some(PASS)).unwrap_err(),
            ExchangeError::Damaged
        );
    }

    #[test]
    fn short_passphrases_are_refused_and_secrets_need_one() {
        assert_eq!(
            write_export(&payload(), "c", "t", Some("short"), FAST).unwrap_err(),
            ExchangeError::WeakPassphrase
        );
        assert_eq!(
            write_export(&payload(), "c", "t", None, FAST).unwrap_err(),
            ExchangeError::WeakPassphrase
        );
    }

    #[test]
    fn a_plain_export_is_readable_json_without_secrets() {
        let plain = ExportPayload {
            connections: vec![conn("c1", "dev")],
            ..Default::default()
        };
        let text = write_export(&plain, "Clew 0.1.0", "2026-10-10T09:00:00Z", None, FAST).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(v.get("encryption").is_none());
        assert_eq!(v["payload"]["connections"][0]["name"], "dev");
        assert!(!inspect(&text).unwrap().encrypted);
        assert_eq!(read_export(&text, None).unwrap(), plain);
    }

    #[test]
    fn newer_versions_and_foreign_files_are_rejected() {
        let text = encrypted().replace("\"version\": 1", "\"version\": 7");
        assert_eq!(
            read_export(&text, Some(PASS)).unwrap_err(),
            ExchangeError::Newer(7)
        );
        assert_eq!(
            inspect("{\"hello\": 1}").unwrap_err(),
            ExchangeError::NotAClewFile
        );
        assert_eq!(
            inspect("not json").unwrap_err(),
            ExchangeError::NotAClewFile
        );
    }

    #[test]
    fn absurd_kdf_costs_are_refused() {
        let text = encrypted().replace("\"m\": 64", "\"m\": 4000000");
        assert!(matches!(
            read_export(&text, Some(PASS)).unwrap_err(),
            ExchangeError::Invalid(_)
        ));
    }
}
