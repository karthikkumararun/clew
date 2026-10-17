use std::sync::atomic::Ordering;
use std::time::Duration;

use super::*;
use crate::ai::copilot::testing::{fake_install, integrity_of, package, FakeLauncher, Script};
use crate::ai::test_server::{serve_with, Canned};

const VERSION: &str = "9.9.9";

struct Rig {
    svc: Arc<CopilotService>,
    script: Arc<Script>,
    states: Arc<Mutex<Vec<CopilotState>>>,
    dir: tempfile::TempDir,
}

fn rig_with(registry: &str, installed: bool, platform: Option<&'static str>) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    if installed {
        fake_install(dir.path(), VERSION);
    }
    let script = Script::new();
    let states = Arc::new(Mutex::new(Vec::new()));
    let log = states.clone();
    let svc = CopilotService::with(
        dir.path().to_path_buf(),
        VERSION.to_string(),
        platform,
        registry.to_string(),
        Arc::new(FakeLauncher(script.clone())),
        Arc::new(move |s| log.lock().unwrap().push(s.clone())),
    );
    Rig {
        svc,
        script,
        states,
        dir,
    }
}

fn rig(installed: bool) -> Rig {
    rig_with("http://127.0.0.1:1", installed, Some("test-1"))
}

/// Wait until the service reaches a state matching `f`.
async fn until(svc: &CopilotService, f: impl Fn(&CopilotState) -> bool) -> CopilotState {
    for _ in 0..200 {
        let s = svc.state();
        if f(&s) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never reached the state; stuck at {:?}", svc.state());
}

fn phases(r: &Rig) -> Vec<String> {
    r.states
        .lock()
        .unwrap()
        .iter()
        .map(|s| {
            serde_json::to_value(s).unwrap()["phase"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

/// (spec: ai-providers › Successful sign-in)
#[tokio::test]
async fn the_device_flow_shows_a_code_then_signs_in() {
    let r = rig(true);
    r.svc.begin().await;
    let CopilotState::Pending {
        user_code,
        verification_uri,
        expires_at_ms,
    } = until(&r.svc, |s| matches!(s, CopilotState::Pending { .. })).await
    else {
        unreachable!()
    };
    assert_eq!(user_code, "ABCD-EFGH");
    assert_eq!(verification_uri, "https://github.com/login/device");
    let left = expires_at_ms - now_ms();
    assert!(
        (14 * 60_000..=15 * 60_000).contains(&left),
        "about 15 minutes: {left}"
    );

    r.script
        .finish_with(json!({ "status": "OK", "user": "ada" }));
    assert_eq!(
        until(&r.svc, |s| matches!(s, CopilotState::In { .. })).await,
        CopilotState::In {
            login: "ada".into()
        }
    );
    assert_eq!(phases(&r), vec!["starting", "pending", "in"]);
    // The handshake the server expects.
    let m = r.script.methods();
    let at = |name: &str| {
        m.iter()
            .position(|x| x == name)
            .unwrap_or_else(|| panic!("{name} in {m:?}"))
    };
    assert!(at("initialize") < at("initialized"));
    assert!(at("signIn") < at("workspace/executeCommand"));
    let init = &r.script.calls("initialize")[0];
    assert_eq!(init["initializationOptions"]["editorInfo"]["name"], "Clew");
    let cfg = &r.script.calls("workspace/didChangeConfiguration")[0];
    assert_eq!(cfg["settings"]["telemetry"]["telemetryLevel"], "off");
    let exec = &r.script.calls("workspace/executeCommand")[0];
    assert_eq!(exec["command"], "github.copilot.finishDeviceFlow");
}

/// (spec: ai-providers › No Copilot subscription)
#[tokio::test]
async fn an_account_without_copilot_is_reported() {
    let r = rig(true);
    r.svc.begin().await;
    until(&r.svc, |s| matches!(s, CopilotState::Pending { .. })).await;
    r.script
        .finish_with(json!({ "status": "NotAuthorized", "user": "ada" }));
    until(&r.svc, |s| matches!(s, CopilotState::NoAccess)).await;
}

/// (spec: ai-providers › Code expired)
#[tokio::test]
async fn a_code_that_expires_returns_to_signed_out_with_a_message() {
    let r = rig(true);
    r.svc.begin().await;
    until(&r.svc, |s| matches!(s, CopilotState::Pending { .. })).await;
    r.script
        .finish_with(json!({ "__error": "device code expired" }));
    until(&r.svc, |s| matches!(s, CopilotState::Expired)).await;
}

#[tokio::test]
async fn cancel_goes_back_to_signed_out_and_ignores_a_late_answer() {
    let r = rig(true);
    r.svc.begin().await;
    until(&r.svc, |s| matches!(s, CopilotState::Pending { .. })).await;
    r.svc.cancel().await;
    assert_eq!(r.svc.state(), CopilotState::Out);
    r.script
        .finish_with(json!({ "status": "OK", "user": "ada" }));
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        r.svc.state(),
        CopilotState::Out,
        "a late authorisation changes nothing"
    );
}

#[tokio::test]
async fn check_now_notices_a_sign_in_that_finished_elsewhere() {
    let r = rig(true);
    r.svc.begin().await;
    until(&r.svc, |s| matches!(s, CopilotState::Pending { .. })).await;
    // Still waiting: checking doesn't fall back to signed out.
    r.svc.check_now().await;
    assert!(matches!(r.svc.state(), CopilotState::Pending { .. }));
    *r.script.user.lock().unwrap() = Some("grace".into());
    r.svc.check_now().await;
    assert_eq!(
        r.svc.state(),
        CopilotState::In {
            login: "grace".into()
        }
    );
}

#[tokio::test]
async fn starting_up_picks_up_an_existing_sign_in() {
    let r = rig(true);
    *r.script.user.lock().unwrap() = Some("ada".into());
    r.svc.refresh().await;
    assert_eq!(
        r.svc.state(),
        CopilotState::In {
            login: "ada".into()
        }
    );

    let r = rig(true);
    r.svc.refresh().await;
    assert_eq!(r.svc.state(), CopilotState::Out);
    assert!(r.script.launches.load(Ordering::SeqCst) > 0);

    // Nothing installed: nothing is started.
    let r = rig(false);
    r.svc.refresh().await;
    assert_eq!(r.svc.state(), CopilotState::Out);
    assert_eq!(r.script.launches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn sign_out_asks_the_server_and_stops_it() {
    let r = rig(true);
    *r.script.user.lock().unwrap() = Some("ada".into());
    r.svc.refresh().await;
    r.svc.sign_out().await;
    assert_eq!(r.svc.state(), CopilotState::Out);
    assert!(r.script.methods().contains(&"signOut".to_string()));
    assert!(r.script.user.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_platform_without_a_build_says_so() {
    let r = rig_with("http://127.0.0.1:1", false, None);
    r.svc.begin().await;
    assert!(
        matches!(r.svc.state(), CopilotState::Error { message } if message.contains("isn't available for this platform"))
    );
}

/// (spec: ai-providers › Component download consent)
#[tokio::test]
async fn the_component_is_downloaded_only_after_the_user_agrees() {
    let tgz = package(b"fake server");
    let integrity = integrity_of(&tgz);
    // The registry answers the metadata request, then the HEAD for the size; after the user
    // agrees it answers both again, and then the download itself.
    let bytes = |b: Vec<u8>| Canned::bytes(200, "application/octet-stream", b);
    let server = serve_with(|base| {
        let meta = serde_json::to_string(&json!({
            "dist": { "tarball": format!("{base}/pkg.tgz"), "integrity": integrity }
        }))
        .unwrap();
        vec![
            Canned::json(200, meta.clone()),
            bytes(tgz.clone()),
            Canned::json(200, meta.clone()),
            bytes(tgz.clone()),
            Canned::json(200, meta),
            bytes(tgz.clone()),
            bytes(tgz.clone()),
        ]
    })
    .await;
    let r = rig_with(&server.url, false, Some("test-1"));

    r.svc.begin().await;
    let CopilotState::Consent {
        version,
        download_bytes,
    } = r.svc.state()
    else {
        panic!("{:?}", r.svc.state())
    };
    assert_eq!(version, VERSION);
    assert_eq!(download_bytes, Some(tgz.len() as u64));
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|q| q.method == "GET" && q.path == "/pkg.tgz"),
        "nothing is downloaded before the user agrees"
    );

    // Declining leaves everything as it was.
    r.svc.decline_consent().await;
    assert_eq!(r.svc.state(), CopilotState::Out);
    assert!(crate::ai::copilot::install::installed(r.dir.path(), VERSION).is_none());

    // Agreeing downloads, verifies and continues to the code.
    r.svc.begin().await;
    r.svc.accept_consent().await;
    until(&r.svc, |s| matches!(s, CopilotState::Pending { .. })).await;
    assert!(crate::ai::copilot::install::installed(r.dir.path(), VERSION).is_some());
    assert!(phases(&r).contains(&"downloading".to_string()));
}

#[tokio::test]
async fn a_tampered_download_ends_in_an_error_and_installs_nothing() {
    let real = package(b"real");
    let evil = package(b"evil");
    let integrity = integrity_of(&real);
    let bytes = |b: Vec<u8>| Canned::bytes(200, "application/octet-stream", b);
    let server = serve_with(|base| {
        let meta = serde_json::to_string(&json!({
            "dist": { "tarball": format!("{base}/pkg.tgz"), "integrity": integrity }
        }))
        .unwrap();
        vec![
            Canned::json(200, meta.clone()),
            bytes(evil.clone()),
            Canned::json(200, meta),
            bytes(evil.clone()),
            bytes(evil.clone()),
        ]
    })
    .await;
    let r = rig_with(&server.url, false, Some("test-1"));
    r.svc.begin().await;
    r.svc.accept_consent().await;
    assert!(
        matches!(r.svc.state(), CopilotState::Error { message } if message.contains("checksum"))
    );
    assert!(crate::ai::copilot::install::installed(r.dir.path(), VERSION).is_none());
}

mod completions {
    use super::*;

    async fn signed_in() -> Rig {
        let r = rig(true);
        *r.script.user.lock().unwrap() = Some("ada".into());
        r.svc.refresh().await;
        assert!(matches!(r.svc.state(), CopilotState::In { .. }));
        r
    }

    /// (spec: ai-inline-completion › Accept a suggestion)
    #[tokio::test]
    async fn asks_the_server_at_the_cursor_and_returns_what_to_insert() {
        let r = signed_in().await;
        *r.script.completion.lock().unwrap() = json!({
            "items": [
                { "insertText": "o.status = 'shipped'", "range": { "start": {"line": 1, "character": 6}, "end": {"line": 1, "character": 7} } },
                { "insertText": "o.status = 'open'", "range": { "start": {"line": 1, "character": 6}, "end": {"line": 1, "character": 7} } },
                { "insertText": "elsewhere", "range": { "start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1} } },
            ]
        });
        let out = r
            .svc
            .complete(
                "tab1",
                "SELECT 1\nWHERE o",
                "\nLIMIT 5",
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(out, vec![".status = 'shipped'", ".status = 'open'"]);
        let open = &r.script.calls("textDocument/didOpen")[0];
        assert_eq!(open["textDocument"]["languageId"], "sql");
        assert_eq!(open["textDocument"]["text"], "SELECT 1\nWHERE o\nLIMIT 5");
        let ask = &r.script.calls("textDocument/inlineCompletion")[0];
        assert_eq!(ask["position"], json!({ "line": 1, "character": 7 }));
        assert_eq!(ask["context"]["triggerKind"], 2);
    }

    #[tokio::test]
    async fn later_requests_in_the_same_document_send_a_change() {
        let r = signed_in().await;
        for prefix in ["SELECT", "SELECT *"] {
            r.svc
                .complete("tab1", prefix, "", CancellationToken::new())
                .await
                .unwrap();
        }
        assert_eq!(r.script.calls("textDocument/didOpen").len(), 1);
        let change = &r.script.calls("textDocument/didChange")[0];
        assert_eq!(change["textDocument"]["version"], 2);
        assert_eq!(change["contentChanges"][0]["text"], "SELECT *");
        // Another console is a document of its own.
        r.svc
            .complete("tab2", "x", "", CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(r.script.calls("textDocument/didOpen").len(), 2);
    }

    #[tokio::test]
    async fn needs_a_signed_in_account() {
        let r = rig(true);
        let err = r
            .svc
            .complete("t", "x", "", CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("isn't signed in"));
    }

    #[tokio::test]
    async fn a_cancelled_request_returns_at_once() {
        let r = signed_in().await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            r.svc.complete("t", "x", "", cancel).await.unwrap_err(),
            "cancelled"
        );
    }

    #[tokio::test]
    async fn a_server_that_died_is_started_again_for_the_next_request() {
        let r = signed_in().await;
        // Kill the running server; the next call must launch a new one.
        r.svc.stop_server().await;
        assert_eq!(r.script.launches.load(Ordering::SeqCst), 1);
        r.svc
            .complete("t", "x", "", CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(r.script.launches.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn positions_count_utf16_units_per_line() {
        assert_eq!(utf16_position(""), (0, 0));
        assert_eq!(utf16_position("a\nbé😀"), (1, 4)); // é = 1, 😀 = 2 units
    }

    #[test]
    fn insertions_drop_the_part_the_user_already_typed() {
        let reply = json!({ "items": [
            { "insertText": "SELECT * FROM", "range": { "start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3} } },
            { "insertText": "SELECT * FROM", "range": { "start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3} } },
            { "insertText": "DELETE", "range": { "start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3} } },
            { "insertText": "no range" },
        ]});
        assert_eq!(
            items_to_insertions(&reply, "SEL"),
            vec!["ECT * FROM", "no range"]
        );
        assert!(items_to_insertions(&json!({}), "x").is_empty());
    }
}
