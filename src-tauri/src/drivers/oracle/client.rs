//! Finding the Oracle Instant Client. ODPI-C loads it at run time (Clew can't ship it), so the
//! driver looks in the places Oracle's own tools do and tells the user what it found.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

use crate::drivers::{DriverError, DriverResult, ErrorCode};

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub found: bool,
    /// The folder holding the client library.
    pub dir: Option<String>,
    /// e.g. `19.8`, read from the folder or library name.
    pub version: Option<String>,
    /// The places that were looked in, in order.
    pub searched: Vec<String>,
}

#[cfg(target_os = "macos")]
const LIB: &str = "libclntsh.dylib";
#[cfg(windows)]
const LIB: &str = "oci.dll";
#[cfg(all(not(target_os = "macos"), not(windows)))]
const LIB: &str = "libclntsh.so";

fn has_client(dir: &Path) -> bool {
    dir.join(LIB).exists()
        || std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten().any(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    n.starts_with(LIB) || n.starts_with("libclntsh.")
                })
            })
            .unwrap_or(false)
}

/// `19.8` from `instantclient_19_8`, or `19.1` from `libclntsh.dylib.19.1`.
pub fn version_of(dir: &Path) -> Option<String> {
    let name = dir.file_name()?.to_string_lossy().into_owned();
    if let Some(rest) = name.strip_prefix("instantclient_") {
        let v = rest.replace('_', ".");
        if v.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return Some(v);
        }
    }
    let mut best: Option<(u32, u32, String)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if let Some(v) = n
            .strip_prefix("libclntsh.dylib.")
            .or_else(|| n.strip_prefix("libclntsh.so."))
        {
            let mut parts = v.split('.');
            let (a, b) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
            if best.as_ref().map_or(true, |(x, y, _)| (a, b) > (*x, *y)) {
                best = Some((a, b, format!("{a}.{b}")));
            }
        }
    }
    best.map(|(_, _, v)| v)
}

fn instantclient_dirs_in(parent: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(parent)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_dir()
                        && p.file_name()
                            .is_some_and(|n| n.to_string_lossy().starts_with("instantclient"))
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found.reverse(); // newest folder name first
    found
}

/// The folders to look in: the one chosen in Settings, `ORACLE_HOME`, the library path, then the
/// places Oracle's installers and the download page put it.
pub fn candidates(configured: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(c) = configured.filter(|c| !c.trim().is_empty()) {
        out.push(PathBuf::from(c));
    }
    if let Ok(home) = std::env::var("ORACLE_HOME") {
        out.push(Path::new(&home).join("lib"));
        out.push(PathBuf::from(home));
    }
    for var in ["DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH", "PATH"] {
        if let Ok(v) = std::env::var(var) {
            out.extend(std::env::split_paths(&v));
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    if let Some(home) = home.map(PathBuf::from) {
        out.extend(instantclient_dirs_in(&home.join("Downloads")));
        out.extend(instantclient_dirs_in(&home));
        out.push(home.join("lib"));
    }
    for parent in [
        "/opt/oracle",
        "/usr/local/lib",
        "/usr/lib/oracle",
        "C:\\oracle",
        "C:\\",
    ] {
        out.extend(instantclient_dirs_in(Path::new(parent)));
    }
    out.push(PathBuf::from("/usr/local/lib"));
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

pub fn status(configured: Option<&str>) -> ClientStatus {
    let from_settings = configured_dir();
    let searched = candidates(configured.or(from_settings.as_deref()));
    let hit = searched.iter().find(|d| has_client(d));
    ClientStatus {
        found: hit.is_some(),
        dir: hit.map(|d| d.display().to_string()),
        version: hit.and_then(|d| version_of(d)),
        searched: searched.iter().map(|d| d.display().to_string()).collect(),
    }
}

static CONFIGURED: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

/// The folder chosen in Settings (empty when none was).
pub fn set_configured_dir(dir: &str) {
    *CONFIGURED.write().unwrap() = dir.trim().to_string();
}

fn configured_dir() -> Option<String> {
    Some(CONFIGURED.read().unwrap().clone()).filter(|d| !d.is_empty())
}

static INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// Load the client library, once per process. The first call decides which folder is used.
pub fn init(configured: Option<&str>) -> DriverResult<()> {
    let result = INIT.get_or_init(|| {
        let from_settings = configured_dir();
        let status = status(configured.or(from_settings.as_deref()));
        let mut params = oracle::InitParams::new();
        if let Some(dir) = &status.dir {
            params
                .oracle_client_lib_dir(dir)
                .map_err(|e| e.to_string())?;
        }
        params.init().map(|_| ()).map_err(|e| e.to_string())
    });
    result.clone().map_err(|message| missing(&message))
}

/// The error shown when no client can be loaded.
pub fn missing(detail: &str) -> DriverError {
    DriverError::new(
        ErrorCode::DriverUnavailable,
        "Oracle needs the free Oracle Instant Client (version 19 or later). Download \"Basic\" or \"Basic Light\" for your CPU from oracle.com/database/technologies/instant-client, unzip it, and choose its folder in Settings.",
    )
    .with_detail(detail.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_come_from_the_folder_or_the_library_name() {
        assert_eq!(
            version_of(Path::new("/x/instantclient_19_8")).as_deref(),
            Some("19.8")
        );
        assert_eq!(
            version_of(Path::new("/x/instantclient_23_3")).as_deref(),
            Some("23.3")
        );
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("libclntsh.dylib.11.1"), "").unwrap();
        std::fs::write(dir.path().join("libclntsh.dylib.19.1"), "").unwrap();
        assert_eq!(version_of(dir.path()).as_deref(), Some("19.1"));
    }

    #[test]
    fn a_folder_counts_when_it_holds_the_library() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_client(dir.path()));
        std::fs::write(dir.path().join(LIB), "").unwrap();
        assert!(has_client(dir.path()));
    }

    #[test]
    fn the_configured_folder_is_looked_in_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(LIB), "").unwrap();
        let s = status(Some(&dir.path().to_string_lossy()));
        assert!(s.found);
        assert_eq!(s.dir.as_deref(), Some(&*dir.path().to_string_lossy()));
        assert_eq!(s.searched[0], dir.path().to_string_lossy());
    }

    #[test]
    fn nothing_found_lists_where_it_looked() {
        let dir = tempfile::tempdir().unwrap();
        let s = status(Some(&dir.path().join("nope").to_string_lossy()));
        assert!(!s.searched.is_empty());
        assert_eq!(missing("x").code, ErrorCode::DriverUnavailable);
    }
}
