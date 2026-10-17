//! The "Copy diagnostics" report (spec: release-qa › Diagnostics bundle): versions, platform,
//! enabled drivers, the active connection's server and the log tail, with secrets, hostnames,
//! usernames and home-directory paths replaced by markers. It never includes query text or rows.

use regex::{Captures, Regex};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

pub const HOST_MARK: &str = "‹host›";
pub const USER_MARK: &str = "‹user›";
pub const SECRET_MARK: &str = "‹redacted›";
const LOG_LINES: usize = 200;

/// Replaces what must not leave the machine.
pub struct Redactor {
    hosts: Vec<String>,
    users: Vec<String>,
    home: Option<String>,
}

impl Redactor {
    /// `hosts` and `users` come from the saved connections; `home` is the home directory.
    pub fn new(hosts: Vec<String>, users: Vec<String>, home: Option<String>) -> Self {
        let longest_first = |mut v: Vec<String>| {
            v.retain(|s| s.len() >= 3);
            v.sort_by_key(|s| std::cmp::Reverse(s.len()));
            v.dedup();
            v
        };
        Self {
            hosts: longest_first(hosts),
            users: longest_first(users),
            home: home.filter(|h| h.len() > 1),
        }
    }

    pub fn apply(&self, text: &str) -> String {
        let url = Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)([^/\s:@]+)(:[^/\s@]*)?@([^/\s:?#]+)")
            .unwrap();
        let kv = Regex::new(
            r#"(?i)\b(password|passwd|pwd|passphrase|secret|token|api[_-]?key)\b(["']?\s*[:=]\s*["']?)[^\s"',;&)]+"#,
        )
        .unwrap();
        let bearer = Regex::new(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+").unwrap();
        let keys = Regex::new(r"\b(sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9]{20,})").unwrap();

        let mut out = url
            .replace_all(text, |c: &Captures| {
                format!("{}{SECRET_MARK}@{HOST_MARK}", &c[1])
            })
            .into_owned();
        out = kv
            .replace_all(&out, |c: &Captures| {
                format!("{}{}{SECRET_MARK}", &c[1], &c[2])
            })
            .into_owned();
        out = bearer
            .replace_all(&out, |c: &Captures| format!("{} {SECRET_MARK}", &c[1]))
            .into_owned();
        out = keys.replace_all(&out, SECRET_MARK).into_owned();
        for h in &self.hosts {
            out = replace_ci(&out, h, HOST_MARK);
        }
        for u in &self.users {
            out = replace_ci(&out, u, USER_MARK);
        }
        if let Some(home) = &self.home {
            out = out.replace(home.as_str(), "~");
        }
        out
    }
}

fn replace_ci(text: &str, needle: &str, with: &str) -> String {
    let re = Regex::new(&format!("(?i){}", regex::escape(needle))).unwrap();
    re.replace_all(text, with).into_owned()
}

/// What goes into the report, before redaction.
pub struct ReportInput {
    pub version: String,
    pub commit: String,
    pub os: String,
    pub arch: String,
    pub webview: String,
    /// `(name, client library note)`, for example `("Oracle", Some("Instant Client 19.8"))`.
    pub drivers: Vec<(String, Option<String>)>,
    /// `(driver, server version)` of the connection in use.
    pub active: Option<(String, String)>,
    pub log: Vec<String>,
}

pub fn build_report(i: &ReportInput, redactor: &Redactor) -> String {
    let mut lines = vec![
        "Clew diagnostics".to_string(),
        format!("Version: {} (commit {})", i.version, i.commit),
        format!("OS: {} ({})", i.os, i.arch),
        format!("WebView: {}", i.webview),
        "Drivers:".to_string(),
    ];
    for (name, client) in &i.drivers {
        lines.push(match client {
            Some(c) => format!("- {name}: {c}"),
            None => format!("- {name}"),
        });
    }
    lines.push(match &i.active {
        Some((driver, server)) => format!("Active connection: {driver}, server {server}"),
        None => "Active connection: none".to_string(),
    });
    lines.push(format!("Log (last {LOG_LINES} lines):"));
    lines.extend(i.log.iter().cloned());
    redactor.apply(&lines.join("\n"))
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        let v = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        format!("macOS {v}")
    }
    #[cfg(windows)]
    {
        let v = std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        format!("Windows {v}")
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|t| {
                t.lines().find_map(|l| {
                    l.strip_prefix("PRETTY_NAME=")
                        .map(|v| v.trim_matches('"').to_string())
                })
            })
            .unwrap_or_else(|| std::env::consts::OS.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutInfo {
    pub version: String,
    pub commit: String,
}

/// Version and commit for the About dialog.
#[tauri::command]
pub fn about_info(app: tauri::AppHandle) -> AboutInfo {
    AboutInfo {
        version: app.package_info().version.to_string(),
        commit: env!("CLEW_COMMIT").to_string(),
    }
}

/// The third-party license list shipped with the app (generated when a release is built; a
/// development build carries a short note instead).
#[tauri::command]
pub fn licenses_html(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let path = app
        .path()
        .resolve(
            "THIRD_PARTY_LICENSES.html",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    std::fs::read_to_string(path).map_err(|e| format!("The license list isn't available: {e}"))
}

/// The diagnostics report as text. `connection_id` is the connection in use, if any.
#[tauri::command]
pub async fn diagnostics_bundle(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> Result<String, String> {
    let file = state.connections.list().map_err(|e| e.to_string())?;
    let (mut hosts, mut users) = (Vec::new(), Vec::new());
    for c in &file.connections {
        if let Ok(s) = serde_json::to_value(&c.settings) {
            if let Some(h) = s.get("host").and_then(|v| v.as_str()) {
                hosts.push(h.to_string());
            }
            if let Some(u) = s.get("user").and_then(|v| v.as_str()) {
                users.push(u.to_string());
            }
        }
        if let Some(ssh) = &c.ssh {
            hosts.push(ssh.host.clone());
            users.push(ssh.user.clone());
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    if let Some(h) = home.as_deref() {
        // the account name is in the path of every file the log mentions
        if let Some(name) = std::path::Path::new(h).file_name().and_then(|n| n.to_str()) {
            users.push(name.to_string());
        }
    }

    let oracle = crate::drivers::oracle::client::status(None);
    let drivers = state
        .registry
        .list_grouped()
        .into_iter()
        .flat_map(|g| g.drivers)
        .map(|d| {
            let note = (d.id == "oracle").then(|| match (&oracle.found, &oracle.version) {
                (true, Some(v)) => format!("Instant Client {v}"),
                (true, None) => "Instant Client found".to_string(),
                _ => "Instant Client not found".to_string(),
            });
            (d.name.to_string(), note)
        })
        .collect();

    let active = match connection_id {
        Some(id) => {
            let driver = file
                .connections
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.driver.clone());
            match (driver, state.sessions.connection_server(&id).await) {
                (Some(d), Ok(s)) => Some((d, s.display())),
                (Some(d), Err(_)) => Some((d, "not connected".to_string())),
                _ => None,
            }
        }
        None => None,
    };

    let input = ReportInput {
        version: app.package_info().version.to_string(),
        commit: env!("CLEW_COMMIT").to_string(),
        os: os_version(),
        arch: std::env::consts::ARCH.to_string(),
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        drivers,
        active,
        log: crate::applog::tail(LOG_LINES),
    };
    Ok(build_report(&input, &Redactor::new(hosts, users, home)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactor() -> Redactor {
        Redactor::new(
            vec!["db.internal.example".into()],
            vec!["bob".into()],
            Some("/Users/alice".into()),
        )
    }

    /// (spec: release-qa › Secrets are redacted)
    #[test]
    fn a_connection_error_loses_its_host_and_password() {
        let log = r#"connect to db.internal.example failed for "bob": password=hunter2 refused"#;
        let out = redactor().apply(log);
        assert!(out.contains(HOST_MARK), "{out}");
        assert!(out.contains(SECRET_MARK), "{out}");
        assert!(!out.contains("db.internal.example"));
        assert!(!out.contains("hunter2"));
        assert!(!out.contains("bob"));
    }

    #[test]
    fn credentials_in_urls_tokens_and_keys_are_replaced() {
        let r = redactor();
        let out = r.apply("postgres://carol:s3cret@other.host:5432/app");
        assert_eq!(
            out,
            format!("postgres://{SECRET_MARK}@{HOST_MARK}:5432/app")
        );
        assert_eq!(
            r.apply("Authorization: Bearer abc.def-ghi"),
            format!("Authorization: Bearer {SECRET_MARK}")
        );
        assert_eq!(
            r.apply("key sk-ant-1234567890abc"),
            format!("key {SECRET_MARK}")
        );
        assert!(!r.apply(r#"{"apiKey": "zzz999"}"#).contains("zzz999"));
        assert!(!r
            .apply("ghp_abcdefghijklmnopqrstuvwxyz0123")
            .contains("ghp_"));
    }

    #[test]
    fn home_directory_paths_are_shortened_and_hosts_match_any_case() {
        let r = redactor();
        assert_eq!(r.apply("opened /Users/alice/x/y.sql"), "opened ~/x/y.sql");
        assert!(r.apply("DB.INTERNAL.EXAMPLE").contains(HOST_MARK));
    }

    #[test]
    fn plain_text_is_left_alone() {
        assert_eq!(
            redactor().apply("history retained 10000 rows"),
            "history retained 10000 rows"
        );
    }

    /// (spec: release-qa › Copy diagnostics)
    #[test]
    fn the_report_has_every_required_section() {
        let input = ReportInput {
            version: "0.1.0".into(),
            commit: "abc1234".into(),
            os: "macOS 15.1".into(),
            arch: "aarch64".into(),
            webview: "605.1.15".into(),
            drivers: vec![
                ("PostgreSQL".into(), None),
                ("Oracle".into(), Some("Instant Client 19.8".into())),
            ],
            active: Some(("postgres".into(), "PostgreSQL 16.2".into())),
            log: vec!["line one".into(), "line two".into()],
        };
        let out = build_report(&input, &redactor());
        for needle in [
            "Version: 0.1.0 (commit abc1234)",
            "OS: macOS 15.1 (aarch64)",
            "WebView: 605.1.15",
            "- Oracle: Instant Client 19.8",
            "Active connection: postgres, server PostgreSQL 16.2",
            "Log (last 200 lines):",
            "line two",
        ] {
            assert!(out.contains(needle), "missing {needle:?} in\n{out}");
        }
    }
}
