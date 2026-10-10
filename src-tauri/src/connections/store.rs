//! `connections.json`: load, atomic save, and merge-by-id when the file changed on disk.
//!
//! Every change is an [`Op`] applied to the freshest copy of the file, so an edit made by hand (or
//! by another Clew window) while this one was open is never lost.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::model::{Connection, ConnectionsFile, Group, FILE_VERSION};
use crate::error::{AppError, AppResult};

pub const CONNECTIONS_FILE: &str = "connections.json";

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // short-lived values, boxing would only add noise
pub enum Op {
    UpsertConnection(Connection),
    DeleteConnection(String),
    UpsertGroup(Group),
    /// Removes the group; its connections move to "Ungrouped".
    DeleteGroup(String),
    /// Several connections at once (imports).
    UpsertConnections(Vec<Connection>),
    TouchLastUsed {
        id: String,
        at: String,
    },
}

#[derive(Debug)]
pub struct LoadOutcome {
    /// Set when the file could not be parsed: where the bad file was moved to.
    pub backup: Option<PathBuf>,
}

#[derive(Debug)]
pub struct ConnectionsStore {
    path: PathBuf,
    file: ConnectionsFile,
    /// Modification time of the file when we last read or wrote it.
    mtime: Option<SystemTime>,
}

fn io_err(what: &str, e: std::io::Error) -> AppError {
    AppError::new("connections_io", what).with_detail(e.to_string())
}

fn mtime_of(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

impl ConnectionsStore {
    /// Open the store at `dir/connections.json`. A missing file is an empty store; an unparseable
    /// one is moved aside (`connections.json.corrupt-<unix time>`) and replaced by an empty store.
    pub fn open(dir: &Path) -> (Self, LoadOutcome) {
        let path = dir.join(CONNECTIONS_FILE);
        let mut store = Self {
            path,
            file: ConnectionsFile::default(),
            mtime: None,
        };
        let outcome = match store.reload() {
            Ok(()) => LoadOutcome { backup: None },
            Err(_) => {
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = store
                    .path
                    .with_file_name(format!("{CONNECTIONS_FILE}.corrupt-{ts}"));
                let moved = fs::rename(&store.path, &backup).ok().map(|_| backup);
                store.file = ConnectionsFile::default();
                store.mtime = None;
                LoadOutcome { backup: moved }
            }
        };
        (store, outcome)
    }

    pub fn file(&self) -> &ConnectionsFile {
        &self.file
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Re-read the file from disk.
    fn reload(&mut self) -> AppResult<()> {
        match fs::read_to_string(&self.path) {
            Ok(text) => {
                let file: ConnectionsFile = serde_json::from_str(&text).map_err(|e| {
                    AppError::new("connections_corrupt", "connections.json could not be read")
                        .with_detail(e.to_string())
                })?;
                if file.version > FILE_VERSION {
                    return Err(AppError::new(
                        "connections_version",
                        format!(
                            "connections.json was written by a newer Clew (format {}); this version understands format {FILE_VERSION}",
                            file.version
                        ),
                    ));
                }
                self.file = file;
                self.mtime = mtime_of(&self.path);
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.file = ConnectionsFile::default();
                self.mtime = None;
                Ok(())
            }
            Err(e) => Err(io_err("Could not read connections.json", e)),
        }
    }

    /// Pick up changes made to the file since we last looked.
    pub fn refresh_if_changed(&mut self) -> AppResult<bool> {
        if mtime_of(&self.path) == self.mtime {
            return Ok(false);
        }
        self.reload()?;
        Ok(true)
    }

    /// Apply a change on top of the freshest file contents and write it atomically.
    pub fn apply(&mut self, op: Op) -> AppResult<()> {
        self.refresh_if_changed()?;
        apply_op(&mut self.file, op);
        self.write()
    }

    /// Apply several changes with one write.
    pub fn apply_all(&mut self, ops: Vec<Op>) -> AppResult<()> {
        self.refresh_if_changed()?;
        for op in ops {
            apply_op(&mut self.file, op);
        }
        self.write()
    }

    fn write(&mut self) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| io_err("Could not create the data folder", e))?;
        }
        let json = serde_json::to_string_pretty(&self.file).map_err(|e| {
            AppError::new("connections_serialize", "Could not save connections")
                .with_detail(e.to_string())
        })?;
        // temp file + rename so a crash never leaves half a file
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| io_err("Could not save connections", e))?;
        fs::rename(&tmp, &self.path).map_err(|e| io_err("Could not save connections", e))?;
        self.mtime = mtime_of(&self.path);
        Ok(())
    }
}

fn apply_op(file: &mut ConnectionsFile, op: Op) {
    match op {
        Op::UpsertConnection(c) => upsert(file, c),
        Op::UpsertConnections(list) => list.into_iter().for_each(|c| upsert(file, c)),
        Op::DeleteConnection(id) => file.connections.retain(|c| c.id != id),
        Op::UpsertGroup(g) => match file.groups.iter_mut().find(|x| x.id == g.id) {
            Some(existing) => *existing = g,
            None => file.groups.push(g),
        },
        Op::DeleteGroup(id) => {
            file.groups.retain(|g| g.id != id);
            for c in &mut file.connections {
                if c.group_id.as_deref() == Some(id.as_str()) {
                    c.group_id = None;
                }
            }
        }
        Op::TouchLastUsed { id, at } => {
            if let Some(c) = file.connections.iter_mut().find(|c| c.id == id) {
                c.last_used_at = Some(at);
            }
        }
    }
}

fn upsert(file: &mut ConnectionsFile, c: Connection) {
    match file.connections.iter_mut().find(|x| x.id == c.id) {
        Some(existing) => *existing = c,
        None => file.connections.push(c),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::connections::model::{Advanced, Environment, PasswordMode, Settings, TlsSettings};

    pub(crate) fn conn(id: &str, name: &str) -> Connection {
        Connection {
            id: id.into(),
            name: name.into(),
            driver: "postgres".into(),
            group_id: None,
            environment: Environment::Local,
            settings: Settings::Network {
                host: "localhost".into(),
                port: 5432,
                database: None,
                user: Some("u".into()),
                password_mode: PasswordMode::Keychain,
            },
            ssh: None,
            tls: TlsSettings::default(),
            advanced: Advanced::default(),
            safeguards: Environment::Local.default_safeguards(),
            last_used_at: None,
            scripts_dir: None,
        }
    }

    fn names(store: &ConnectionsStore) -> Vec<String> {
        store
            .file()
            .connections
            .iter()
            .map(|c| c.name.clone())
            .collect()
    }

    #[test]
    fn a_missing_file_is_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let (store, out) = ConnectionsStore::open(dir.path());
        assert!(store.file().connections.is_empty());
        assert!(out.backup.is_none());
    }

    #[test]
    fn saves_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        s.apply(Op::UpsertConnection(conn("c1", "one"))).unwrap();
        let (again, _) = ConnectionsStore::open(dir.path());
        assert_eq!(names(&again), ["one"]);
        assert!(dir.path().join("connections.json").exists());
        assert!(
            !dir.path().join("connections.json.tmp").exists(),
            "no temp file left behind"
        );
    }

    #[test]
    fn upsert_replaces_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        s.apply(Op::UpsertConnection(conn("c1", "one"))).unwrap();
        s.apply(Op::UpsertConnection(conn("c1", "renamed")))
            .unwrap();
        assert_eq!(names(&s), ["renamed"]);
    }

    #[test]
    fn a_change_made_on_disk_meanwhile_is_merged_not_lost() {
        let dir = tempfile::tempdir().unwrap();
        let (mut a, _) = ConnectionsStore::open(dir.path());
        a.apply(Op::UpsertConnection(conn("c1", "from-a"))).unwrap();

        // a second window (or a hand edit) loads the file and adds a connection
        let (mut b, _) = ConnectionsStore::open(dir.path());
        std::thread::sleep(std::time::Duration::from_millis(20)); // distinct mtimes everywhere
        b.apply(Op::UpsertConnection(conn("c2", "from-b"))).unwrap();

        // `a` still thinks the file has only c1; its next write must keep c2
        std::thread::sleep(std::time::Duration::from_millis(20));
        a.apply(Op::UpsertConnection(conn("c3", "from-a-again")))
            .unwrap();
        let mut got = names(&a);
        got.sort();
        assert_eq!(got, ["from-a", "from-a-again", "from-b"]);
        let (disk, _) = ConnectionsStore::open(dir.path());
        assert_eq!(disk.file().connections.len(), 3);
    }

    #[test]
    fn a_hand_edit_is_picked_up_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        s.apply(Op::UpsertConnection(conn("c1", "one"))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let path = dir.path().join("connections.json");
        let mut f: ConnectionsFile =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        f.connections.push(conn("hand", "hand-edited"));
        fs::write(&path, serde_json::to_string_pretty(&f).unwrap()).unwrap();

        s.apply(Op::UpsertConnection(conn("c2", "two"))).unwrap();
        let mut got = names(&s);
        got.sort();
        assert_eq!(got, ["hand-edited", "one", "two"]);
    }

    #[test]
    fn deleting_removes_only_that_connection() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        s.apply_all(vec![
            Op::UpsertConnection(conn("c1", "one")),
            Op::UpsertConnection(conn("c2", "two")),
        ])
        .unwrap();
        s.apply(Op::DeleteConnection("c1".into())).unwrap();
        assert_eq!(names(&s), ["two"]);
        s.apply(Op::DeleteConnection("nope".into())).unwrap(); // unknown ids are a no-op
        assert_eq!(names(&s), ["two"]);
    }

    #[test]
    fn deleting_a_group_moves_its_connections_to_ungrouped() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        let mut c = conn("c1", "one");
        c.group_id = Some("g1".into());
        s.apply_all(vec![
            Op::UpsertGroup(Group {
                id: "g1".into(),
                name: "Production".into(),
                order: 0,
            }),
            Op::UpsertConnection(c),
        ])
        .unwrap();
        s.apply(Op::DeleteGroup("g1".into())).unwrap();
        assert!(s.file().groups.is_empty());
        assert_eq!(s.file().connections[0].group_id, None);
    }

    #[test]
    fn group_upsert_renames_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        s.apply(Op::UpsertGroup(Group {
            id: "g".into(),
            name: "A".into(),
            order: 0,
        }))
        .unwrap();
        s.apply(Op::UpsertGroup(Group {
            id: "g".into(),
            name: "B".into(),
            order: 1,
        }))
        .unwrap();
        assert_eq!(s.file().groups.len(), 1);
        assert_eq!(s.file().groups[0].name, "B");
    }

    #[test]
    fn last_used_is_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        s.apply(Op::UpsertConnection(conn("c1", "one"))).unwrap();
        s.apply(Op::TouchLastUsed {
            id: "c1".into(),
            at: "2026-10-10T10:00:00Z".into(),
        })
        .unwrap();
        assert_eq!(
            s.file().connections[0].last_used_at.as_deref(),
            Some("2026-10-10T10:00:00Z")
        );
    }

    #[test]
    fn a_corrupt_file_is_backed_up_and_the_store_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("connections.json"), "{ not json").unwrap();
        let (store, out) = ConnectionsStore::open(dir.path());
        assert!(store.file().connections.is_empty());
        let backup = out.backup.expect("backup path");
        assert_eq!(fs::read_to_string(backup).unwrap(), "{ not json");
    }

    #[test]
    fn a_newer_format_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        fs::write(&path, r#"{"version": 99, "connections": []}"#).unwrap();
        let (mut s, out) = ConnectionsStore::open(dir.path());
        // opening treats it as unreadable: backed up, not silently downgraded
        assert!(out.backup.is_some());
        s.apply(Op::UpsertConnection(conn("c1", "one"))).unwrap();
        let backup = out.backup.unwrap();
        assert!(fs::read_to_string(backup).unwrap().contains("99"));
    }

    #[test]
    fn the_file_is_pretty_printed_for_hand_editing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = ConnectionsStore::open(dir.path());
        s.apply(Op::UpsertConnection(conn("c1", "one"))).unwrap();
        let text = fs::read_to_string(dir.path().join("connections.json")).unwrap();
        assert!(text.contains("\n  \"connections\""));
        assert!(text.contains("\"version\": 1"));
    }
}
