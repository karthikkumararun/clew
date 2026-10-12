//! The only module that talks to the OS keychain (macOS Keychain, Windows Credential Manager).
//!
//! Secrets are stored under service `Clew` with account `<connection id>:<kind>` and are only ever
//! held in memory as [`Secret`], which is redacted in `Debug` and cannot be serialized.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::drivers::Secret;

pub const SERVICE: &str = "Clew";
/// Windows Credential Manager rejects secrets over 2560 bytes; refuse them everywhere so a
/// connection behaves the same on both platforms.
pub const MAX_SECRET_BYTES: usize = 2560;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    Password,
    SshPassphrase,
    SshPassword,
}

impl SecretKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::SshPassphrase => "ssh-passphrase",
            SecretKind::SshPassword => "ssh-password",
        }
    }

    pub const ALL: [SecretKind; 3] = [
        SecretKind::Password,
        SecretKind::SshPassphrase,
        SecretKind::SshPassword,
    ];
}

/// `<connection id>:<kind>`
pub fn account(connection_id: &str, kind: SecretKind) -> String {
    format!("{connection_id}:{}", kind.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    /// The keychain is locked, denied or missing.
    Unavailable(String),
    TooLarge,
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::Unavailable(_) => f.write_str("the keychain is not available"),
            SecretError::TooLarge => f.write_str("the secret is too large for the keychain"),
        }
    }
}

pub trait SecretStore: Send + Sync {
    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<Secret>, SecretError>;
    fn set(&self, connection_id: &str, kind: SecretKind, value: &Secret)
        -> Result<(), SecretError>;
    /// Deleting something that is not there is not an error.
    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), SecretError>;
}

/// The real keychain.
#[derive(Debug)]
pub struct KeyringStore {
    service: &'static str,
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self { service: SERVICE }
    }
}

impl KeyringStore {
    /// The real keychain under another service name. Only the end-to-end smoke suite uses this,
    /// so a test run never touches the user's own `Clew` items.
    #[cfg(feature = "e2e")]
    pub fn with_service(service: &'static str) -> Self {
        Self { service }
    }

    fn entry(&self, connection_id: &str, kind: SecretKind) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(self.service, &account(connection_id, kind))
            .map_err(|e| SecretError::Unavailable(e.to_string()))
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<Secret>, SecretError> {
        match self.entry(connection_id, kind)?.get_password() {
            Ok(p) => Ok(Some(Secret::new(p))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Unavailable(e.to_string())),
        }
    }

    fn set(
        &self,
        connection_id: &str,
        kind: SecretKind,
        value: &Secret,
    ) -> Result<(), SecretError> {
        if value.expose().len() > MAX_SECRET_BYTES {
            return Err(SecretError::TooLarge);
        }
        self.entry(connection_id, kind)?
            .set_password(value.expose())
            .map_err(|e| SecretError::Unavailable(e.to_string()))
    }

    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), SecretError> {
        match self.entry(connection_id, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Unavailable(e.to_string())),
        }
    }
}

/// In-memory store for tests, with a switch to simulate a locked keychain.
#[derive(Default)]
pub struct MemoryStore {
    items: Mutex<HashMap<String, String>>,
    pub locked: std::sync::atomic::AtomicBool,
}

impl std::fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never print the contents
        f.debug_struct("MemoryStore")
            .field("items", &self.items.lock().unwrap().len())
            .finish()
    }
}

impl MemoryStore {
    pub fn lock(&self, locked: bool) {
        self.locked
            .store(locked, std::sync::atomic::Ordering::SeqCst);
    }

    fn check(&self) -> Result<(), SecretError> {
        if self.locked.load(std::sync::atomic::Ordering::SeqCst) {
            Err(SecretError::Unavailable("keychain locked".into()))
        } else {
            Ok(())
        }
    }

    pub fn len(&self) -> usize {
        self.items.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<Secret>, SecretError> {
        self.check()?;
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(&account(connection_id, kind))
            .map(|v| Secret::new(v.clone())))
    }

    fn set(
        &self,
        connection_id: &str,
        kind: SecretKind,
        value: &Secret,
    ) -> Result<(), SecretError> {
        self.check()?;
        if value.expose().len() > MAX_SECRET_BYTES {
            return Err(SecretError::TooLarge);
        }
        self.items
            .lock()
            .unwrap()
            .insert(account(connection_id, kind), value.expose().to_string());
        Ok(())
    }

    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), SecretError> {
        self.check()?;
        self.items
            .lock()
            .unwrap()
            .remove(&account(connection_id, kind));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_connection_id_and_kind() {
        assert_eq!(account("c_01", SecretKind::Password), "c_01:password");
        assert_eq!(
            account("c_01", SecretKind::SshPassphrase),
            "c_01:ssh-passphrase"
        );
        assert_eq!(
            account("c_01", SecretKind::SshPassword),
            "c_01:ssh-password"
        );
    }

    #[test]
    fn memory_store_round_trips() {
        let s = MemoryStore::default();
        assert_eq!(s.get("c", SecretKind::Password).unwrap(), None);
        s.set("c", SecretKind::Password, &Secret::new("pw"))
            .unwrap();
        assert_eq!(
            s.get("c", SecretKind::Password).unwrap().unwrap().expose(),
            "pw"
        );
        s.delete("c", SecretKind::Password).unwrap();
        assert_eq!(s.get("c", SecretKind::Password).unwrap(), None);
        s.delete("c", SecretKind::Password).unwrap(); // already gone
    }

    #[test]
    fn a_locked_keychain_reports_unavailable() {
        let s = MemoryStore::default();
        s.lock(true);
        assert!(matches!(
            s.set("c", SecretKind::Password, &Secret::new("x")),
            Err(SecretError::Unavailable(_))
        ));
        assert!(matches!(
            s.get("c", SecretKind::Password),
            Err(SecretError::Unavailable(_))
        ));
    }

    #[test]
    fn oversized_secrets_are_refused() {
        let s = MemoryStore::default();
        let big = Secret::new("x".repeat(MAX_SECRET_BYTES + 1));
        assert_eq!(
            s.set("c", SecretKind::Password, &big),
            Err(SecretError::TooLarge)
        );
        assert!(s
            .set(
                "c",
                SecretKind::Password,
                &Secret::new("x".repeat(MAX_SECRET_BYTES))
            )
            .is_ok());
    }

    #[test]
    fn debug_output_never_contains_secrets() {
        let s = MemoryStore::default();
        s.set("c", SecretKind::Password, &Secret::new("hunter2"))
            .unwrap();
        assert!(!format!("{s:?}").contains("hunter2"));
        assert!(!format!("{:?}", Secret::new("hunter2")).contains("hunter2"));
        assert!(!format!("{}", SecretError::Unavailable("hunter2".into())).contains("hunter2"));
    }
}
