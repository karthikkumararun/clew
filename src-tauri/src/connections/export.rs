//! Collecting what to export (connections, keychain secrets, SSH key files, linked SQL files) and
//! writing the file.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::exchange::{write_export, Counts, ExportPayload, KdfParams, SqlFile, SshKeyFile};
use super::model::SshAuthKind;
use super::scripts::{list_sql_files, scripts_dir_of};
use super::secrets::SecretKind;
use super::service::{expand_home, ConnectionService};
use crate::error::{AppError, AppResult};

const MAX_KEY_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub include_passwords: bool,
    pub include_ssh_keys: bool,
    pub include_sql_files: bool,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub counts: Counts,
    /// Per-item problems, e.g. "prod-postgres: password not included".
    pub warnings: Vec<String>,
    pub encrypted: bool,
}

impl ConnectionService {
    /// Gather the selected connections and whatever the options ask for. Problems with single
    /// items become warnings; the export continues without them.
    pub fn collect_export(
        &self,
        ids: &[String],
        opts: ExportOptions,
    ) -> AppResult<(ExportPayload, Vec<String>)> {
        let file = self.list()?;
        let wanted: BTreeSet<&String> = ids.iter().collect();
        let connections: Vec<_> = file
            .connections
            .into_iter()
            .filter(|c| wanted.contains(&c.id))
            .collect();
        if connections.is_empty() {
            return Err(AppError::new(
                "nothing_selected",
                "Select at least one connection to export",
            ));
        }
        let group_ids: BTreeSet<_> = connections
            .iter()
            .filter_map(|c| c.group_id.clone())
            .collect();
        let groups = file
            .groups
            .into_iter()
            .filter(|g| group_ids.contains(&g.id))
            .collect();

        let mut payload = ExportPayload {
            groups,
            connections: connections.clone(),
            ..Default::default()
        };
        let mut warnings = Vec::new();

        for c in &connections {
            if opts.include_passwords {
                let mut missing_read = false;
                for kind in SecretKind::ALL {
                    match self.secrets.get(&c.id, kind) {
                        Ok(Some(secret)) => {
                            payload.secrets.insert(
                                super::secrets::account(&c.id, kind),
                                secret.expose().to_string(),
                            );
                        }
                        Ok(None) => {}
                        Err(_) => missing_read = true,
                    }
                }
                if missing_read {
                    warnings.push(format!(
                        "{}: password not included (keychain unavailable)",
                        c.name
                    ));
                }
            }
            if opts.include_ssh_keys {
                if let Some(ssh) = c
                    .ssh
                    .as_ref()
                    .filter(|s| s.enabled && s.auth == SshAuthKind::Key)
                {
                    let path = expand_home(ssh.key_file.as_deref().unwrap_or("~/.ssh/id_ed25519"));
                    match read_key(Path::new(&path)) {
                        Some(pem) => payload.ssh_keys.push(SshKeyFile {
                            connection_id: c.id.clone(),
                            file_name: Path::new(&path)
                                .file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                                .unwrap_or_else(|| "id_key".into()),
                            pem,
                        }),
                        None => warnings.push(format!("{}: SSH key not found", c.name)),
                    }
                }
            }
            if opts.include_sql_files {
                if let Some(dir) = scripts_dir_of(c) {
                    for (rel_path, content) in list_sql_files(&dir) {
                        payload.sql_files.push(SqlFile {
                            connection_id: c.id.clone(),
                            rel_path,
                            content,
                        });
                    }
                }
            }
        }
        Ok((payload, warnings))
    }

    /// Counts and warnings for the Export tab, without writing anything.
    pub fn export_summary(&self, ids: &[String], opts: ExportOptions) -> AppResult<ExportSummary> {
        let (payload, warnings) = self.collect_export(ids, opts)?;
        Ok(ExportSummary {
            counts: payload.counts(),
            warnings,
            encrypted: payload.has_secrets(),
        })
    }

    /// Build the export file text.
    pub fn export_text(
        &self,
        ids: &[String],
        opts: ExportOptions,
        passphrase: Option<&str>,
        created_at: &str,
        kdf: KdfParams,
    ) -> AppResult<(String, ExportSummary)> {
        let (payload, warnings) = self.collect_export(ids, opts)?;
        let encrypted = payload.has_secrets();
        let text = write_export(
            &payload,
            concat!("Clew ", env!("CARGO_PKG_VERSION")),
            created_at,
            if encrypted { passphrase } else { None },
            kdf,
        )?;
        Ok((
            text,
            ExportSummary {
                counts: payload.counts(),
                warnings,
                encrypted,
            },
        ))
    }
}

fn read_key(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_KEY_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Write `text` to `path` through a temp file so a crash never leaves a half-written export.
pub fn write_atomic(path: &Path, text: &str) -> AppResult<()> {
    let tmp = path.with_extension("clew-tmp");
    std::fs::write(&tmp, text)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            AppError::new("io", "Couldn't write the export file").with_detail(e.to_string())
        })
}
