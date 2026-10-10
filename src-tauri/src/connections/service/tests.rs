use super::*;
use crate::connections::model::{Environment, SshSettings};
use crate::connections::secrets::MemoryStore;
use crate::connections::store::tests::conn;

struct Scripted {
    answer: Mutex<Option<Secret>>,
    asked: AtomicU64,
}

#[async_trait]
impl PasswordPrompter for Scripted {
    async fn ask(&self, _: PasswordPrompt) -> Option<Secret> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.answer.lock().unwrap().clone()
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    svc: ConnectionService,
    secrets: Arc<MemoryStore>,
    prompter: Arc<Scripted>,
}

fn fixture(answer: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemoryStore::default());
    let prompter = Arc::new(Scripted {
        answer: Mutex::new(answer.map(Secret::new)),
        asked: AtomicU64::new(0),
    });
    let (svc, _) = ConnectionService::new(dir.path(), secrets.clone(), prompter.clone());
    Fixture {
        _dir: dir,
        svc,
        secrets,
        prompter,
    }
}

fn set(v: &str) -> SecretUpdate {
    SecretUpdate::Set {
        value: Secret::new(v),
    }
}

fn req(c: Connection, password: SecretUpdate) -> SaveRequest {
    SaveRequest {
        connection: c,
        password,
        ssh_passphrase: SecretUpdate::Keep,
        ssh_password: SecretUpdate::Keep,
    }
}

#[test]
fn no_secret_ever_lands_in_connections_json() {
    let f = fixture(None);
    let mut c = conn("c1", "db");
    c.ssh = Some(SshSettings {
        enabled: true,
        host: "bastion".into(),
        port: 22,
        user: "tunnel".into(),
        auth: SshAuthKind::Key,
        key_file: Some("~/.ssh/id".into()),
    });
    let out = f
        .svc
        .save(SaveRequest {
            connection: c,
            password: set("hunter2-pw"),
            ssh_passphrase: set("pass-phrase-xyz"),
            ssh_password: set("ssh-pw-123"),
        })
        .unwrap();
    assert!(out.warnings.is_empty());
    let text = std::fs::read_to_string(f.svc.file_path()).unwrap();
    for s in ["hunter2-pw", "pass-phrase-xyz", "ssh-pw-123"] {
        assert!(!text.contains(s), "{s} leaked into connections.json");
    }
    assert_eq!(f.secrets.len(), 3);
    let status = f.svc.secret_status("c1");
    assert!(status.password && status.ssh_passphrase && status.ssh_password);
}

#[test]
fn a_new_connection_gets_an_id_and_a_name_is_required() {
    let f = fixture(None);
    let mut c = conn("", "  prod db  ");
    c.id.clear();
    let saved = f.svc.save(req(c, SecretUpdate::Keep)).unwrap().connection;
    assert!(saved.id.starts_with("c_"));
    assert_eq!(saved.name, "prod db");
    let blank = conn("x", "   ");
    assert_eq!(
        f.svc.save(req(blank, SecretUpdate::Keep)).unwrap_err().code,
        "invalid_connection"
    );
}

#[test]
fn production_connections_default_to_all_safeguards_on() {
    let s = Environment::Production.default_safeguards();
    assert!(s.read_only_by_default);
    assert_ne!(Environment::Local.default_safeguards(), s);
}

#[test]
fn a_locked_keychain_saves_the_connection_with_a_warning() {
    let f = fixture(None);
    f.secrets.lock(true);
    let out = f.svc.save(req(conn("c1", "db"), set("pw"))).unwrap();
    assert_eq!(out.warnings, vec![KEYCHAIN_WARNING.to_string()]);
    assert_eq!(f.svc.list().unwrap().connections.len(), 1);
    assert!(f.svc.secret_status("c1").keychain_unavailable);
}

#[test]
fn duplicate_copies_the_secrets_and_names_the_copy() {
    let f = fixture(None);
    f.svc.save(req(conn("c1", "db"), set("pw"))).unwrap();
    let copy = f.svc.duplicate("c1").unwrap().connection;
    assert_eq!(copy.name, "db (copy)");
    assert_ne!(copy.id, "c1");
    assert!(f.svc.secret_status(&copy.id).password);
    let again = f.svc.duplicate("c1").unwrap().connection;
    assert_eq!(again.name, "db (copy) 2");
}

#[test]
fn delete_removes_the_connection_and_its_secrets() {
    let f = fixture(None);
    f.svc.save(req(conn("c1", "db"), set("pw"))).unwrap();
    assert!(f.svc.delete("c1").unwrap().is_empty());
    assert!(f.svc.list().unwrap().connections.is_empty());
    assert!(f.secrets.is_empty());
}

#[test]
fn switching_away_from_keychain_mode_drops_the_stored_password() {
    let f = fixture(None);
    f.svc.save(req(conn("c1", "db"), set("pw"))).unwrap();
    let mut c = conn("c1", "db");
    if let Settings::Network { password_mode, .. } = &mut c.settings {
        *password_mode = PasswordMode::Ask;
    }
    f.svc.save(req(c, SecretUpdate::Keep)).unwrap();
    assert!(f.secrets.is_empty());
}

#[test]
fn groups_are_saved_and_deleting_one_ungroups_its_connections() {
    let f = fixture(None);
    let g = f
        .svc
        .save_group(Group {
            id: String::new(),
            name: "Work".into(),
            order: 0,
        })
        .unwrap();
    assert!(g.id.starts_with("g_"));
    let mut c = conn("c1", "db");
    c.group_id = Some(g.id.clone());
    f.svc.save(req(c, SecretUpdate::Keep)).unwrap();
    f.svc.delete_group(&g.id).unwrap();
    let file = f.svc.list().unwrap();
    assert!(file.groups.is_empty());
    assert_eq!(file.connections[0].group_id, None);
}

#[tokio::test]
async fn resolve_uses_the_keychain_without_asking() {
    let f = fixture(None);
    f.svc.save(req(conn("c1", "db"), set("stored"))).unwrap();
    let cfg = f.svc.resolve("c1").await.unwrap();
    assert_eq!(cfg.password.unwrap().expose(), "stored");
    assert_eq!(cfg.user.as_deref(), Some("u"));
    assert_eq!(f.prompter.asked.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn ask_mode_prompts_once_per_session_and_forgets_on_close() {
    let f = fixture(Some("typed"));
    let mut c = conn("c1", "db");
    if let Settings::Network { password_mode, .. } = &mut c.settings {
        *password_mode = PasswordMode::Ask;
    }
    f.svc.save(req(c, SecretUpdate::Keep)).unwrap();
    assert_eq!(
        f.svc
            .resolve("c1")
            .await
            .unwrap()
            .password
            .unwrap()
            .expose(),
        "typed"
    );
    f.svc.resolve("c1").await.unwrap();
    assert_eq!(
        f.prompter.asked.load(Ordering::SeqCst),
        1,
        "cached for the session"
    );
    assert!(f.secrets.is_empty(), "typed passwords are never stored");
    f.svc.forget_session_secrets("c1");
    f.svc.resolve("c1").await.unwrap();
    assert_eq!(f.prompter.asked.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cancelling_the_prompt_fails_the_resolve() {
    let f = fixture(None);
    let mut c = conn("c1", "db");
    if let Settings::Network { password_mode, .. } = &mut c.settings {
        *password_mode = PasswordMode::Ask;
    }
    f.svc.save(req(c, SecretUpdate::Keep)).unwrap();
    assert_eq!(
        f.svc.resolve("c1").await.unwrap_err().code,
        ErrorCode::Cancelled
    );
}

#[tokio::test]
async fn a_locked_keychain_falls_back_to_asking() {
    let f = fixture(Some("typed"));
    f.svc.save(req(conn("c1", "db"), set("stored"))).unwrap();
    f.secrets.lock(true);
    assert_eq!(
        f.svc
            .resolve("c1")
            .await
            .unwrap()
            .password
            .unwrap()
            .expose(),
        "typed"
    );
}

#[tokio::test]
async fn resolve_maps_each_settings_kind() {
    let f = fixture(None);
    let mut c = conn("f1", "file");
    c.driver = "sqlite".into();
    c.settings = Settings::File {
        path: "~/x.db".into(),
        create_if_missing: true,
    };
    let cfg = f.svc.resolve_connection(&c).await.unwrap();
    match cfg.target {
        Target::File {
            path,
            create_if_missing,
            ..
        } => {
            assert!(!path.starts_with('~'));
            assert!(create_if_missing);
        }
        other => panic!("{other:?}"),
    }

    let mut c = conn("p1", "prod");
    c.environment = Environment::Production;
    c.safeguards = Environment::Production.default_safeguards();
    c.settings = Settings::Network {
        host: "h".into(),
        port: 5432,
        database: Some("d".into()),
        user: None,
        password_mode: PasswordMode::None,
    };
    c.advanced.query_timeout_sec = 0;
    c.advanced.on_connect = vec!["SET x = 1".into()];
    let cfg = f.svc.resolve_connection(&c).await.unwrap();
    assert!(cfg.read_only);
    assert_eq!(cfg.query_timeout_secs, None);
    assert_eq!(cfg.database.as_deref(), Some("d"));
    assert_eq!(cfg.on_connect, vec!["SET x = 1".to_string()]);
    assert!(cfg.password.is_none());
}

#[tokio::test]
async fn a_draft_test_uses_the_typed_password_and_never_prompts() {
    let f = fixture(Some("should-not-be-asked"));
    let typed = f
        .svc
        .resolve_draft(&req(conn("", "db"), set("typed")))
        .await
        .unwrap();
    assert_eq!(typed.password.unwrap().expose(), "typed");
    let none = f
        .svc
        .resolve_draft(&req(conn("", "db"), SecretUpdate::Keep))
        .await
        .unwrap();
    assert!(none.password.is_none());
    assert_eq!(f.prompter.asked.load(Ordering::SeqCst), 0);
    assert!(f.secrets.is_empty(), "testing saves nothing");
}

mod export_tests {
    use super::*;
    use crate::connections::exchange::{read_export, KdfParams};
    use crate::connections::export::ExportOptions;

    const FAST: KdfParams = KdfParams { m: 64, t: 1, p: 1 };
    const PASS: &str = "correct horse battery";

    fn all() -> ExportOptions {
        ExportOptions {
            include_passwords: true,
            include_ssh_keys: true,
            include_sql_files: true,
        }
    }

    fn ssh_conn(id: &str, name: &str, key: &str) -> Connection {
        let mut c = conn(id, name);
        c.ssh = Some(SshSettings {
            enabled: true,
            host: "bastion".into(),
            port: 22,
            user: "tunnel".into(),
            auth: SshAuthKind::Key,
            key_file: Some(key.into()),
        });
        c
    }

    #[test]
    fn exports_secrets_keys_and_sql_files_and_imports_them_back() {
        let f = fixture(None);
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("id_ed25519");
        std::fs::write(&key, "PEM-DATA").unwrap();
        let scripts = dir.path().join("scripts");
        std::fs::create_dir(&scripts).unwrap();
        std::fs::write(scripts.join("q.sql"), "select 1;").unwrap();

        let mut c = ssh_conn("c1", "prod-postgres", key.to_str().unwrap());
        c.scripts_dir = Some(scripts.to_string_lossy().into_owned());
        f.svc
            .save(SaveRequest {
                connection: c,
                password: set("db-pw"),
                ssh_passphrase: set("key-pass"),
                ssh_password: SecretUpdate::Keep,
            })
            .unwrap();
        f.svc
            .save(req(conn("c2", "other"), SecretUpdate::Keep))
            .unwrap();

        let (text, summary) = f
            .svc
            .export_text(
                &["c1".into()],
                all(),
                Some(PASS),
                "2026-10-10T09:00:00Z",
                FAST,
            )
            .unwrap();
        assert!(summary.encrypted && summary.warnings.is_empty());
        assert_eq!(
            (
                summary.counts.connections,
                summary.counts.passwords,
                summary.counts.ssh_keys,
                summary.counts.sql_files
            ),
            (1, 2, 1, 1)
        );
        for secret in ["db-pw", "key-pass", "PEM-DATA", "select 1"] {
            assert!(!text.contains(secret));
        }
        let back = read_export(&text, Some(PASS)).unwrap();
        assert_eq!(back.connections.len(), 1);
        assert_eq!(
            back.secrets.get("c1:password").map(String::as_str),
            Some("db-pw")
        );
        assert_eq!(
            back.secrets.get("c1:ssh-passphrase").map(String::as_str),
            Some("key-pass")
        );
        assert_eq!(back.ssh_keys[0].pem, "PEM-DATA");
        assert_eq!(back.sql_files[0].rel_path, "q.sql");
    }

    #[test]
    fn without_secrets_the_file_is_plain_and_holds_none() {
        let f = fixture(None);
        f.svc.save(req(conn("c1", "dev"), set("db-pw"))).unwrap();
        let opts = ExportOptions {
            include_passwords: false,
            include_ssh_keys: false,
            include_sql_files: false,
        };
        let (text, summary) = f
            .svc
            .export_text(&["c1".into()], opts, None, "2026-10-10T09:00:00Z", FAST)
            .unwrap();
        assert!(!summary.encrypted);
        assert!(!text.contains("db-pw") && !text.contains("encryption"));
        assert!(read_export(&text, None).unwrap().secrets.is_empty());
    }

    #[test]
    fn a_locked_keychain_and_a_missing_key_become_warnings() {
        let f = fixture(None);
        f.svc
            .save(req(
                ssh_conn("c1", "prod", "/definitely/not/here"),
                set("pw"),
            ))
            .unwrap();
        f.secrets.lock(true);
        let summary = f.svc.export_summary(&["c1".into()], all()).unwrap();
        assert!(summary
            .warnings
            .iter()
            .any(|w| w == "prod: password not included (keychain unavailable)"));
        assert!(summary
            .warnings
            .iter()
            .any(|w| w == "prod: SSH key not found"));
        assert_eq!(summary.counts.passwords, 0);
        assert_eq!(summary.counts.connections, 1);
    }

    #[test]
    fn exporting_nothing_is_an_error_and_groups_travel_with_their_connections() {
        let f = fixture(None);
        assert_eq!(
            f.svc.export_summary(&[], all()).unwrap_err().code,
            "nothing_selected"
        );
        let g = f
            .svc
            .save_group(Group {
                id: String::new(),
                name: "Work".into(),
                order: 0,
            })
            .unwrap();
        let mut c = conn("c1", "db");
        c.group_id = Some(g.id.clone());
        f.svc.save(req(c, SecretUpdate::Keep)).unwrap();
        let (payload, _) = f.svc.collect_export(&["c1".into()], all()).unwrap();
        assert_eq!(payload.groups.len(), 1);
    }
}

#[test]
fn scripts_list_create_and_reveal_stay_inside_the_connections_folder() {
    let f = fixture(None);
    let scripts = f._dir.path().join("my-scripts");
    let mut c = conn("c1", "db");
    c.scripts_dir = Some(scripts.to_string_lossy().into_owned());
    f.svc.save(req(c, SecretUpdate::Keep)).unwrap();

    // The folder doesn't exist yet: an empty list, not an error.
    assert!(f.svc.scripts_list("c1").unwrap().is_empty());

    // New scripts get `.sql`, a safe name, and a numeric suffix instead of overwriting.
    let first = f.svc.scripts_create("c1", "report").unwrap();
    assert!(first.ends_with("report.sql"));
    let second = f.svc.scripts_create("c1", "report").unwrap();
    assert!(second.ends_with("report (2).sql"));
    let odd = f.svc.scripts_create("c1", "a/b: c.sql").unwrap();
    assert!(odd.ends_with("a_b_ c.sql"));
    assert!(std::path::Path::new(&odd).starts_with(&scripts));

    let names: Vec<_> = f
        .svc
        .scripts_list("c1")
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, ["a_b_ c.sql", "report (2).sql", "report.sql"]);

    // A path that escapes the folder is refused before anything is launched.
    assert_eq!(
        f.svc
            .scripts_reveal("c1", Some("../secret"))
            .unwrap_err()
            .code,
        "invalid"
    );
    assert_eq!(
        f.svc
            .scripts_reveal("c1", Some("missing.sql"))
            .unwrap_err()
            .code,
        "not_found"
    );
}
