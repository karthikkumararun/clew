//! DataGrip's saved passwords: its Password Safe keeps them either in the OS keychain or in a
//! KeePass database (`c.kdbx`). Both are read-only here and only when the user asks.
//!
//! Entry naming follows the IntelliJ Platform's `CredentialAttributes`: the service name is
//! `IntelliJ Platform DB — <data source uuid>` and the account is the user name. That naming has
//! not been confirmed against a real install yet (see the change's design notes), so lookups are
//! tolerant (KeePass entries match on the uuid appearing in the title) and anything not found is
//! reported as "password not imported" rather than guessed.

use std::path::{Path, PathBuf};

use super::xml::parse;

pub fn service_name(data_source_uuid: &str) -> String {
    format!("IntelliJ Platform DB — {data_source_uuid}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provider {
    /// The OS keychain ("In native Keychain").
    Keychain,
    /// A KeePass database ("In KeePass").
    KeePass { path: PathBuf },
    /// "Do not save, forget passwords after restart".
    DoNotSave,
}

/// Which Password Safe mode DataGrip's `options/security.xml` selects. When it says nothing the
/// platform default applies: KeePass on Windows, the native keychain elsewhere.
pub fn provider(config_dir: &Path) -> Provider {
    let default_db = config_dir.join("c.kdbx");
    let platform_default = if cfg!(windows) {
        Provider::KeePass {
            path: default_db.clone(),
        }
    } else {
        Provider::Keychain
    };
    let Ok(text) = std::fs::read_to_string(config_dir.join("options/security.xml")) else {
        return platform_default;
    };
    let Ok(root) = parse(&text) else {
        return platform_default;
    };
    let option = |name: &str| {
        root.find_all("option")
            .into_iter()
            .find(|o| o.attr("name") == Some(name))
            .and_then(|o| o.attr("value").map(str::to_string))
    };
    match option("PROVIDER").as_deref() {
        Some("KEEPASS") => Provider::KeePass {
            path: option("keepassDb")
                .or_else(|| option("KEEPASS_DB_FILE"))
                .map(PathBuf::from)
                .unwrap_or(default_db),
        },
        Some("MAIN_KEYCHAIN") => Provider::Keychain,
        Some("MEMORY_ONLY") => Provider::DoNotSave,
        _ => platform_default,
    }
}

pub trait PasswordLookup {
    fn password(&self, data_source_uuid: &str, user: Option<&str>) -> Option<String>;
}

/// DataGrip's entries in the OS keychain (macOS asks the user to allow each read).
pub struct KeychainLookup;

impl PasswordLookup for KeychainLookup {
    #[cfg(target_os = "macos")]
    fn password(&self, data_source_uuid: &str, user: Option<&str>) -> Option<String> {
        let bytes = security_framework::passwords::get_generic_password(
            &service_name(data_source_uuid),
            user.unwrap_or(""),
        )
        .ok()?;
        String::from_utf8(bytes).ok().filter(|p| !p.is_empty())
    }

    #[cfg(not(target_os = "macos"))]
    fn password(&self, _data_source_uuid: &str, _user: Option<&str>) -> Option<String> {
        None
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeePassError {
    Missing,
    WrongPassword,
    Other(String),
}

/// The passwords of an unlocked KeePass database, held in memory only for the import.
pub struct KeePassLookup {
    /// (title, user name, password)
    entries: Vec<(String, String, String)>,
}

impl Drop for KeePassLookup {
    fn drop(&mut self) {
        for (_, _, p) in &mut self.entries {
            zeroize::Zeroize::zeroize(p);
        }
    }
}

impl KeePassLookup {
    /// Open the database read-only with the master password.
    pub fn open(path: &Path, master_password: &str) -> Result<Self, KeePassError> {
        let mut file = std::fs::File::open(path).map_err(|_| KeePassError::Missing)?;
        let key = keepass::DatabaseKey::new().with_password(master_password);
        let db = keepass::Database::open(&mut file, key).map_err(|e| {
            let text = e.to_string().to_ascii_lowercase();
            if text.contains("key")
                || text.contains("hmac")
                || text.contains("decrypt")
                || text.contains("password")
            {
                KeePassError::WrongPassword
            } else {
                KeePassError::Other(e.to_string())
            }
        })?;
        let mut entries = Vec::new();
        fn walk(group: keepass::db::GroupRef<'_>, out: &mut Vec<(String, String, String)>) {
            for e in group.entries() {
                out.push((
                    e.get_title().unwrap_or_default().to_string(),
                    e.get_username().unwrap_or_default().to_string(),
                    e.get_password().unwrap_or_default().to_string(),
                ));
            }
            for g in group.groups() {
                walk(g, out);
            }
        }
        walk(db.root(), &mut entries);
        Ok(Self { entries })
    }
}

impl PasswordLookup for KeePassLookup {
    fn password(&self, data_source_uuid: &str, user: Option<&str>) -> Option<String> {
        let matches: Vec<_> = self
            .entries
            .iter()
            .filter(|(title, _, pw)| title.contains(data_source_uuid) && !pw.is_empty())
            .collect();
        matches
            .iter()
            .find(|(_, u, _)| Some(u.as_str()) == user)
            .or_else(|| matches.first())
            .map(|(_, _, pw)| pw.clone())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A lookup backed by a map, for import tests.
    pub struct Fake(pub std::collections::BTreeMap<String, String>);

    impl PasswordLookup for Fake {
        fn password(&self, uuid: &str, _user: Option<&str>) -> Option<String> {
            self.0.get(uuid).cloned()
        }
    }

    fn write_security(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir.join("options")).unwrap();
        std::fs::write(dir.join("options/security.xml"), body).unwrap();
    }

    #[test]
    fn reads_the_password_safe_mode() {
        let dir = tempfile::tempdir().unwrap();
        write_security(
            dir.path(),
            r#"<application><component name="PasswordSafe"><option name="PROVIDER" value="KEEPASS" /></component></application>"#,
        );
        assert_eq!(
            provider(dir.path()),
            Provider::KeePass {
                path: dir.path().join("c.kdbx")
            }
        );

        write_security(
            dir.path(),
            r#"<application><component name="PasswordSafe"><option name="PROVIDER" value="KEEPASS" /><option name="keepassDb" value="/x/db.kdbx" /></component></application>"#,
        );
        assert_eq!(
            provider(dir.path()),
            Provider::KeePass {
                path: PathBuf::from("/x/db.kdbx")
            }
        );

        write_security(
            dir.path(),
            r#"<application><component name="PasswordSafe"><option name="PROVIDER" value="MEMORY_ONLY" /></component></application>"#,
        );
        assert_eq!(provider(dir.path()), Provider::DoNotSave);

        write_security(
            dir.path(),
            r#"<application><component name="PasswordSafe"><option name="PROVIDER" value="MAIN_KEYCHAIN" /></component></application>"#,
        );
        assert_eq!(provider(dir.path()), Provider::Keychain);
    }

    #[test]
    fn without_security_xml_the_platform_default_applies() {
        let dir = tempfile::tempdir().unwrap();
        let expected = if cfg!(windows) {
            Provider::KeePass {
                path: dir.path().join("c.kdbx"),
            }
        } else {
            Provider::Keychain
        };
        assert_eq!(provider(dir.path()), expected);
    }

    fn build_kdbx(path: &Path, master: &str, entries: &[(&str, &str, &str)]) {
        let mut db = keepass::Database::new();
        for (title, user, pass) in entries {
            let mut root = db.root_mut();
            root.add_entry().edit(|e| {
                e.set_unprotected(keepass::db::fields::TITLE, *title);
                e.set_unprotected(keepass::db::fields::USERNAME, *user);
                e.set_protected(keepass::db::fields::PASSWORD, *pass);
            });
        }
        let mut file = std::fs::File::create(path).unwrap();
        db.save(&mut file, keepass::DatabaseKey::new().with_password(master))
            .unwrap();
    }

    /// (spec: connection-management › Passwords from DataGrip's KeePass database)
    #[test]
    fn keepass_lookup_matches_entries_by_data_source_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.kdbx");
        let uuid = "11111111-1111-1111-1111-111111111111";
        build_kdbx(
            &path,
            "master pw",
            &[
                (&service_name(uuid), "karthik", "db-secret"),
                (&service_name("other"), "x", "nope"),
            ],
        );
        let lookup = KeePassLookup::open(&path, "master pw").unwrap();
        assert_eq!(
            lookup.password(uuid, Some("karthik")).as_deref(),
            Some("db-secret")
        );
        assert_eq!(lookup.password("missing", None), None);
    }

    #[test]
    fn keepass_wrong_master_password_and_missing_file_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.kdbx");
        build_kdbx(&path, "right", &[("t", "u", "p")]);
        assert_eq!(
            KeePassLookup::open(&path, "wrong").err(),
            Some(KeePassError::WrongPassword)
        );
        assert_eq!(
            KeePassLookup::open(&dir.path().join("none.kdbx"), "x").err(),
            Some(KeePassError::Missing)
        );
    }
}
