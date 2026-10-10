//! Importing connections from Clew exports, DataGrip, DBeaver and `~/.pgpass`.
//!
//! Importing is two steps. `scan_*` reads a source into [`Scan`]s kept in memory (secrets
//! included, never sent to the WebView) and returns a [`ScanView`] for the review list. Nothing
//! is saved until [`ConnectionService::import_commit`] is called with the user's selection.

pub mod datagrip;
pub mod dbeaver;
pub mod jdbc;
pub mod passwords;
pub mod pgpass;
pub mod xml;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::exchange::{read_export, ExchangeError, ExportPayload};
use super::model::{Connection, Environment, Settings};
use super::scripts::{free_path, safe_relative, sanitize_dir_name};
use super::secrets::SecretKind;
use super::service::{ConnectionService, SaveRequest, SecretUpdate};
use crate::drivers::Secret;
use crate::error::{AppError, AppResult};
use passwords::{KeePassLookup, KeychainLookup, PasswordLookup, Provider};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    New,
    /// Matches a connection already in Clew.
    Existing,
    /// Clew has no driver for it.
    Unavailable,
}

#[derive(Debug, Clone)]
enum SqlSource {
    Path(PathBuf),
    Inline { rel: String, content: String },
}

#[derive(Debug, Clone)]
struct SshKey {
    file_name: String,
    pem: String,
}

#[derive(Debug, Clone)]
struct Candidate {
    key: String,
    connection: Option<Connection>,
    name: String,
    driver_label: String,
    group: Option<String>,
    status: Status,
    note: Option<String>,
    existing_id: Option<String>,
    secrets: Vec<(SecretKind, String)>,
    ssh_key: Option<SshKey>,
    sql: Vec<SqlSource>,
}

#[derive(Debug, Default)]
pub struct Scan {
    candidates: Vec<Candidate>,
    scratches: Vec<PathBuf>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CandidateView {
    pub key: String,
    pub name: String,
    pub driver: String,
    pub driver_label: String,
    pub address: String,
    pub sql_files: u32,
    pub status: Status,
    /// e.g. "password moved out of the URL"
    pub note: Option<String>,
    pub has_password: bool,
    pub group: Option<String>,
    pub environment: Option<Environment>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ScanView {
    pub scan_id: String,
    pub candidates: Vec<CandidateView>,
    pub scratch_files: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub key: String,
    /// For an "Already in Clew" row: link the SQL files to the existing connection only.
    #[serde(default)]
    pub merge_only: bool,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum GroupMode {
    /// Use each source's own groups or folders.
    Keep,
    /// Put everything in one group.
    Single { name: String },
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    /// `None` keeps what each source says (DataGrip: detected from the name).
    #[serde(default)]
    pub environment: Option<Environment>,
    pub group: GroupMode,
    pub import_sql_files: bool,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: u32,
    pub merged: u32,
    pub sql_files: u32,
    pub warnings: Vec<String>,
}

/// Where imported files go.
#[derive(Debug, Clone)]
pub struct ImportEnv {
    /// `~/Documents/Clew/Scripts`
    pub scripts_root: PathBuf,
    /// `<app data>/ssh-keys`
    pub ssh_keys_dir: PathBuf,
}

#[derive(Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportSource {
    #[serde(rename_all = "camelCase")]
    Clew {
        path: String,
        passphrase: Option<Secret>,
    },
    #[serde(rename_all = "camelCase")]
    DataGrip {
        /// A DataGrip settings folder.
        dir: String,
        /// Extra project folders (their `.idea/dataSources*.xml`).
        #[serde(default)]
        projects: Vec<String>,
        include_passwords: bool,
        /// DataGrip's KeePass master password, when the user had to type it.
        keepass_password: Option<Secret>,
    },
    #[serde(rename_all = "camelCase")]
    Dbeaver { path: String },
    #[serde(rename_all = "camelCase")]
    Pgpass {
        path: Option<String>,
        include_passwords: bool,
    },
}

/// How DataGrip keeps passwords, for the Import tab's messaging.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PasswordSafeInfo {
    /// `keychain`, `keepass` or `none`
    pub mode: String,
    pub keepass_path: Option<String>,
}

fn io_err(what: &str, e: std::io::Error) -> AppError {
    AppError::new("io", format!("Couldn't read {what}")).with_detail(e.to_string())
}

pub fn address_of(c: &Connection) -> String {
    match &c.settings {
        Settings::Network {
            host,
            port,
            database,
            ..
        } => {
            format!(
                "{host}:{port}{}",
                database
                    .as_deref()
                    .map(|d| format!("/{d}"))
                    .unwrap_or_default()
            )
        }
        Settings::Oracle {
            host,
            port,
            connect_by,
            ..
        } => {
            let v = match connect_by {
                super::model::OracleConnectBy::ServiceName { value }
                | super::model::OracleConnectBy::Sid { value }
                | super::model::OracleConnectBy::TnsAlias { value }
                | super::model::OracleConnectBy::EasyConnect { value } => value,
            };
            format!(
                "{host}:{port}{}",
                if v.is_empty() {
                    String::new()
                } else {
                    format!("/{v}")
                }
            )
        }
        Settings::File { path, .. } => path.clone(),
        Settings::Uri { uri, .. } => uri.clone(),
        Settings::Keyvalue {
            host,
            port,
            db_index,
            ..
        } => format!("{host}:{port} · db {db_index}"),
        Settings::Neo4j {
            host,
            port,
            database,
            ..
        } => {
            format!(
                "{host}:{port}{}",
                database
                    .as_deref()
                    .map(|d| format!("/{d}"))
                    .unwrap_or_default()
            )
        }
    }
}

/// Identity used to spot a connection that is already in Clew.
pub fn fingerprint(c: &Connection) -> String {
    let user = c.settings.user().unwrap_or("").to_ascii_lowercase();
    match &c.settings {
        Settings::Network {
            host,
            port,
            database,
            ..
        } => format!(
            "{}|{}|{port}|{}|{user}",
            c.driver,
            host.to_ascii_lowercase(),
            database.as_deref().unwrap_or("")
        ),
        Settings::File { path, .. } => format!("{}|{path}", c.driver),
        other => format!(
            "{}|{}|{user}",
            c.driver,
            address_of(&Connection {
                settings: other.clone(),
                ..c.clone()
            })
            .to_ascii_lowercase()
        ),
    }
}

fn status_for(c: &Connection, existing: &[Connection]) -> (Status, Option<String>) {
    let fp = fingerprint(c);
    match existing.iter().find(|e| fingerprint(e) == fp) {
        Some(e) => (Status::Existing, Some(e.id.clone())),
        None => (Status::New, None),
    }
}

fn candidate(key: String, connection: Connection, existing: &[Connection]) -> Candidate {
    let (status, existing_id) = status_for(&connection, existing);
    Candidate {
        key,
        name: connection.name.clone(),
        driver_label: connection.driver.clone(),
        connection: Some(connection),
        group: None,
        status,
        note: None,
        existing_id,
        secrets: vec![],
        ssh_key: None,
        sql: vec![],
    }
}

fn unavailable(
    key: String,
    name: String,
    driver_label: String,
    group: Option<String>,
) -> Candidate {
    Candidate {
        key,
        connection: None,
        name,
        driver_label,
        group,
        status: Status::Unavailable,
        note: Some("Driver not available".into()),
        existing_id: None,
        secrets: vec![],
        ssh_key: None,
        sql: vec![],
    }
}

// ---- scanners (pure: they read the source and compare against existing connections) --------

pub fn scan_clew(
    text: &str,
    passphrase: Option<&str>,
    existing: &[Connection],
) -> Result<Scan, ExchangeError> {
    let payload: ExportPayload = read_export(text, passphrase)?;
    let mut scan = Scan::default();
    for c in &payload.connections {
        let mut cand = candidate(c.id.clone(), c.clone(), existing);
        cand.group = c
            .group_id
            .as_ref()
            .and_then(|g| payload.groups.iter().find(|x| &x.id == g))
            .map(|g| g.name.clone());
        for kind in SecretKind::ALL {
            if let Some(v) = payload.secrets.get(&super::secrets::account(&c.id, kind)) {
                cand.secrets.push((kind, v.clone()));
            }
        }
        if let Some(k) = payload.ssh_keys.iter().find(|k| k.connection_id == c.id) {
            cand.ssh_key = Some(SshKey {
                file_name: k.file_name.clone(),
                pem: k.pem.clone(),
            });
        }
        cand.sql = payload
            .sql_files
            .iter()
            .filter(|f| f.connection_id == c.id)
            .map(|f| SqlSource::Inline {
                rel: f.rel_path.clone(),
                content: f.content.clone(),
            })
            .collect();
        if cand.status == Status::Existing {
            cand.note = Some("Already in Clew".into());
        }
        scan.candidates.push(cand);
    }
    Ok(scan)
}

pub fn scan_dbeaver(text: &str, existing: &[Connection]) -> Result<Scan, String> {
    let mut scan = Scan::default();
    for (i, e) in dbeaver::parse_dbeaver(text)?.into_iter().enumerate() {
        let key = format!("dbeaver-{i}");
        match e.connection {
            Some(c) => {
                let mut cand = candidate(key, c, existing);
                cand.group = e.folder;
                if cand.status == Status::Existing {
                    cand.note = Some("Already in Clew".into());
                }
                scan.candidates.push(cand);
            }
            None => scan
                .candidates
                .push(unavailable(key, e.name, e.driver_label, e.folder)),
        }
    }
    Ok(scan)
}

pub fn scan_pgpass(text: &str, include_passwords: bool, existing: &[Connection]) -> Scan {
    let mut scan = Scan::default();
    for (i, e) in pgpass::parse_pgpass(text).iter().enumerate() {
        let mut cand = candidate(format!("pgpass-{i}"), pgpass::to_connection(e), existing);
        if include_passwords {
            cand.secrets
                .push((SecretKind::Password, e.password.clone()));
        }
        if cand.status == Status::Existing {
            cand.note = Some("Already in Clew".into());
        }
        scan.candidates.push(cand);
    }
    scan
}

pub fn scan_datagrip(
    config_dir: &Path,
    projects: &[PathBuf],
    lookup: Option<&dyn PasswordLookup>,
    existing: &[Connection],
) -> Scan {
    let mut scan = Scan::default();
    let mut dirs: Vec<(&Path, bool)> = vec![(config_dir, true)];
    dirs.extend(projects.iter().map(|p| (p.as_path(), false)));
    let mut seen = std::collections::BTreeSet::new();
    for (dir, is_config) in dirs {
        for ds in datagrip::read_data_sources(dir) {
            if !seen.insert(if ds.uuid.is_empty() {
                ds.name.clone()
            } else {
                ds.uuid.clone()
            }) {
                continue;
            }
            let key = format!(
                "datagrip-{}",
                if ds.uuid.is_empty() {
                    &ds.name
                } else {
                    &ds.uuid
                }
            );
            let mapped = datagrip::map_data_source(&ds, Some(config_dir));
            let Some(conn) = mapped.connection else {
                scan.candidates.push(unavailable(
                    key,
                    ds.name.clone(),
                    ds.driver_ref.clone().unwrap_or_else(|| "unknown".into()),
                    ds.group.clone(),
                ));
                continue;
            };
            let mut cand = candidate(key, conn, existing);
            cand.group = ds.group.clone();
            let mut notes = vec![];
            if cand.status == Status::Existing {
                notes.push("Already in Clew".to_string());
            }
            if let Some(pw) = mapped.password {
                cand.secrets.push((SecretKind::Password, pw));
                notes.push("password moved out of the URL".into());
            } else if let Some(lookup) = lookup {
                let user = cand
                    .connection
                    .as_ref()
                    .and_then(|c| c.settings.user())
                    .map(str::to_string);
                match lookup.password(&ds.uuid, user.as_deref()) {
                    Some(pw) => cand.secrets.push((SecretKind::Password, pw)),
                    None => notes.push("password not imported".into()),
                }
            }
            if is_config {
                cand.sql = datagrip::console_files(config_dir, &ds.uuid)
                    .into_iter()
                    .map(SqlSource::Path)
                    .collect();
            }
            cand.note = (!notes.is_empty()).then(|| notes.join(" · "));
            scan.candidates.push(cand);
        }
    }
    scan.scratches = datagrip::scratch_files(config_dir);
    scan
}

fn view(c: &Candidate) -> CandidateView {
    CandidateView {
        key: c.key.clone(),
        name: c.name.clone(),
        driver: c
            .connection
            .as_ref()
            .map(|x| x.driver.clone())
            .unwrap_or_default(),
        driver_label: c.driver_label.clone(),
        address: c.connection.as_ref().map(address_of).unwrap_or_default(),
        sql_files: c.sql.len() as u32,
        status: c.status,
        note: c.note.clone(),
        has_password: c.secrets.iter().any(|(k, _)| *k == SecretKind::Password),
        group: c.group.clone(),
        environment: c.connection.as_ref().map(|x| x.environment),
    }
}

/// Write a private key where only the current user can read it.
pub fn write_private_key(
    dir: &Path,
    connection_id: &str,
    file_name: &str,
    pem: &str,
) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|e| io_err("the SSH key folder", e))?;
    let safe = sanitize_dir_name(file_name);
    let path = dir.join(format!("{connection_id}_{safe}"));
    write_owner_only(&path, pem.as_bytes()).map_err(|e| io_err("an SSH key", e))?;
    Ok(path)
}

#[cfg(unix)]
fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)
}

#[cfg(windows)]
fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)?;
    // Drop inherited permissions and grant only the current user.
    let user = std::env::var("USERNAME").unwrap_or_default();
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{user}:F"))
        .status()?;
    if status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(path);
        Err(std::io::Error::other("icacls failed"))
    }
}

impl ConnectionService {
    fn store_scan(&self, scan: Scan) -> ScanView {
        let id = format!("scan-{}", ulid::Ulid::generate());
        let view = ScanView {
            scan_id: id.clone(),
            candidates: scan.candidates.iter().map(view).collect(),
            scratch_files: scan.scratches.len() as u32,
            warnings: scan.warnings.clone(),
        };
        let mut scans = self.scans.lock().unwrap();
        if scans.len() > 4 {
            scans.clear(); // abandoned reviews never accumulate secrets
        }
        scans.insert(id, scan);
        view
    }

    pub fn import_scan(&self, source: ImportSource) -> AppResult<ScanView> {
        let existing = self.list()?.connections;
        let scan = match source {
            ImportSource::Clew { path, passphrase } => {
                let text = std::fs::read_to_string(&path).map_err(|e| io_err("the file", e))?;
                scan_clew(&text, passphrase.as_ref().map(Secret::expose), &existing)?
            }
            ImportSource::Dbeaver { path } => {
                let text = std::fs::read_to_string(&path).map_err(|e| io_err("the file", e))?;
                scan_dbeaver(&text, &existing).map_err(|m| AppError::new("invalid_file", m))?
            }
            ImportSource::Pgpass {
                path,
                include_passwords,
            } => {
                let path = path
                    .map(PathBuf::from)
                    .or_else(|| std::env::home_dir().map(|h| h.join(".pgpass")));
                let path =
                    path.ok_or_else(|| AppError::new("not_found", "Couldn't find ~/.pgpass"))?;
                let text = std::fs::read_to_string(&path).map_err(|e| io_err("~/.pgpass", e))?;
                scan_pgpass(&text, include_passwords, &existing)
            }
            ImportSource::DataGrip {
                dir,
                projects,
                include_passwords,
                keepass_password,
            } => {
                let dir = PathBuf::from(dir);
                let projects: Vec<PathBuf> = projects.into_iter().map(PathBuf::from).collect();
                let mut warnings = vec![];
                let lookup: Option<Box<dyn PasswordLookup>> = if include_passwords {
                    match passwords::provider(&dir) {
                        Provider::DoNotSave => None,
                        Provider::Keychain => Some(Box::new(KeychainLookup)),
                        Provider::KeePass { path } => match keepass_password {
                            None => {
                                return Err(AppError::new(
                                    "needs_keepass_password",
                                    "DataGrip keeps its passwords in a KeePass database; enter its master password",
                                ))
                            }
                            Some(pw) => match KeePassLookup::open(&path, pw.expose()) {
                                Ok(l) => Some(Box::new(l)),
                                Err(passwords::KeePassError::WrongPassword) => {
                                    return Err(AppError::new(
                                        "wrong_keepass_password",
                                        "That master password doesn't unlock DataGrip's KeePass database",
                                    ))
                                }
                                Err(passwords::KeePassError::Missing) => {
                                    warnings.push("DataGrip's KeePass database was not found; passwords not imported".to_string());
                                    None
                                }
                                Err(passwords::KeePassError::Other(m)) => {
                                    warnings.push(format!("Couldn't read DataGrip's KeePass database: {m}"));
                                    None
                                }
                            },
                        },
                    }
                } else {
                    None
                };
                let mut scan = scan_datagrip(&dir, &projects, lookup.as_deref(), &existing);
                scan.warnings.extend(warnings);
                scan
            }
        };
        Ok(self.store_scan(scan))
    }

    fn group_id_named(&self, name: &str) -> AppResult<String> {
        if let Some(g) = self.list()?.groups.iter().find(|g| g.name == name) {
            return Ok(g.id.clone());
        }
        let order = self.list()?.groups.len() as i32;
        Ok(self
            .save_group(super::model::Group {
                id: String::new(),
                name: name.to_string(),
                order,
            })?
            .id)
    }

    /// Save the selected candidates of a scan. A candidate that already exists is only touched
    /// when `merge_only` is set (its SQL files are linked to the existing connection).
    pub fn import_commit(
        &self,
        scan_id: &str,
        selections: &[Selection],
        opts: &CommitOptions,
        env: &ImportEnv,
    ) -> AppResult<ImportResult> {
        let scan = self.scans.lock().unwrap().remove(scan_id).ok_or_else(|| {
            AppError::new("scan_expired", "This import expired; scan the source again")
        })?;
        let mut result = ImportResult {
            added: 0,
            merged: 0,
            sql_files: 0,
            warnings: scan.warnings.clone(),
        };

        for sel in selections {
            let Some(cand) = scan.candidates.iter().find(|c| c.key == sel.key) else {
                continue;
            };
            if cand.status == Status::Unavailable {
                continue;
            }
            if sel.merge_only {
                let Some(target) = cand.existing_id.as_ref().and_then(|id| self.get(id).ok())
                else {
                    continue;
                };
                if opts.import_sql_files {
                    let dir = super::scripts::scripts_dir_of(&target)
                        .unwrap_or_else(|| env.scripts_root.join(sanitize_dir_name(&target.name)));
                    result.sql_files += copy_sql(&cand.sql, &dir, &mut result.warnings);
                }
                result.merged += 1;
                continue;
            }

            let Some(mut conn) = cand.connection.clone() else {
                continue;
            };
            let own_id = Connection::new_id();
            conn.id = own_id.clone();
            conn.name = self.unique_name(&conn.name)?;
            conn.group_id = match &opts.group {
                GroupMode::Single { name } => Some(self.group_id_named(name)?),
                GroupMode::Keep => match &cand.group {
                    Some(name) => Some(self.group_id_named(name)?),
                    None => None,
                },
            };
            if let Some(environment) = opts.environment {
                conn.environment = environment;
                conn.safeguards = environment.default_safeguards();
            }
            if let Some(key) = &cand.ssh_key {
                match write_private_key(&env.ssh_keys_dir, &own_id, &key.file_name, &key.pem) {
                    Ok(path) => {
                        if let Some(ssh) = conn.ssh.as_mut() {
                            ssh.key_file = Some(path.to_string_lossy().into_owned());
                        }
                    }
                    Err(e) => result.warnings.push(format!(
                        "{}: SSH key not imported ({})",
                        conn.name, e.message
                    )),
                }
            }
            if opts.import_sql_files && !cand.sql.is_empty() {
                let dir = env.scripts_root.join(sanitize_dir_name(&conn.name));
                let n = copy_sql(&cand.sql, &dir, &mut result.warnings);
                if n > 0 {
                    conn.scripts_dir = Some(dir.to_string_lossy().into_owned());
                }
                result.sql_files += n;
            }

            let set = |kind: SecretKind| {
                cand.secrets
                    .iter()
                    .find(|(k, _)| *k == kind)
                    .map(|(_, v)| SecretUpdate::Set {
                        value: Secret::new(v.clone()),
                    })
                    .unwrap_or(SecretUpdate::Keep)
            };
            let saved = self.save(SaveRequest {
                connection: conn,
                password: set(SecretKind::Password),
                ssh_passphrase: set(SecretKind::SshPassphrase),
                ssh_password: set(SecretKind::SshPassword),
            })?;
            result.warnings.extend(saved.warnings);
            result.added += 1;
        }

        if opts.import_sql_files && !scan.scratches.is_empty() {
            let dir = env.scripts_root.join("Scratches");
            let n = copy_paths(&scan.scratches, &dir, &mut result.warnings);
            result.sql_files += n;
        }
        result.warnings.dedup();
        Ok(result)
    }

    pub fn password_safe_info(&self, dir: &Path) -> PasswordSafeInfo {
        match passwords::provider(dir) {
            Provider::Keychain => PasswordSafeInfo {
                mode: "keychain".into(),
                keepass_path: None,
            },
            Provider::KeePass { path } => PasswordSafeInfo {
                mode: "keepass".into(),
                keepass_path: Some(path.to_string_lossy().into_owned()),
            },
            Provider::DoNotSave => PasswordSafeInfo {
                mode: "none".into(),
                keepass_path: None,
            },
        }
    }
}

fn copy_paths(files: &[PathBuf], dir: &Path, warnings: &mut Vec<String>) -> u32 {
    let mut n = 0;
    if std::fs::create_dir_all(dir).is_err() {
        warnings.push(format!("Couldn't create {}", dir.display()));
        return 0;
    }
    for f in files {
        let name = f
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "script.sql".into());
        // Originals are only ever read.
        match std::fs::copy(f, free_path(dir, &name)) {
            Ok(_) => n += 1,
            Err(e) => warnings.push(format!("Couldn't copy {name}: {e}")),
        }
    }
    n
}

fn copy_sql(sources: &[SqlSource], dir: &Path, warnings: &mut Vec<String>) -> u32 {
    let mut n = 0;
    if sources.is_empty() {
        return 0;
    }
    if std::fs::create_dir_all(dir).is_err() {
        warnings.push(format!("Couldn't create {}", dir.display()));
        return 0;
    }
    for s in sources {
        match s {
            SqlSource::Path(p) => n += copy_paths(std::slice::from_ref(p), dir, warnings),
            SqlSource::Inline { rel, content } => {
                let Some(rel) = safe_relative(rel) else {
                    warnings.push(format!("Skipped a file with an unsafe path: {rel}"));
                    continue;
                };
                let name = rel
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let target_dir = dir.join(rel.parent().unwrap_or(Path::new("")));
                if std::fs::create_dir_all(&target_dir).is_err() {
                    continue;
                }
                match std::fs::write(free_path(&target_dir, &name), content) {
                    Ok(()) => n += 1,
                    Err(e) => warnings.push(format!("Couldn't write {name}: {e}")),
                }
            }
        }
    }
    n
}

#[cfg(test)]
mod tests;
