use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;

use super::passwords::tests::Fake;
use super::*;
use crate::connections::exchange::{write_export, KdfParams};
use crate::connections::export::ExportOptions;
use crate::connections::secrets::{MemoryStore, SecretStore};
use crate::connections::service::{PasswordPrompt, PasswordPrompter};
use crate::connections::store::tests::conn;

struct NoPrompt;

#[async_trait]
impl PasswordPrompter for NoPrompt {
    async fn ask(&self, _: PasswordPrompt) -> Option<Secret> {
        None
    }
}

struct Fx {
    dir: tempfile::TempDir,
    svc: ConnectionService,
    secrets: Arc<MemoryStore>,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemoryStore::default());
    let (svc, _) = ConnectionService::new(
        &dir.path().join("data"),
        secrets.clone(),
        Arc::new(NoPrompt),
    );
    Fx { dir, svc, secrets }
}

impl Fx {
    fn env(&self) -> ImportEnv {
        ImportEnv {
            scripts_root: self.dir.path().join("Scripts"),
            ssh_keys_dir: self.dir.path().join("ssh-keys"),
        }
    }
    fn existing(&self) -> Vec<Connection> {
        self.svc.list().unwrap().connections
    }
}

const UUID_PROD: &str = "11111111-1111-1111-1111-111111111111";

fn datagrip_dir(root: &Path) -> PathBuf {
    let dir = root.join("DataGrip2026.1");
    datagrip::fixtures::write_config_dir(&dir);
    let consoles = dir.join("consoles/db").join(UUID_PROD);
    std::fs::create_dir_all(&consoles).unwrap();
    for (i, q) in ["select 1", "select 2", "select 3", "select 4"]
        .iter()
        .enumerate()
    {
        std::fs::write(consoles.join(format!("console{i}.sql")), q).unwrap();
    }
    std::fs::create_dir_all(dir.join("scratches")).unwrap();
    std::fs::write(dir.join("scratches/scratch.sql"), "select 'scratch'").unwrap();
    dir
}

fn keep_all() -> CommitOptions {
    CommitOptions {
        environment: None,
        group: GroupMode::Keep,
        import_sql_files: true,
    }
}

fn select(keys: &[&str]) -> Vec<Selection> {
    keys.iter()
        .map(|k| Selection {
            key: (*k).into(),
            merge_only: false,
        })
        .collect()
}

fn by_name<'a>(scan: &'a Scan, name: &str) -> &'a Candidate {
    scan.candidates.iter().find(|c| c.name == name).unwrap()
}

#[test]
fn datagrip_scan_lists_statuses_counts_and_notes() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    let scan = scan_datagrip(&dir, &[], None, &f.existing());
    assert_eq!(scan.candidates.len(), 7);
    assert_eq!(by_name(&scan, "analytics-prod").sql.len(), 4);
    assert_eq!(by_name(&scan, "analytics-prod").status, Status::New);
    assert_eq!(by_name(&scan, "old-cassandra").status, Status::Unavailable);
    assert_eq!(
        by_name(&scan, "old-cassandra").note.as_deref(),
        Some("Driver not available")
    );
    assert_eq!(
        by_name(&scan, "url-only").note.as_deref(),
        Some("password moved out of the URL")
    );
    assert_eq!(scan.scratches.len(), 1);
    let v = view(by_name(&scan, "reporting-oracle"));
    assert_eq!(
        (v.driver.as_str(), v.address.as_str()),
        ("oracle", "ora.internal:1521/REPORTS")
    );
}

#[test]
fn already_in_clew_is_detected_by_driver_host_port_database_and_user() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    let mut same = conn("c9", "prod-postgres");
    same.settings = Settings::Network {
        host: "DB.internal".into(),
        port: 5432,
        database: Some("analytics".into()),
        user: Some("karthik".into()),
        password_mode: super::super::model::PasswordMode::Keychain,
    };
    f.svc
        .save(SaveRequest {
            connection: same,
            password: SecretUpdate::Keep,
            ssh_passphrase: SecretUpdate::Keep,
            ssh_password: SecretUpdate::Keep,
        })
        .unwrap();
    let scan = scan_datagrip(&dir, &[], None, &f.existing());
    let c = by_name(&scan, "analytics-prod");
    assert_eq!(c.status, Status::Existing);
    assert_eq!(c.existing_id.as_deref(), Some("c9"));
    assert_eq!(c.note.as_deref(), Some("Already in Clew"));
}

#[test]
fn commit_creates_connections_with_environment_group_secrets_and_linked_consoles() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    let scan = scan_datagrip(
        &dir,
        &[],
        Some(&Fake(BTreeMap::from([(
            UUID_PROD.to_string(),
            "dg-pass".to_string(),
        )]))),
        &f.existing(),
    );
    let id = f.svc.store_scan(scan).scan_id;
    let result = f
        .svc
        .import_commit(
            &id,
            &select(&[
                "datagrip-11111111-1111-1111-1111-111111111111",
                "datagrip-55555555-5555-5555-5555-555555555555",
            ]),
            &keep_all(),
            &f.env(),
        )
        .unwrap();
    assert_eq!((result.added, result.merged), (2, 0));
    assert_eq!(
        result.sql_files,
        4 + 1,
        "four consoles plus the scratch file"
    );

    let all = f.existing();
    let prod = all.iter().find(|c| c.name == "analytics-prod").unwrap();
    assert_eq!(prod.environment, Environment::Production);
    assert!(prod.safeguards.read_only_by_default);
    assert!(prod.group_id.is_some(), "DataGrip group kept");
    assert!(prod.ssh.as_ref().unwrap().enabled);
    // password went to the keychain, never into connections.json
    assert!(f
        .secrets
        .get(&prod.id, SecretKind::Password)
        .unwrap()
        .is_some());
    let json = std::fs::read_to_string(f.svc.file_path()).unwrap();
    assert!(!json.contains("dg-pass") && !json.contains("hunter2"));
    // consoles copied and linked, originals untouched
    let scripts = PathBuf::from(prod.scripts_dir.clone().unwrap());
    assert!(scripts.ends_with("analytics-prod"));
    assert_eq!(std::fs::read_dir(&scripts).unwrap().count(), 4);
    assert!(dir
        .join("consoles/db")
        .join(UUID_PROD)
        .join("console0.sql")
        .exists());
    assert_eq!(
        std::fs::read_dir(f.env().scripts_root.join("Scratches"))
            .unwrap()
            .count(),
        1
    );

    // url-only password moved to the keychain
    let url_only = all.iter().find(|c| c.name == "url-only").unwrap();
    assert_eq!(
        f.secrets
            .get(&url_only.id, SecretKind::Password)
            .unwrap()
            .unwrap()
            .expose(),
        "hunter2"
    );
}

#[test]
fn environment_option_overrides_detection_and_single_group_collects_all() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    let id = f
        .svc
        .store_scan(scan_datagrip(&dir, &[], None, &f.existing()))
        .scan_id;
    let opts = CommitOptions {
        environment: Some(Environment::Staging),
        group: GroupMode::Single {
            name: "Imported from DataGrip".into(),
        },
        import_sql_files: false,
    };
    f.svc
        .import_commit(
            &id,
            &select(&[
                "datagrip-11111111-1111-1111-1111-111111111111",
                "datagrip-22222222-2222-2222-2222-222222222222",
            ]),
            &opts,
            &f.env(),
        )
        .unwrap();
    let file = f.svc.list().unwrap();
    assert_eq!(file.groups.len(), 1);
    assert_eq!(file.groups[0].name, "Imported from DataGrip");
    assert!(file
        .connections
        .iter()
        .all(|c| c.environment == Environment::Staging
            && c.group_id.as_deref() == Some(file.groups[0].id.as_str())));
    assert!(
        !f.env().scripts_root.exists(),
        "no SQL files when the option is off"
    );
}

#[test]
fn merge_only_links_consoles_to_the_existing_connection_without_a_new_one() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    let mut same = conn("c9", "prod-postgres");
    same.settings = Settings::Network {
        host: "db.internal".into(),
        port: 5432,
        database: Some("analytics".into()),
        user: Some("karthik".into()),
        password_mode: super::super::model::PasswordMode::Keychain,
    };
    let scripts = f.dir.path().join("existing-scripts");
    same.scripts_dir = Some(scripts.to_string_lossy().into_owned());
    f.svc
        .save(SaveRequest {
            connection: same,
            password: SecretUpdate::Keep,
            ssh_passphrase: SecretUpdate::Keep,
            ssh_password: SecretUpdate::Keep,
        })
        .unwrap();

    let id = f
        .svc
        .store_scan(scan_datagrip(&dir, &[], None, &f.existing()))
        .scan_id;
    let sel = vec![Selection {
        key: "datagrip-11111111-1111-1111-1111-111111111111".into(),
        merge_only: true,
    }];
    let result = f
        .svc
        .import_commit(&id, &sel, &keep_all(), &f.env())
        .unwrap();
    assert_eq!((result.added, result.merged), (0, 1));
    assert_eq!(f.existing().len(), 1);
    assert_eq!(std::fs::read_dir(&scripts).unwrap().count(), 4);
}

#[test]
fn name_and_file_collisions_get_suffixes_and_nothing_is_overwritten() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    f.svc
        .save(SaveRequest {
            connection: conn("c1", "billing-mysql"),
            password: SecretUpdate::Keep,
            ssh_passphrase: SecretUpdate::Keep,
            ssh_password: SecretUpdate::Keep,
        })
        .unwrap();
    // a pre-existing file in the target folder
    let target = f.env().scripts_root.join("analytics-prod");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("console0.sql"), "MINE").unwrap();

    let id = f
        .svc
        .store_scan(scan_datagrip(&dir, &[], None, &f.existing()))
        .scan_id;
    f.svc
        .import_commit(
            &id,
            &select(&[
                "datagrip-11111111-1111-1111-1111-111111111111",
                "datagrip-22222222-2222-2222-2222-222222222222",
            ]),
            &keep_all(),
            &f.env(),
        )
        .unwrap();
    let names: Vec<_> = f.existing().into_iter().map(|c| c.name).collect();
    assert!(names.contains(&"billing-mysql 2".to_string()), "{names:?}");
    assert_eq!(
        std::fs::read_to_string(target.join("console0.sql")).unwrap(),
        "MINE"
    );
    assert_eq!(std::fs::read_dir(&target).unwrap().count(), 5);
}

#[test]
fn unavailable_candidates_cannot_be_imported_and_scans_expire() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    let id = f
        .svc
        .store_scan(scan_datagrip(&dir, &[], None, &f.existing()))
        .scan_id;
    let r = f
        .svc
        .import_commit(
            &id,
            &select(&["datagrip-66666666-6666-6666-6666-666666666666"]),
            &keep_all(),
            &f.env(),
        )
        .unwrap();
    assert_eq!(r.added, 0);
    assert_eq!(
        f.svc
            .import_commit(&id, &[], &keep_all(), &f.env())
            .unwrap_err()
            .code,
        "scan_expired"
    );
}

#[test]
fn dbeaver_and_pgpass_scans_import_with_optional_passwords() {
    let f = fx();
    let text = r#"{"connections":{"a":{"provider":"postgresql","name":"analytics-prod","configuration":{"host":"h","port":"5432","database":"d","type":"prod","url":"jdbc:postgresql://h:5432/d"}},
        "b":{"provider":"cassandra","name":"cass","configuration":{"host":"c","port":"9042"}}}}"#;
    let scan = scan_dbeaver(text, &f.existing()).unwrap();
    assert_eq!(scan.candidates.len(), 2);
    let id = f.svc.store_scan(scan).scan_id;
    let opts = CommitOptions {
        environment: None,
        group: GroupMode::Single {
            name: "Imported".into(),
        },
        import_sql_files: false,
    };
    let r = f
        .svc
        .import_commit(&id, &select(&["dbeaver-0", "dbeaver-1"]), &opts, &f.env())
        .unwrap();
    assert_eq!(r.added, 1);
    assert!(
        f.secrets.is_empty(),
        "DBeaver imports never carry passwords"
    );

    let pg = "db.internal:5432:app:ann:s3cret\n*:*:*:*:wild\n";
    let without = scan_pgpass(pg, false, &f.existing());
    assert!(without.candidates[0].secrets.is_empty());
    let with = scan_pgpass(pg, true, &f.existing());
    assert_eq!(with.candidates.len(), 1);
    let id = f.svc.store_scan(with).scan_id;
    f.svc
        .import_commit(&id, &select(&["pgpass-0"]), &opts, &f.env())
        .unwrap();
    let saved = f
        .existing()
        .into_iter()
        .find(|c| c.name == "app@db.internal")
        .unwrap();
    assert_eq!(
        f.secrets
            .get(&saved.id, SecretKind::Password)
            .unwrap()
            .unwrap()
            .expose(),
        "s3cret"
    );
}

#[test]
fn datagrip_passwords_need_the_keepass_master_password_when_datagrip_uses_keepass() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    std::fs::write(
        dir.join("options/security.xml"),
        r#"<application><component name="PasswordSafe"><option name="PROVIDER" value="KEEPASS" /></component></application>"#,
    )
    .unwrap();
    let source = |pw: Option<&str>| ImportSource::DataGrip {
        dir: dir.to_string_lossy().into_owned(),
        projects: vec![],
        include_passwords: true,
        keepass_password: pw.map(Secret::new),
    };
    assert_eq!(
        f.svc.import_scan(source(None)).unwrap_err().code,
        "needs_keepass_password"
    );
    // no kdbx on disk: scan still works, with a warning
    let view = f.svc.import_scan(source(Some("x"))).unwrap();
    assert!(view
        .warnings
        .iter()
        .any(|w| w.contains("KeePass database was not found")));
    assert_eq!(f.svc.password_safe_info(&dir).mode, "keepass");
}

#[test]
fn do_not_save_mode_skips_password_lookup() {
    let f = fx();
    let dir = datagrip_dir(f.dir.path());
    std::fs::write(
        dir.join("options/security.xml"),
        r#"<application><component name="PasswordSafe"><option name="PROVIDER" value="MEMORY_ONLY" /></component></application>"#,
    )
    .unwrap();
    let view = f
        .svc
        .import_scan(ImportSource::DataGrip {
            dir: dir.to_string_lossy().into_owned(),
            projects: vec![],
            include_passwords: true,
            keepass_password: None,
        })
        .unwrap();
    assert!(view
        .candidates
        .iter()
        .all(|c| !c.has_password || c.note.as_deref() == Some("password moved out of the URL")));
    assert_eq!(f.svc.password_safe_info(&dir).mode, "none");
}

// ---- Clew export round trip --------------------------------------------------------------

#[test]
fn export_then_import_round_trips_settings_secrets_keys_and_sql_files() {
    let src = fx();
    let key = src.dir.path().join("id_ed25519");
    std::fs::write(&key, "PEM-DATA").unwrap();
    let scripts = src.dir.path().join("src-scripts");
    std::fs::create_dir(&scripts).unwrap();
    std::fs::write(scripts.join("q.sql"), "select 1;").unwrap();
    let mut c = conn("c1", "prod-postgres");
    c.ssh = Some(super::super::model::SshSettings {
        enabled: true,
        host: "bastion".into(),
        port: 22,
        user: "tunnel".into(),
        auth: super::super::model::SshAuthKind::Key,
        key_file: Some(key.to_string_lossy().into_owned()),
    });
    c.scripts_dir = Some(scripts.to_string_lossy().into_owned());
    src.svc
        .save(SaveRequest {
            connection: c,
            password: SecretUpdate::Set {
                value: Secret::new("db-pw"),
            },
            ssh_passphrase: SecretUpdate::Set {
                value: Secret::new("key-pass"),
            },
            ssh_password: SecretUpdate::Keep,
        })
        .unwrap();
    let all = ExportOptions {
        include_passwords: true,
        include_ssh_keys: true,
        include_sql_files: true,
    };
    let (text, _) = src
        .svc
        .export_text(
            &["c1".into()],
            all,
            Some("correct horse battery"),
            "2026-10-10T09:00:00Z",
            KdfParams { m: 64, t: 1, p: 1 },
        )
        .unwrap();

    let dst = fx();
    let scan = scan_clew(&text, Some("correct horse battery"), &dst.existing()).unwrap();
    let view_ = view(&scan.candidates[0]);
    assert_eq!(
        (view_.sql_files, view_.has_password, view_.status),
        (1, true, Status::New)
    );
    let id = dst.svc.store_scan(scan).scan_id;
    let r = dst
        .svc
        .import_commit(&id, &select(&["c1"]), &keep_all(), &dst.env())
        .unwrap();
    assert_eq!((r.added, r.sql_files), (1, 1));

    let imported = dst.existing().remove(0);
    assert_ne!(imported.id, "c1");
    assert_eq!(
        dst.secrets
            .get(&imported.id, SecretKind::Password)
            .unwrap()
            .unwrap()
            .expose(),
        "db-pw"
    );
    assert_eq!(
        dst.secrets
            .get(&imported.id, SecretKind::SshPassphrase)
            .unwrap()
            .unwrap()
            .expose(),
        "key-pass"
    );
    let key_path = PathBuf::from(imported.ssh.unwrap().key_file.unwrap());
    assert!(key_path.starts_with(dst.env().ssh_keys_dir));
    assert_eq!(std::fs::read_to_string(&key_path).unwrap(), "PEM-DATA");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        std::fs::read_to_string(PathBuf::from(imported.scripts_dir.unwrap()).join("q.sql"))
            .unwrap(),
        "select 1;"
    );
}

#[test]
fn clew_import_failures_are_specific() {
    let f = fx();
    let payload = ExportPayload {
        connections: vec![conn("c1", "dev")],
        ..Default::default()
    };
    let kdf = KdfParams { m: 64, t: 1, p: 1 };
    let mut with_secret = payload.clone();
    with_secret
        .secrets
        .insert("c1:password".into(), "pw".into());
    let enc = write_export(
        &with_secret,
        "Clew",
        "2026-10-10T09:00:00Z",
        Some("correct horse battery"),
        kdf,
    )
    .unwrap();
    assert_eq!(
        scan_clew(&enc, Some("nope nope nope nope"), &f.existing()).unwrap_err(),
        ExchangeError::WrongPassphrase
    );
    assert_eq!(
        scan_clew(
            &enc.replace("\"app\": \"Clew\"", "\"app\": \"Evil\""),
            Some("correct horse battery"),
            &f.existing()
        )
        .unwrap_err(),
        ExchangeError::Damaged
    );
    assert_eq!(
        scan_clew(
            &enc.replace("\"version\": 1", "\"version\": 2"),
            Some("correct horse battery"),
            &f.existing()
        )
        .unwrap_err(),
        ExchangeError::Newer(2)
    );

    let plain = write_export(&payload, "Clew", "2026-10-10T09:00:00Z", None, kdf).unwrap();
    let scan = scan_clew(&plain, None, &[conn("other", "dev")]).unwrap();
    assert_eq!(
        scan.candidates[0].status,
        Status::Existing,
        "same driver/host/port/db/user"
    );
}

#[test]
fn unsafe_sql_paths_in_a_file_are_skipped() {
    let f = fx();
    let mut payload = ExportPayload {
        connections: vec![conn("c1", "dev")],
        ..Default::default()
    };
    payload
        .sql_files
        .push(crate::connections::exchange::SqlFile {
            connection_id: "c1".into(),
            rel_path: "../escape.sql".into(),
            content: "x".into(),
        });
    payload
        .sql_files
        .push(crate::connections::exchange::SqlFile {
            connection_id: "c1".into(),
            rel_path: "ok/a.sql".into(),
            content: "y".into(),
        });
    let text = write_export(&payload, "Clew", "t", None, KdfParams::default()).unwrap();
    let id = f
        .svc
        .store_scan(scan_clew(&text, None, &[]).unwrap())
        .scan_id;
    let r = f
        .svc
        .import_commit(&id, &select(&["c1"]), &keep_all(), &f.env())
        .unwrap();
    assert_eq!(r.sql_files, 1);
    assert!(r.warnings.iter().any(|w| w.contains("unsafe path")));
    assert!(!f.env().scripts_root.join("escape.sql").exists());
    assert!(f.env().scripts_root.join("dev/ok/a.sql").exists());
}
