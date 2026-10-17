use std::sync::Arc;

use super::config::*;
use super::providers::{ChatEvent, ChatProvider, ChatRequest, ErrorKind, Msg};
use super::test_server::{serve, Canned};
use super::*;
use crate::connections::secrets::MemoryStore;
use tokio::sync::mpsc::unbounded_channel;

fn service() -> (AiService, Arc<MemoryStore>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    let (svc, backup) = AiService::new(dir.path().to_path_buf(), store.clone());
    assert!(backup.is_none());
    (svc, store, dir)
}

fn anthropic(base: &str) -> ProviderConfig {
    ProviderConfig {
        id: ANTHROPIC_ID.into(),
        kind: ProviderKind::Anthropic,
        name: "Anthropic Claude".into(),
        base_url: base.into(),
        model: CLAUDE_DEFAULT_MODEL.into(),
        ..Default::default()
    }
}

fn openai(base: &str) -> ProviderConfig {
    ProviderConfig {
        id: OPENAI_ID.into(),
        kind: ProviderKind::Openai,
        name: "OpenAI".into(),
        base_url: base.into(),
        model: "gpt-test".into(),
        ..Default::default()
    }
}

fn req() -> ChatRequest {
    ChatRequest {
        model: "m".into(),
        system: "s".into(),
        messages: vec![Msg::User("hi".into())],
        tools: vec![],
        max_tokens: 16,
        temperature: None,
    }
}

async fn run(p: &dyn ChatProvider) -> (Vec<ChatEvent>, Result<(), providers::ProviderError>) {
    let (tx, mut rx) = unbounded_channel();
    let r = p.chat(req(), tx, CancellationToken::new()).await;
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    (out, r)
}

const ANTHROPIC_SSE: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

const OPENAI_SSE: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n",
);

#[tokio::test]
async fn anthropic_streams_over_http_with_the_key_in_x_api_key() {
    let server = serve(vec![Canned::sse(ANTHROPIC_SSE)]).await;
    let (svc, _, _d) = service();
    let p = svc
        .provider(&anthropic(&server.url), Some(&Secret::new("sk-ant-secret")))
        .unwrap();
    let (events, r) = run(p.as_ref()).await;
    r.unwrap();
    assert_eq!(
        events,
        vec![ChatEvent::Text("Hello".into()), ChatEvent::Done]
    );
    let seen = server.requests.lock().unwrap();
    assert_eq!(seen[0].method, "POST");
    assert_eq!(seen[0].path, "/v1/messages");
    assert_eq!(seen[0].headers["x-api-key"], "sk-ant-secret");
    assert_eq!(seen[0].headers["anthropic-version"], "2023-06-01");
    assert!(
        !seen[0].body.contains("sk-ant-secret"),
        "the key is a header, not in the body"
    );
}

#[tokio::test]
async fn openai_streams_over_http_with_a_bearer_token_and_custom_headers() {
    let server = serve(vec![Canned::sse(OPENAI_SSE)]).await;
    let (svc, _, _d) = service();
    let mut cfg = openai(&format!("{}/v1", server.url));
    cfg.extra_headers = vec![("x-team".into(), "data".into())];
    let p = svc.provider(&cfg, Some(&Secret::new("sk-secret"))).unwrap();
    let (events, r) = run(p.as_ref()).await;
    r.unwrap();
    assert_eq!(
        events,
        vec![ChatEvent::Text("Hello".into()), ChatEvent::Done]
    );
    let seen = server.requests.lock().unwrap();
    assert_eq!(seen[0].path, "/v1/chat/completions");
    assert_eq!(seen[0].headers["authorization"], "Bearer sk-secret");
    assert_eq!(seen[0].headers["x-team"], "data");
}

#[tokio::test]
async fn a_custom_header_carries_the_token_when_asked() {
    let server = serve(vec![Canned::sse(OPENAI_SSE)]).await;
    let (svc, _, _d) = service();
    let cfg = ProviderConfig {
        auth: AuthStyle::Header,
        auth_header: "api-key".into(),
        kind: ProviderKind::CustomOpenai,
        ..openai(&server.url)
    };
    let p = svc.provider(&cfg, Some(&Secret::new("tok"))).unwrap();
    run(p.as_ref()).await.1.unwrap();
    let seen = server.requests.lock().unwrap();
    assert_eq!(seen[0].headers["api-key"], "tok");
    assert!(!seen[0].headers.contains_key("authorization"));
}

/// (spec: ai-providers › Invalid key)
#[tokio::test]
async fn a_rejected_key_says_so_and_never_echoes_it() {
    let server = serve(vec![Canned::json(
        401,
        r#"{"error":{"message":"bad key sk-ant-secret"}}"#,
    )])
    .await;
    let (svc, _, _d) = service();
    let err = svc
        .test(&anthropic(&server.url), Some(&Secret::new("sk-ant-secret")))
        .await
        .unwrap_err();
    assert_eq!(err.code, "ai_auth");
    assert_eq!(err.message, "The API key was rejected (401)");
    assert!(!format!("{err:?}").contains("sk-ant-secret"));
}

#[tokio::test]
async fn rate_limits_and_server_errors_are_distinct() {
    let server = serve(vec![
        Canned::json(429, r#"{"error":{"message":"slow down"}}"#),
        Canned::json(503, "{}"),
    ])
    .await;
    let (svc, _, _d) = service();
    let p = svc
        .provider(&openai(&server.url), Some(&Secret::new("k")))
        .unwrap();
    let (_, r1) = run(p.as_ref()).await;
    let (_, r2) = run(p.as_ref()).await;
    assert_eq!(r1.unwrap_err().kind, ErrorKind::RateLimited);
    assert_eq!(r2.unwrap_err().kind, ErrorKind::Server);
}

/// (spec: ai-providers › Company gateway)
#[tokio::test]
async fn test_connection_reports_the_round_trip() {
    let server = serve(vec![Canned::sse(OPENAI_SSE)]).await;
    let (svc, _, _d) = service();
    let r = svc
        .test(&openai(&server.url), Some(&Secret::new("k")))
        .await
        .unwrap();
    assert!(r.ok);
    assert!(
        r.message.starts_with("Reachable · model responded in "),
        "{}",
        r.message
    );
    assert!(r.message.ends_with(" ms"));
}

#[tokio::test]
async fn the_model_list_comes_from_the_models_endpoint() {
    let server = serve(vec![Canned::json(
        200,
        r#"{"data":[{"id":"claude-sonnet-5-5","display_name":"Claude Sonnet 5.5"},{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5"}]}"#,
    )])
    .await;
    let (svc, _, _d) = service();
    let models = svc
        .models(&anthropic(&server.url), Some(&Secret::new("k")))
        .await
        .unwrap();
    assert_eq!(
        models[0],
        ModelInfo {
            id: "claude-sonnet-5-5".into(),
            name: "Claude Sonnet 5.5".into()
        }
    );
    assert_eq!(models.len(), 2);
    assert_eq!(
        server.requests.lock().unwrap()[0].path,
        "/v1/models?limit=100"
    );
}

/// (spec: ai-providers › Server not running)
#[tokio::test]
async fn a_local_server_that_is_not_running_names_ollama() {
    // Bind and drop a listener to get a port nothing listens on.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (svc, _, _d) = service();
    let cfg = ProviderConfig {
        id: LOCAL_ID.into(),
        kind: ProviderKind::Local,
        base_url: format!("http://127.0.0.1:{port}"),
        model: "llama".into(),
        auth: AuthStyle::None,
        ..Default::default()
    };
    let err = svc.test(&cfg, None).await.unwrap_err();
    assert_eq!(err.code, "ai_unreachable");
    assert_eq!(
        err.message,
        format!("Nothing is listening on 127.0.0.1:{port} — is Ollama running?")
    );
}

/// (spec: ai-providers › Fresh install)
#[test]
fn nothing_is_allowed_until_ai_is_switched_on() {
    let (svc, _, _d) = service();
    assert_eq!(svc.ensure_enabled().unwrap_err().code, "ai_disabled");
    let mut s = svc.settings();
    s.enabled = true;
    svc.set_settings(s).unwrap();
    svc.ensure_enabled().unwrap();
}

#[test]
fn keys_live_only_in_the_keychain() {
    let (svc, store, dir) = service();
    svc.set_secret(ANTHROPIC_ID, &Secret::new("sk-ant-secret"))
        .unwrap();
    assert!(svc.has_secret(ANTHROPIC_ID));
    assert_eq!(store.len(), 1);
    let mut s = svc.settings();
    s.providers.push(anthropic(ANTHROPIC_BASE));
    svc.set_settings(s).unwrap();
    // No file in the data directory holds the key.
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default();
        assert!(!text.contains("sk-ant-secret"));
    }
    // Removing the provider removes its key.
    let mut s = svc.settings();
    s.providers.clear();
    svc.set_settings(s).unwrap();
    assert!(!svc.has_secret(ANTHROPIC_ID));
}

#[test]
fn a_locked_keychain_is_a_clear_error() {
    let (svc, store, _d) = service();
    store.lock(true);
    let err = svc.set_secret(OPENAI_ID, &Secret::new("k")).unwrap_err();
    assert_eq!(err.code, "keychain_unavailable");
    assert!(!format!("{err:?}").contains('k') || err.message.contains("keychain"));
}

#[test]
fn routing_picks_the_configured_provider_and_falls_back_to_chat() {
    let (svc, _, _d) = service();
    let mut s = svc.settings();
    s.enabled = true;
    s.providers = vec![anthropic(ANTHROPIC_BASE), openai(OPENAI_BASE)];
    s.routing.chat = Some(OPENAI_ID.into());
    svc.set_settings(s).unwrap();
    assert_eq!(
        svc.resolve(Route::Chat, None).unwrap_err().code,
        "ai_no_provider",
        "no key yet"
    );
    svc.set_secret(OPENAI_ID, &Secret::new("k")).unwrap();
    assert_eq!(svc.resolve(Route::Chat, None).unwrap().id, OPENAI_ID);
    assert_eq!(
        svc.resolve(Route::Fix, None).unwrap().id,
        OPENAI_ID,
        "same as chat"
    );
    assert_eq!(svc.resolve(Route::NlSql, None).unwrap().id, OPENAI_ID);
    assert_eq!(
        svc.resolve(Route::Inline, None).unwrap_err().code,
        "ai_no_provider",
        "off"
    );
    svc.set_secret(ANTHROPIC_ID, &Secret::new("k2")).unwrap();
    assert_eq!(
        svc.resolve(Route::Chat, Some(ANTHROPIC_ID)).unwrap().id,
        ANTHROPIC_ID
    );
}

#[test]
fn cancelling_a_request_fires_its_token() {
    let (svc, _, _d) = service();
    let token = svc.start("r1");
    assert!(!token.is_cancelled());
    assert!(svc.cancel("r1"));
    assert!(token.is_cancelled());
    svc.finish("r1");
    assert!(!svc.cancel("r1"));
}

#[test]
fn the_default_model_for_claude_is_sonnet_5_5() {
    let mut cfg = anthropic(ANTHROPIC_BASE);
    cfg.model.clear();
    assert_eq!(model_for(&cfg, None), "claude-sonnet-5-5");
    assert_eq!(model_for(&cfg, Some("claude-opus-5-5")), "claude-opus-5-5");
}
