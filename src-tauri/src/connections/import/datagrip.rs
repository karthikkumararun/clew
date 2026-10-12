//! DataGrip: discover its settings folders, read `dataSources.xml` (+ `.local.xml`, `sshConfigs.xml`),
//! and find each data source's consoles and scratch files.
//!
//! The file layouts here follow JetBrains' documented XML; the parsing is deliberately tolerant
//! (it looks for elements by name rather than by position) because layouts shift between versions.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::jdbc::{driver_for_ref, parse_jdbc};
use super::xml::{parse, Node};
use crate::connections::model::{
    Advanced, Connection, Environment, PasswordMode, Settings, SshAuthKind, SshSettings,
    TlsSettings,
};
use crate::drivers::TlsMode;

/// A DataGrip configuration folder found on this machine.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DataGripInstall {
    /// `DataGrip 2026.1`
    pub label: String,
    pub path: String,
}

fn version_key(name: &str) -> (u32, u32) {
    let digits = name.trim_start_matches(|c: char| !c.is_ascii_digit());
    let mut parts = digits.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// `DataGrip*` folders under a JetBrains settings root, newest first.
pub fn discover_in(root: &Path) -> Vec<DataGripInstall> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut found: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(n, _)| n.starts_with("DataGrip") && n.chars().any(|c| c.is_ascii_digit()))
        .collect();
    found.sort_by_key(|(name, _)| std::cmp::Reverse(version_key(name)));
    found
        .into_iter()
        .map(|(name, path)| DataGripInstall {
            label: format!("DataGrip {}", name.trim_start_matches("DataGrip")),
            path: path.to_string_lossy().into_owned(),
        })
        .collect()
}

/// Where DataGrip keeps its settings on this OS.
pub fn jetbrains_root() -> Option<PathBuf> {
    // End-to-end runs look in a fixture folder, never in the developer's real DataGrip settings.
    #[cfg(feature = "e2e")]
    if crate::testmode::active() {
        return crate::testmode::datagrip_root();
    }
    #[cfg(target_os = "macos")]
    {
        std::env::home_dir().map(|h| h.join("Library/Application Support/JetBrains"))
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("JetBrains"))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        std::env::home_dir().map(|h| h.join(".config/JetBrains"))
    }
}

pub fn discover() -> Vec<DataGripInstall> {
    jetbrains_root()
        .map(|r| discover_in(&r))
        .unwrap_or_default()
}

#[derive(Debug, Clone, Default)]
struct SshConfig {
    host: String,
    port: Option<u16>,
    user: String,
    auth: Option<SshAuthKind>,
    key_file: Option<String>,
}

fn auth_of(s: &str) -> Option<SshAuthKind> {
    match s.to_ascii_uppercase().as_str() {
        "PASSWORD" => Some(SshAuthKind::Password),
        "KEY_PAIR" | "KEY" | "PUBLIC_KEY" => Some(SshAuthKind::Key),
        "OPEN_SSH" | "AGENT" => Some(SshAuthKind::Agent),
        _ => None,
    }
}

/// `options/sshConfigs.xml`: `<sshConfig id host port username authType keyPath>`.
fn ssh_configs(config_dir: &Path) -> BTreeMap<String, SshConfig> {
    let mut out = BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(config_dir.join("options/sshConfigs.xml")) else {
        return out;
    };
    let Ok(root) = parse(&text) else { return out };
    for n in root.find_all("sshConfig") {
        let Some(id) = n.attr("id") else { continue };
        out.insert(
            id.to_string(),
            SshConfig {
                host: n.attr("host").unwrap_or_default().to_string(),
                port: n.attr("port").and_then(|p| p.parse().ok()),
                user: n.attr("username").unwrap_or_default().to_string(),
                auth: n.attr("authType").and_then(auth_of),
                key_file: n
                    .attr("keyPath")
                    .filter(|k| !k.is_empty())
                    .map(str::to_string),
            },
        );
    }
    out
}

/// One data source as DataGrip describes it.
#[derive(Debug, Clone)]
pub struct DataSource {
    pub uuid: String,
    pub name: String,
    pub group: Option<String>,
    pub driver_ref: Option<String>,
    pub jdbc_url: Option<String>,
    pub user: Option<String>,
    pub props: BTreeMap<String, String>,
    ssh: Option<Node>,
    ssl: Option<Node>,
}

fn data_source(n: &Node) -> DataSource {
    let mut props = BTreeMap::new();
    for p in n.find_all("property") {
        if let (Some(k), Some(v)) = (p.attr("name"), p.attr("value")) {
            props.insert(k.to_string(), v.to_string());
        }
    }
    DataSource {
        uuid: n.attr("uuid").unwrap_or_default().to_string(),
        name: n.attr("name").unwrap_or_default().to_string(),
        group: n
            .attr("group")
            .filter(|g| !g.is_empty())
            .map(str::to_string),
        driver_ref: n.child_text("driver-ref"),
        jdbc_url: n.child_text("jdbc-url"),
        user: n.child_text("user-name"),
        props,
        ssh: n.child("ssh-properties").cloned(),
        ssl: n.child("ssl-config").cloned(),
    }
}

fn read_sources(path: &Path) -> Vec<DataSource> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let Ok(root) = parse(&text) else {
        return vec![];
    };
    root.find_all("data-source")
        .into_iter()
        .map(data_source)
        .filter(|d| !d.uuid.is_empty() || !d.name.is_empty())
        .collect()
}

/// Data sources of a settings folder (global: `options/`) or a project (`.idea/`), with the
/// `.local.xml` details (user name, SSH) merged in.
pub fn read_data_sources(dir: &Path) -> Vec<DataSource> {
    let (shared, local) = if dir.join("options/dataSources.xml").exists()
        || dir.join("options/dataSources.local.xml").exists()
    {
        (
            dir.join("options/dataSources.xml"),
            dir.join("options/dataSources.local.xml"),
        )
    } else {
        (
            dir.join(".idea/dataSources.xml"),
            dir.join(".idea/dataSources.local.xml"),
        )
    };
    let mut sources = read_sources(&shared);
    for l in read_sources(&local) {
        match sources.iter_mut().find(|s| {
            (!l.uuid.is_empty() && s.uuid == l.uuid) || (l.uuid.is_empty() && s.name == l.name)
        }) {
            Some(s) => {
                if l.user.is_some() {
                    s.user = l.user;
                }
                if l.ssh.is_some() {
                    s.ssh = l.ssh;
                }
                if l.ssl.is_some() {
                    s.ssl = l.ssl;
                }
                s.props.extend(l.props);
            }
            None => sources.push(l),
        }
    }
    sources.retain(|s| s.jdbc_url.is_some() || s.driver_ref.is_some());
    sources
}

/// Everything learned about a data source that isn't part of [`Connection`].
#[derive(Debug, Clone, Default)]
pub struct Mapped {
    pub connection: Option<Connection>,
    pub password: Option<String>,
    pub password_moved_out_of_url: bool,
}

fn ssh_of(ds: &DataSource, configs: &BTreeMap<String, SshConfig>) -> Option<SshSettings> {
    let n = ds.ssh.as_ref()?;
    let enabled = n
        .child_text("enabled")
        .map(|e| e.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let referenced = n
        .child_text("ssh-config-id")
        .or_else(|| n.attr("ssh-config-id").map(str::to_string))
        .and_then(|id| configs.get(&id).cloned());
    let inline = SshConfig {
        host: n.child_text("host").unwrap_or_default(),
        port: n.child_text("port").and_then(|p| p.parse().ok()),
        user: n
            .child_text("user")
            .or_else(|| n.child_text("username"))
            .unwrap_or_default(),
        auth: n.child_text("auth-type").and_then(|a| auth_of(&a)),
        key_file: n.child_text("key-path"),
    };
    let cfg = referenced.unwrap_or(inline);
    if cfg.host.is_empty() {
        return None;
    }
    let auth = cfg.auth.unwrap_or(if cfg.key_file.is_some() {
        SshAuthKind::Key
    } else {
        SshAuthKind::Agent
    });
    Some(SshSettings {
        enabled,
        host: cfg.host,
        port: cfg.port.unwrap_or(22),
        user: cfg.user,
        auth,
        key_file: cfg.key_file,
    })
}

fn tls_of(ds: &DataSource, from_url: TlsMode) -> TlsSettings {
    let mut tls = TlsSettings {
        mode: from_url,
        ..Default::default()
    };
    if let Some(n) = &ds.ssl {
        let enabled = n
            .child_text("enabled")
            .map(|e| e.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        if enabled {
            tls.mode = match n
                .child_text("mode")
                .unwrap_or_default()
                .to_ascii_uppercase()
                .as_str()
            {
                "VERIFY_CA" => TlsMode::VerifyCa,
                "VERIFY_FULL" | "VERIFY_IDENTITY" => TlsMode::VerifyFull,
                "PREFER" | "PREFERRED" => TlsMode::Prefer,
                _ => TlsMode::Require,
            };
        }
        tls.ca_file = n.child_text("ca-cert").or_else(|| n.child_text("ca-file"));
        tls.client_cert = n.child_text("client-cert");
        tls.client_key = n.child_text("client-key");
    } else if tls.mode == TlsMode::Disable {
        let p = |k: &str| ds.props.get(k).map(|v| v.to_ascii_lowercase());
        if let Some(mode) = p("sslmode").or_else(|| p("sslMode".to_ascii_lowercase().as_str())) {
            tls.mode = match mode.as_str() {
                "disable" | "disabled" | "allow" => TlsMode::Disable,
                "prefer" | "preferred" => TlsMode::Prefer,
                "verify-ca" | "verify_ca" => TlsMode::VerifyCa,
                "verify-full" | "verify_identity" => TlsMode::VerifyFull,
                _ => TlsMode::Require,
            };
        } else if ["ssl", "usessl", "encrypt"]
            .iter()
            .any(|k| p(k).as_deref() == Some("true"))
        {
            tls.mode = TlsMode::Require;
        }
    }
    tls
}

/// Map a data source to a Clew connection. `None` connection means "driver not available".
pub fn map_data_source(ds: &DataSource, config_dir: Option<&Path>) -> Mapped {
    let configs = config_dir.map(ssh_configs).unwrap_or_default();
    let parsed = ds.jdbc_url.as_deref().and_then(parse_jdbc);

    let (driver, settings, url_tls, url_user, url_password) = match parsed {
        Some(j) => (j.driver, j.settings, j.tls.mode, j.user, j.password),
        None => {
            let Some(driver) = ds.driver_ref.as_deref().and_then(driver_for_ref) else {
                return Mapped::default();
            };
            // The URL wasn't usable but the driver is known: keep what we can.
            let settings = match driver {
                "sqlite" | "duckdb" => Settings::File {
                    path: ds
                        .jdbc_url
                        .as_deref()
                        .and_then(|u| u.rsplit_once(':').map(|(_, p)| p.to_string()))
                        .unwrap_or_default(),
                    create_if_missing: false,
                },
                _ => Settings::Network {
                    host: String::new(),
                    port: crate::connections::url::default_port(driver).unwrap_or(0),
                    database: None,
                    user: None,
                    password_mode: PasswordMode::Keychain,
                },
            };
            (driver.to_string(), settings, TlsMode::Disable, None, None)
        }
    };

    let mut settings = settings;
    let user = ds.user.clone().or(url_user);
    match &mut settings {
        Settings::Network { user: u, .. }
        | Settings::Oracle { user: u, .. }
        | Settings::Keyvalue { user: u, .. }
        | Settings::Neo4j { user: u, .. }
        | Settings::Uri { user: u, .. } => *u = user,
        Settings::File { .. } => {}
    }

    let environment = Environment::detect(&ds.name);
    let connection = Connection {
        id: String::new(),
        name: ds.name.clone(),
        driver,
        group_id: None,
        environment,
        settings,
        ssh: ssh_of(ds, &configs),
        tls: tls_of(ds, url_tls),
        advanced: Advanced::default(),
        safeguards: environment.default_safeguards(),
        last_used_at: None,
        scripts_dir: None,
    };
    Mapped {
        connection: Some(connection),
        password_moved_out_of_url: url_password.is_some(),
        password: url_password,
    }
}

/// `consoles/db/<uuid>/**.sql` of a settings folder.
pub fn console_files(config_dir: &Path, uuid: &str) -> Vec<PathBuf> {
    if uuid.is_empty() {
        return vec![];
    }
    let dir = config_dir.join("consoles").join("db").join(uuid);
    collect_sql(&dir, true)
}

/// `scratches/*.sql` of a settings folder.
pub fn scratch_files(config_dir: &Path) -> Vec<PathBuf> {
    collect_sql(&config_dir.join("scratches"), false)
}

fn collect_sql(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        if p.is_dir() && recursive {
            out.extend(collect_sql(&p, true));
        } else if p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("sql")) {
            out.push(p);
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod fixtures {
    pub const DATA_SOURCES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="analytics-prod" uuid="11111111-1111-1111-1111-111111111111" group="Production">
      <driver-ref>postgresql</driver-ref>
      <synchronize>true</synchronize>
      <jdbc-driver>org.postgresql.Driver</jdbc-driver>
      <jdbc-url>jdbc:postgresql://db.internal:5432/analytics</jdbc-url>
      <jdbc-additional-properties>
        <property name="sslmode" value="verify-full" />
      </jdbc-additional-properties>
      <working-dir>$ProjectFileDir$</working-dir>
    </data-source>
    <data-source source="LOCAL" name="billing-mysql" uuid="22222222-2222-2222-2222-222222222222">
      <driver-ref>mysql.8</driver-ref>
      <jdbc-url>jdbc:mysql://billing-db:3306/billing</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="reporting-oracle" uuid="33333333-3333-3333-3333-333333333333">
      <driver-ref>oracle</driver-ref>
      <jdbc-url>jdbc:oracle:thin:@ora.internal:1521/REPORTS</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="legacy-sid" uuid="44444444-4444-4444-4444-444444444444">
      <driver-ref>oracle</driver-ref>
      <jdbc-url>jdbc:oracle:thin:@ora.internal:1521:ORCL</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="url-only" uuid="55555555-5555-5555-5555-555555555555">
      <driver-ref>postgresql</driver-ref>
      <jdbc-url>jdbc:postgresql://h:5432/app?user=ann&amp;password=hunter2</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="old-cassandra" uuid="66666666-6666-6666-6666-666666666666">
      <driver-ref>cassandra</driver-ref>
      <jdbc-url>jdbc:cassandra://cass-1:9042/ks</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="local-notes" uuid="77777777-7777-7777-7777-777777777777">
      <driver-ref>sqlite.xerial</driver-ref>
      <jdbc-url>jdbc:sqlite:/tmp/notes.db</jdbc-url>
    </data-source>
  </component>
</project>"#;

    pub const LOCAL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="dataSourceStorageLocal" created-in="DB-261.12345">
    <data-source name="analytics-prod" uuid="11111111-1111-1111-1111-111111111111">
      <database-info product="PostgreSQL" version="16.2" />
      <secret-storage>master_key</secret-storage>
      <user-name>karthik</user-name>
      <ssh-properties>
        <enabled>true</enabled>
        <ssh-config-id>aaaaaaaa-0000-0000-0000-000000000001</ssh-config-id>
      </ssh-properties>
      <ssl-config>
        <enabled>true</enabled>
        <mode>VERIFY_FULL</mode>
        <ca-cert>/certs/ca.pem</ca-cert>
      </ssl-config>
    </data-source>
    <data-source name="billing-mysql" uuid="22222222-2222-2222-2222-222222222222">
      <user-name>billing</user-name>
    </data-source>
    <data-source name="reporting-oracle" uuid="33333333-3333-3333-3333-333333333333">
      <user-name>reports</user-name>
    </data-source>
  </component>
</project>"#;

    pub const SSH_CONFIGS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="SshConfigs">
    <configs>
      <sshConfig host="bastion.example.net" id="aaaaaaaa-0000-0000-0000-000000000001" port="2222" customName="bastion" username="tunnel" authType="KEY_PAIR" keyPath="/Users/ada/.ssh/id_ed25519" useOpenSSHConfig="true" />
    </configs>
  </component>
</application>"#;

    pub fn write_config_dir(dir: &std::path::Path) {
        std::fs::create_dir_all(dir.join("options")).unwrap();
        std::fs::write(dir.join("options/dataSources.xml"), DATA_SOURCES).unwrap();
        std::fs::write(dir.join("options/dataSources.local.xml"), LOCAL).unwrap();
        std::fs::write(dir.join("options/sshConfigs.xml"), SSH_CONFIGS).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::OracleConnectBy;

    fn config() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fixtures::write_config_dir(dir.path());
        dir
    }

    fn mapped(dir: &Path, name: &str) -> Mapped {
        let ds = read_data_sources(dir)
            .into_iter()
            .find(|d| d.name == name)
            .unwrap();
        map_data_source(&ds, Some(dir))
    }

    /// (spec: connection-management › Detect DataGrip)
    #[test]
    fn discovers_all_versions_newest_first() {
        let root = tempfile::tempdir().unwrap();
        for d in [
            "DataGrip2025.3",
            "DataGrip2026.2",
            "DataGrip2026.1",
            "PyCharm2026.1",
            "DataGripBackup",
        ] {
            std::fs::create_dir(root.path().join(d)).unwrap();
        }
        let labels: Vec<_> = discover_in(root.path())
            .into_iter()
            .map(|i| i.label)
            .collect();
        assert_eq!(
            labels,
            ["DataGrip 2026.2", "DataGrip 2026.1", "DataGrip 2025.3"]
        );
        assert!(discover_in(&root.path().join("missing")).is_empty());
    }

    /// (spec: connection-management › Map drivers and settings)
    #[test]
    fn postgres_with_ssh_tunnel_and_ssl_carries_everything_over() {
        let dir = config();
        let m = mapped(dir.path(), "analytics-prod");
        let c = m.connection.unwrap();
        assert_eq!(c.driver, "postgres");
        assert_eq!(c.environment, Environment::Production);
        match &c.settings {
            Settings::Network {
                host,
                port,
                database,
                user,
                ..
            } => {
                assert_eq!(
                    (host.as_str(), *port, database.as_deref()),
                    ("db.internal", 5432, Some("analytics"))
                );
                assert_eq!(user.as_deref(), Some("karthik"));
            }
            o => panic!("{o:?}"),
        }
        let ssh = c.ssh.unwrap();
        assert_eq!(
            (
                ssh.host.as_str(),
                ssh.port,
                ssh.user.as_str(),
                ssh.auth,
                ssh.key_file.as_deref()
            ),
            (
                "bastion.example.net",
                2222,
                "tunnel",
                SshAuthKind::Key,
                Some("/Users/ada/.ssh/id_ed25519")
            )
        );
        assert!(ssh.enabled);
        assert_eq!(c.tls.mode, TlsMode::VerifyFull);
        assert_eq!(c.tls.ca_file.as_deref(), Some("/certs/ca.pem"));
        assert!(m.password.is_none());
    }

    #[test]
    fn user_names_come_from_the_local_file() {
        let dir = config();
        match mapped(dir.path(), "billing-mysql")
            .connection
            .unwrap()
            .settings
        {
            Settings::Network { user, .. } => assert_eq!(user.as_deref(), Some("billing")),
            o => panic!("{o:?}"),
        }
    }

    /// (spec: connection-management › Oracle data source)
    #[test]
    fn oracle_service_name_and_sid() {
        let dir = config();
        let svc = mapped(dir.path(), "reporting-oracle").connection.unwrap();
        match svc.settings {
            Settings::Oracle {
                host,
                port,
                connect_by,
                user,
                ..
            } => {
                assert_eq!((host.as_str(), port), ("ora.internal", 1521));
                assert_eq!(
                    connect_by,
                    OracleConnectBy::ServiceName {
                        value: "REPORTS".into()
                    }
                );
                assert_eq!(user.as_deref(), Some("reports"));
            }
            o => panic!("{o:?}"),
        }
        let sid = mapped(dir.path(), "legacy-sid").connection.unwrap();
        assert!(matches!(
            sid.settings,
            Settings::Oracle { connect_by: OracleConnectBy::Sid { ref value }, .. } if value == "ORCL"
        ));
    }

    /// (spec: connection-management › Credentials embedded in a URL)
    #[test]
    fn url_only_data_sources_lose_the_credentials_from_the_url() {
        let dir = config();
        let m = mapped(dir.path(), "url-only");
        assert_eq!(m.password.as_deref(), Some("hunter2"));
        assert!(m.password_moved_out_of_url);
        let c = m.connection.unwrap();
        match &c.settings {
            Settings::Network { user, .. } => assert_eq!(user.as_deref(), Some("ann")),
            o => panic!("{o:?}"),
        }
        assert!(!serde_json::to_string(&c).unwrap().contains("hunter2"));
    }

    /// (spec: connection-management › Unsupported driver)
    #[test]
    fn unsupported_drivers_map_to_nothing_and_file_databases_work() {
        let dir = config();
        assert!(mapped(dir.path(), "old-cassandra").connection.is_none());
        let notes = mapped(dir.path(), "local-notes").connection.unwrap();
        assert_eq!(notes.driver, "sqlite");
        assert_eq!(
            notes.settings,
            Settings::File {
                path: "/tmp/notes.db".into(),
                create_if_missing: false
            }
        );
    }

    #[test]
    fn groups_come_from_the_data_source() {
        let dir = config();
        let ds = read_data_sources(dir.path());
        assert_eq!(
            ds.iter()
                .find(|d| d.name == "analytics-prod")
                .unwrap()
                .group
                .as_deref(),
            Some("Production")
        );
        assert_eq!(
            ds.iter().find(|d| d.name == "billing-mysql").unwrap().group,
            None
        );
    }

    #[test]
    fn project_folders_use_the_idea_directory() {
        let proj = tempfile::tempdir().unwrap();
        std::fs::create_dir(proj.path().join(".idea")).unwrap();
        std::fs::write(
            proj.path().join(".idea/dataSources.xml"),
            fixtures::DATA_SOURCES,
        )
        .unwrap();
        std::fs::write(
            proj.path().join(".idea/dataSources.local.xml"),
            fixtures::LOCAL,
        )
        .unwrap();
        let ds = read_data_sources(proj.path());
        assert_eq!(ds.len(), 7);
        assert_eq!(
            ds.iter()
                .find(|d| d.name == "analytics-prod")
                .unwrap()
                .user
                .as_deref(),
            Some("karthik")
        );
    }

    #[test]
    fn consoles_and_scratches_are_found() {
        let dir = config();
        let uuid = "11111111-1111-1111-1111-111111111111";
        let consoles = dir.path().join("consoles/db").join(uuid);
        std::fs::create_dir_all(&consoles).unwrap();
        std::fs::write(consoles.join("console.sql"), "select 1").unwrap();
        std::fs::write(consoles.join("console_1.sql"), "select 2").unwrap();
        std::fs::write(consoles.join("ignore.txt"), "x").unwrap();
        std::fs::create_dir_all(dir.path().join("scratches")).unwrap();
        std::fs::write(dir.path().join("scratches/scratch.sql"), "select 3").unwrap();
        assert_eq!(console_files(dir.path(), uuid).len(), 2);
        assert!(console_files(dir.path(), "nope").is_empty());
        assert_eq!(scratch_files(dir.path()).len(), 1);
    }
}
