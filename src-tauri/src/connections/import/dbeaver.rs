//! DBeaver `data-sources.json` (a workspace's `.dbeaver/` folder). Passwords live in an encrypted
//! credentials file and are not read.

use serde_json::Value;

use super::jdbc::{driver_for_ref, parse_jdbc};
use crate::connections::model::{
    Advanced, Connection, Environment, PasswordMode, Settings, SshAuthKind, SshSettings,
    TlsSettings,
};

#[derive(Debug, Clone)]
pub struct DbeaverEntry {
    /// `None` for drivers Clew doesn't have.
    pub connection: Option<Connection>,
    pub name: String,
    pub driver_label: String,
    pub folder: Option<String>,
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| match x {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn environment(kind: Option<&str>, name: &str) -> Environment {
    match kind {
        Some("prod") => Environment::Production,
        Some("test") => Environment::Staging,
        Some("dev") => Environment::Development,
        _ => Environment::detect(name),
    }
}

fn from_parts(provider: &str, cfg: &Value) -> Option<(String, Settings, TlsSettings)> {
    let url = s(cfg, "url");
    if let Some(j) = url.as_deref().and_then(parse_jdbc) {
        return Some((j.driver, j.settings, j.tls));
    }
    let driver = driver_for_ref(provider)?.to_string();
    let settings = match driver.as_str() {
        "sqlite" | "duckdb" => Settings::File {
            path: s(cfg, "database").or(url)?,
            create_if_missing: false,
        },
        _ => Settings::Network {
            host: s(cfg, "host")?,
            port: s(cfg, "port")
                .and_then(|p| p.parse().ok())
                .or_else(|| crate::connections::url::default_port(&driver))?,
            database: s(cfg, "database"),
            user: s(cfg, "user"),
            password_mode: PasswordMode::Keychain,
        },
    };
    Some((driver, settings, TlsSettings::default()))
}

pub fn parse_dbeaver(text: &str) -> Result<Vec<DbeaverEntry>, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let connections = doc
        .get("connections")
        .and_then(Value::as_object)
        .ok_or("This isn't a DBeaver data-sources.json file")?;
    let mut out = Vec::new();
    for entry in connections.values() {
        let name = s(entry, "name").unwrap_or_else(|| "DBeaver connection".into());
        let provider = s(entry, "provider").unwrap_or_default();
        let cfg = entry.get("configuration").cloned().unwrap_or(Value::Null);
        let folder = s(entry, "folder");
        let label = s(entry, "driver").unwrap_or_else(|| provider.clone());
        let connection = from_parts(&provider, &cfg).map(|(driver, mut settings, tls)| {
            if let Some(u) = s(&cfg, "user") {
                if let Settings::Network { user, .. } | Settings::Keyvalue { user, .. } =
                    &mut settings
                {
                    *user = Some(u);
                }
            }
            let env = environment(s(&cfg, "type").as_deref(), &name);
            let ssh = cfg
                .pointer("/handlers/ssh_tunnel")
                .filter(|h| h.get("enabled").and_then(Value::as_bool).unwrap_or(false))
                .and_then(|h| h.get("properties"))
                .map(|p| SshSettings {
                    enabled: true,
                    host: s(p, "host").unwrap_or_default(),
                    port: s(p, "port").and_then(|x| x.parse().ok()).unwrap_or(22),
                    user: s(p, "user").unwrap_or_default(),
                    auth: match s(p, "authType").as_deref() {
                        Some("PUBLIC_KEY") => SshAuthKind::Key,
                        Some("AGENT") => SshAuthKind::Agent,
                        _ => SshAuthKind::Password,
                    },
                    key_file: s(p, "keyPath"),
                });
            Connection {
                id: String::new(),
                name: name.clone(),
                driver,
                group_id: None,
                environment: env,
                settings,
                ssh,
                tls,
                advanced: Advanced::default(),
                safeguards: env.default_safeguards(),
                last_used_at: None,
                scripts_dir: None,
            }
        });
        out.push(DbeaverEntry {
            connection,
            name,
            driver_label: label,
            folder,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "folders": {"Prod": {}},
      "connections": {
        "postgres-jdbc-1": {"provider": "postgresql", "driver": "postgres-jdbc", "name": "analytics-prod",
          "folder": "Prod",
          "configuration": {"host": "db.internal", "port": "5432", "database": "analytics",
            "url": "jdbc:postgresql://db.internal:5432/analytics", "type": "prod", "user": "karthik",
            "handlers": {"ssh_tunnel": {"type": "tunnel", "enabled": true,
              "properties": {"host": "bastion", "port": 2222, "authType": "PUBLIC_KEY", "keyPath": "~/.ssh/id", "user": "tunnel"}}}}},
        "mysql8-2": {"provider": "mysql", "driver": "mysql8", "name": "local-mysql",
          "configuration": {"host": "localhost", "port": "3306", "database": "app", "type": "dev"}},
        "sqlite-3": {"provider": "sqlite", "driver": "sqlite_jdbc", "name": "notes",
          "configuration": {"database": "/tmp/notes.db", "url": "jdbc:sqlite:/tmp/notes.db"}},
        "cass-4": {"provider": "cassandra", "driver": "cassandra", "name": "old-cassandra",
          "configuration": {"host": "cass-1", "port": "9042"}}
      }
    }"#;

    #[test]
    fn lists_connections_with_detected_drivers() {
        let e = parse_dbeaver(SAMPLE).unwrap();
        assert_eq!(e.len(), 4);
        let by = |n: &str| e.iter().find(|x| x.name == n).unwrap();
        let pg = by("analytics-prod").connection.as_ref().unwrap();
        assert_eq!(pg.driver, "postgres");
        assert_eq!(pg.environment, Environment::Production);
        assert_eq!(by("analytics-prod").folder.as_deref(), Some("Prod"));
        let ssh = pg.ssh.as_ref().unwrap();
        assert_eq!(
            (ssh.host.as_str(), ssh.port, ssh.auth),
            ("bastion", 2222, SshAuthKind::Key)
        );
        match &pg.settings {
            Settings::Network { user, .. } => assert_eq!(user.as_deref(), Some("karthik")),
            o => panic!("{o:?}"),
        }
        assert_eq!(
            by("local-mysql").connection.as_ref().unwrap().environment,
            Environment::Development
        );
        assert_eq!(by("notes").connection.as_ref().unwrap().driver, "sqlite");
        assert!(by("old-cassandra").connection.is_none());
    }

    #[test]
    fn rejects_other_json() {
        assert!(parse_dbeaver("{\"hello\": 1}").is_err());
        assert!(parse_dbeaver("nope").is_err());
    }
}
