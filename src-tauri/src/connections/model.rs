//! The saved-connection model. Serialized to `connections.json`; it never contains secrets
//! (passwords and passphrases live in the OS keychain, see `secrets.rs`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::drivers::TlsMode;

pub const FILE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Local,
    Development,
    Staging,
    Production,
}

impl Environment {
    /// Safeguard defaults: production starts locked down, everything else is off.
    pub fn default_safeguards(self) -> Safeguards {
        let on = self == Environment::Production;
        Safeguards {
            read_only_by_default: on,
            confirm_writes: on,
            manual_commit: on,
        }
    }

    /// Guess an environment from a connection name (`analytics-prod` -> production).
    pub fn detect(name: &str) -> Environment {
        let n = name.to_ascii_lowercase();
        let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
        if has(&["prod", "prd"]) {
            Environment::Production
        } else if has(&["stag", "stg", "uat"]) {
            Environment::Staging
        } else if has(&["dev", "test"]) {
            Environment::Development
        } else {
            Environment::Local
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Safeguards {
    pub read_only_by_default: bool,
    pub confirm_writes: bool,
    pub manual_commit: bool,
}

/// Where the password comes from when connecting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum PasswordMode {
    /// Stored in the OS keychain.
    #[default]
    Keychain,
    /// Asked every time; held in memory for the session only.
    Ask,
    None,
}

/// How an Oracle connection names the database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OracleConnectBy {
    ServiceName { value: String },
    Sid { value: String },
    TnsAlias { value: String },
    EasyConnect { value: String },
}

/// Driver-specific settings, chosen by the driver's form kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Settings {
    #[serde(rename_all = "camelCase")]
    Network {
        host: String,
        port: u16,
        #[serde(default)]
        #[ts(optional)]
        database: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        user: Option<String>,
        #[serde(default)]
        password_mode: PasswordMode,
    },
    #[serde(rename_all = "camelCase")]
    Oracle {
        host: String,
        port: u16,
        connect_by: OracleConnectBy,
        #[serde(default)]
        #[ts(optional)]
        user: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        role: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        wallet_dir: Option<String>,
        #[serde(default)]
        password_mode: PasswordMode,
    },
    #[serde(rename_all = "camelCase")]
    File {
        path: String,
        #[serde(default)]
        create_if_missing: bool,
    },
    /// A driver URI (MongoDB).
    #[serde(rename_all = "camelCase")]
    Uri {
        uri: String,
        #[serde(default)]
        #[ts(optional)]
        user: Option<String>,
        #[serde(default)]
        password_mode: PasswordMode,
    },
    #[serde(rename_all = "camelCase")]
    Keyvalue {
        host: String,
        port: u16,
        #[serde(default)]
        db_index: u32,
        #[serde(default)]
        #[ts(optional)]
        user: Option<String>,
        #[serde(default)]
        password_mode: PasswordMode,
    },
    #[serde(rename_all = "camelCase")]
    Neo4j {
        /// `neo4j`, `neo4j+s`, `bolt`, `bolt+s`
        protocol: String,
        host: String,
        port: u16,
        #[serde(default)]
        #[ts(optional)]
        user: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        database: Option<String>,
        #[serde(default)]
        password_mode: PasswordMode,
    },
}

impl Settings {
    pub fn password_mode(&self) -> PasswordMode {
        match self {
            Settings::Network { password_mode, .. }
            | Settings::Oracle { password_mode, .. }
            | Settings::Uri { password_mode, .. }
            | Settings::Keyvalue { password_mode, .. }
            | Settings::Neo4j { password_mode, .. } => *password_mode,
            Settings::File { .. } => PasswordMode::None,
        }
    }

    pub fn user(&self) -> Option<&str> {
        match self {
            Settings::Network { user, .. }
            | Settings::Oracle { user, .. }
            | Settings::Uri { user, .. }
            | Settings::Keyvalue { user, .. }
            | Settings::Neo4j { user, .. } => user.as_deref(),
            Settings::File { .. } => None,
        }
    }

    pub fn database(&self) -> Option<&str> {
        match self {
            Settings::Network { database, .. } | Settings::Neo4j { database, .. } => {
                database.as_deref()
            }
            _ => None,
        }
    }

    /// Host and port, for settings that have them.
    pub fn address(&self) -> Option<(&str, u16)> {
        match self {
            Settings::Network { host, port, .. }
            | Settings::Oracle { host, port, .. }
            | Settings::Keyvalue { host, port, .. }
            | Settings::Neo4j { host, port, .. } => Some((host, *port)),
            Settings::File { .. } | Settings::Uri { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthKind {
    Agent,
    Key,
    Password,
}

/// SSH tunnel settings. The key *file path* is stored; passphrases and passwords are secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SshSettings {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuthKind,
    #[serde(default)]
    #[ts(optional)]
    pub key_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TlsSettings {
    #[serde(default)]
    pub mode: TlsMode,
    #[serde(default)]
    #[ts(optional)]
    pub ca_file: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub client_cert: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub client_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Advanced {
    #[serde(default = "default_connect_timeout")]
    #[ts(type = "number")]
    pub connect_timeout_sec: u64,
    /// 0 = no limit.
    #[serde(default)]
    #[ts(type = "number")]
    pub query_timeout_sec: u64,
    /// 0 = off.
    #[serde(default)]
    #[ts(type = "number")]
    pub keep_alive_sec: u64,
    /// Statements to run on every new session.
    #[serde(default)]
    pub on_connect: Vec<String>,
    /// Driver properties, e.g. `application_name`.
    #[serde(default)]
    pub properties: BTreeMap<String, String>,
}

fn default_connect_timeout() -> u64 {
    10
}

impl Default for Advanced {
    fn default() -> Self {
        Self {
            connect_timeout_sec: default_connect_timeout(),
            query_timeout_sec: 0,
            keep_alive_sec: 0,
            on_connect: vec![],
            properties: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub driver: String,
    #[serde(default)]
    #[ts(optional)]
    pub group_id: Option<String>,
    pub environment: Environment,
    pub settings: Settings,
    #[serde(default)]
    #[ts(optional)]
    pub ssh: Option<SshSettings>,
    #[serde(default)]
    pub tls: TlsSettings,
    #[serde(default)]
    pub advanced: Advanced,
    pub safeguards: Safeguards,
    #[serde(default)]
    #[ts(optional)]
    pub last_used_at: Option<String>,
    /// Folder for SQL files linked to this connection.
    #[serde(default)]
    #[ts(optional)]
    pub scripts_dir: Option<String>,
}

impl Connection {
    pub fn new_id() -> String {
        format!("c_{}", ulid::Ulid::generate())
    }

    pub fn new_group_id() -> String {
        format!("g_{}", ulid::Ulid::generate())
    }
}

/// The whole `connections.json` document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsFile {
    pub version: u32,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

impl Default for ConnectionsFile {
    fn default() -> Self {
        Self {
            version: FILE_VERSION,
            groups: vec![],
            connections: vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Connection {
        Connection {
            id: "c_1".into(),
            name: "prod-postgres".into(),
            driver: "postgres".into(),
            group_id: Some("g1".into()),
            environment: Environment::Production,
            settings: Settings::Network {
                host: "db.internal".into(),
                port: 5432,
                database: Some("analytics".into()),
                user: Some("karthik".into()),
                password_mode: PasswordMode::Keychain,
            },
            ssh: Some(SshSettings {
                enabled: true,
                host: "bastion.example.net".into(),
                port: 22,
                user: "karthik".into(),
                auth: SshAuthKind::Agent,
                key_file: None,
            }),
            tls: TlsSettings {
                mode: TlsMode::VerifyFull,
                ca_file: Some("~/certs/ca.pem".into()),
                ..Default::default()
            },
            advanced: Advanced::default(),
            safeguards: Environment::Production.default_safeguards(),
            last_used_at: None,
            scripts_dir: None,
        }
    }

    #[test]
    fn production_defaults_to_all_safeguards_on() {
        let s = Environment::Production.default_safeguards();
        assert!(s.read_only_by_default && s.confirm_writes && s.manual_commit);
    }

    #[test]
    fn other_environments_default_to_all_safeguards_off() {
        for env in [
            Environment::Local,
            Environment::Development,
            Environment::Staging,
        ] {
            let s = env.default_safeguards();
            assert!(
                !s.read_only_by_default && !s.confirm_writes && !s.manual_commit,
                "{env:?}"
            );
        }
    }

    #[test]
    fn environments_are_detected_from_names() {
        assert_eq!(
            Environment::detect("analytics-prod"),
            Environment::Production
        );
        assert_eq!(Environment::detect("PRD db"), Environment::Production);
        assert_eq!(Environment::detect("staging-mysql"), Environment::Staging);
        assert_eq!(Environment::detect("uat-1"), Environment::Staging);
        assert_eq!(Environment::detect("dev-mongo"), Environment::Development);
        assert_eq!(Environment::detect("test box"), Environment::Development);
        assert_eq!(Environment::detect("notes.sqlite"), Environment::Local);
        // production wins when several words match
        assert_eq!(
            Environment::detect("prod-dev-copy"),
            Environment::Production
        );
    }

    #[test]
    fn serializes_like_the_documented_format() {
        let json = serde_json::to_value(sample()).unwrap();
        assert_eq!(json["groupId"], "g1");
        assert_eq!(json["environment"], "production");
        assert_eq!(json["settings"]["kind"], "network");
        assert_eq!(json["settings"]["passwordMode"], "keychain");
        assert_eq!(json["ssh"]["auth"], "agent");
        assert_eq!(json["tls"]["mode"], "verify-full");
        assert_eq!(json["safeguards"]["readOnlyByDefault"], true);
        assert!(json.get("lastUsedAt").is_some() || json["lastUsedAt"].is_null());
    }

    #[test]
    fn round_trips_every_settings_kind() {
        let settings = vec![
            Settings::Network {
                host: "h".into(),
                port: 1,
                database: None,
                user: None,
                password_mode: PasswordMode::Ask,
            },
            Settings::Oracle {
                host: "ora".into(),
                port: 1521,
                connect_by: OracleConnectBy::ServiceName {
                    value: "REPORTS".into(),
                },
                user: Some("u".into()),
                role: Some("SYSDBA".into()),
                wallet_dir: None,
                password_mode: PasswordMode::Keychain,
            },
            Settings::File {
                path: "/tmp/x.sqlite".into(),
                create_if_missing: true,
            },
            Settings::Uri {
                uri: "mongodb://h/db".into(),
                user: None,
                password_mode: PasswordMode::None,
            },
            Settings::Keyvalue {
                host: "h".into(),
                port: 6379,
                db_index: 2,
                user: None,
                password_mode: PasswordMode::Keychain,
            },
            Settings::Neo4j {
                protocol: "neo4j+s".into(),
                host: "h".into(),
                port: 7687,
                user: Some("neo4j".into()),
                database: Some("db".into()),
                password_mode: PasswordMode::Keychain,
            },
        ];
        for s in settings {
            let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
            assert_eq!(back, s);
        }
    }

    #[test]
    fn a_minimal_hand_written_file_loads_with_defaults() {
        let json = r#"{ "version": 1, "connections": [{
            "id": "c1", "name": "x", "driver": "sqlite", "environment": "local",
            "settings": { "kind": "file", "path": "/tmp/x.db" },
            "safeguards": { "readOnlyByDefault": false, "confirmWrites": false, "manualCommit": false }
        }]}"#;
        let f: ConnectionsFile = serde_json::from_str(json).unwrap();
        assert_eq!(f.connections[0].advanced.connect_timeout_sec, 10);
        assert_eq!(f.connections[0].tls.mode, TlsMode::Disable);
        assert!(f.groups.is_empty());
    }

    #[test]
    fn ids_are_unique_and_prefixed() {
        let a = Connection::new_id();
        let b = Connection::new_id();
        assert!(a.starts_with("c_") && a != b);
        assert!(Connection::new_group_id().starts_with("g_"));
    }

    #[test]
    fn accessors_read_through_the_settings_kinds() {
        let s = sample().settings;
        assert_eq!(s.address(), Some(("db.internal", 5432)));
        assert_eq!(s.user(), Some("karthik"));
        assert_eq!(s.database(), Some("analytics"));
        assert_eq!(s.password_mode(), PasswordMode::Keychain);
        let f = Settings::File {
            path: "x".into(),
            create_if_missing: false,
        };
        assert_eq!(f.address(), None);
        assert_eq!(f.password_mode(), PasswordMode::None);
    }
}
