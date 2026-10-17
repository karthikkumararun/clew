use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::mpsc::UnboundedSender;

use super::*;
use crate::ai::config::{Privacy, ProductionPolicy};
use crate::ai::providers::{ModelInfo, ToolCall};
use crate::drivers::introspect::{NodeKind, SnapshotColumn, SnapshotSchema, SnapshotTable};

/// Plays back scripted turns and records every request it receives.
struct Fake {
    turns: Mutex<Vec<Vec<ChatEvent>>>,
    seen: Mutex<Vec<ChatRequest>>,
    fail: Option<ProviderError>,
}

impl Fake {
    fn new(turns: Vec<Vec<ChatEvent>>) -> Self {
        Self {
            turns: Mutex::new(turns),
            seen: Mutex::new(Vec::new()),
            fail: None,
        }
    }
}

#[async_trait]
impl ChatProvider for Fake {
    async fn models(&self) -> ProviderResult<Vec<ModelInfo>> {
        Ok(vec![])
    }

    async fn chat(
        &self,
        req: ChatRequest,
        tx: UnboundedSender<ChatEvent>,
        _cancel: CancellationToken,
    ) -> ProviderResult<()> {
        self.seen.lock().unwrap().push(req);
        if let Some(e) = &self.fail {
            return Err(e.clone());
        }
        let turn = {
            let mut t = self.turns.lock().unwrap();
            if t.is_empty() {
                vec![ChatEvent::Done]
            } else {
                t.remove(0)
            }
        };
        for ev in turn {
            let _ = tx.send(ev);
        }
        Ok(())
    }
}

fn text(t: &str) -> ChatEvent {
    ChatEvent::Text(t.into())
}

fn tool(id: &str, name: &str, args: serde_json::Value) -> ChatEvent {
    ChatEvent::Tool(ToolCall {
        id: id.into(),
        name: name.into(),
        args,
    })
}

fn snapshot() -> SchemaSnapshot {
    let table = |n: &str, cols: &[(&str, &str)]| SnapshotTable {
        name: n.into(),
        kind: NodeKind::Table,
        columns: cols
            .iter()
            .map(|(c, t)| SnapshotColumn {
                name: (*c).into(),
                type_name: (*t).into(),
            })
            .collect(),
    };
    SchemaSnapshot {
        schemas: vec![SnapshotSchema {
            name: "public".into(),
            tables: vec![
                table("orders", &[("id", "integer"), ("user_id", "integer")]),
                table("shipments", &[("order_id", "integer"), ("carrier", "text")]),
            ],
            functions: vec![],
        }],
        graph: None,
    }
}

fn input() -> ChatInput {
    ChatInput {
        request_id: "r1".into(),
        feature: Feature::Chat,
        provider_id: None,
        model: None,
        mode: Mode::Ask,
        connection_id: "c1".into(),
        database: "analytics".into(),
        text: "why is this slow?".into(),
        mentions: vec![],
        statement: Some("SELECT o.carrier FROM orders o".into()),
        error: None,
        rows: None,
        console_text: Some("SELECT o.carrier\nFROM orders o".into()),
        server_version: Some("16.2".into()),
        history: vec![],
    }
}

struct Ctx {
    settings: AiSettings,
    snapshot: SchemaSnapshot,
    hosts: Vec<String>,
    users: Vec<String>,
}

impl Ctx {
    fn new() -> Self {
        Self {
            settings: AiSettings::default(),
            snapshot: snapshot(),
            hosts: vec![],
            users: vec![],
        }
    }

    fn env(&self, production: bool) -> Env<'_> {
        Env {
            settings: &self.settings,
            driver: "postgres",
            production,
            hosts: &self.hosts,
            users: &self.users,
            snapshot: Some(&self.snapshot),
        }
    }
}

async fn go(
    fake: &Fake,
    input: &ChatInput,
    ctx: &Ctx,
    production: bool,
) -> (Result<(), ChatError>, Vec<AiEvent>) {
    let events = Mutex::new(Vec::new());
    let emit = |e: AiEvent| events.lock().unwrap().push(e);
    let r = run(
        fake,
        "m",
        input,
        &ctx.env(production),
        &emit,
        CancellationToken::new(),
    )
    .await;
    (r, events.into_inner().unwrap())
}

fn context_labels(events: &[AiEvent]) -> Vec<String> {
    events
        .iter()
        .find_map(|e| match e {
            AiEvent::Context { items } => Some(items.iter().map(|i| i.label.clone()).collect()),
            _ => None,
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn streams_text_and_finishes() {
    let fake = Fake::new(vec![vec![
        text("It scans "),
        text("everything."),
        ChatEvent::Done,
    ]]);
    let (r, events) = go(&fake, &input(), &Ctx::new(), false).await;
    r.unwrap();
    let texts: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AiEvent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["It scans ", "everything."]);
    assert_eq!(events.last(), Some(&AiEvent::Done));
}

/// (spec: ai-providers › What was sent)
#[tokio::test]
async fn the_context_sent_is_reported_and_sits_in_the_system_prompt() {
    let fake = Fake::new(vec![vec![text("ok")]]);
    let (_, events) = go(&fake, &input(), &Ctx::new(), false).await;
    assert_eq!(
        context_labels(&events),
        vec!["dialect", "schema of orders", "statement"]
    );
    let system = fake.seen.lock().unwrap()[0].system.clone();
    assert!(system.contains("PostgreSQL, server version 16.2"));
    assert!(system.contains("orders (table): id integer, user_id integer"));
    assert!(system.contains("SELECT o.carrier FROM orders o"));
    assert!(system.contains("never run a statement"));
}

/// (spec: ai-assistant › Model asks for another table)
#[tokio::test]
async fn a_schema_lookup_is_answered_from_the_snapshot_and_named_in_the_header() {
    let fake = Fake::new(vec![
        vec![tool("t1", "describe_table", json!({"name": "shipments"}))],
        vec![text("carrier is on shipments")],
    ]);
    let (r, events) = go(&fake, &input(), &Ctx::new(), false).await;
    r.unwrap();
    assert!(events.contains(&AiEvent::Read {
        tables: vec!["shipments".into()]
    }));
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    let Msg::ToolResult { content, call_id } = seen[1].messages.last().unwrap() else {
        panic!()
    };
    assert_eq!(call_id, "t1");
    assert_eq!(content, "shipments (table): order_id integer, carrier text");
}

/// (spec: ai-assistant › No row access)
#[tokio::test]
async fn a_tool_that_could_run_sql_is_refused_and_nothing_runs() {
    let fake = Fake::new(vec![
        vec![tool("t1", "run_sql", json!({"sql": "DELETE FROM orders"}))],
        vec![text("I can't run that")],
    ]);
    let (r, events) = go(&fake, &input(), &Ctx::new(), false).await;
    r.unwrap();
    let seen = fake.seen.lock().unwrap();
    let Msg::ToolResult { content, .. } = seen[1].messages.last().unwrap() else {
        panic!()
    };
    assert!(content.contains("nothing can run a statement"));
    assert!(!events.iter().any(|e| matches!(e, AiEvent::Edit { .. })));
    // No tool the model is offered can execute a statement.
    for def in &seen[0].tools {
        assert!(!["run_sql", "execute", "query"].contains(&def.name));
    }
}

#[tokio::test]
async fn edit_mode_turns_a_valid_edit_into_an_event_and_ask_mode_cannot() {
    let edit_call = tool(
        "e1",
        "edit_console",
        json!({"summary": "join shipments", "edits": [{"start_line": 1, "end_line": 1, "replacement": "SELECT s.carrier"}]}),
    );
    let mut edit = input();
    edit.mode = Mode::Edit;
    let fake = Fake::new(vec![vec![edit_call.clone()], vec![text("done")]]);
    let (r, events) = go(&fake, &edit, &Ctx::new(), false).await;
    r.unwrap();
    assert!(events.contains(&AiEvent::Edit {
        edits: vec![LineEdit {
            start_line: 1,
            end_line: 1,
            replacement: "SELECT s.carrier".into()
        }],
        summary: "join shipments".into(),
    }));
    {
        let seen = fake.seen.lock().unwrap();
        assert!(seen[0].tools.iter().any(|t| t.name == "edit_console"));
        assert!(
            seen[0].system.contains("  1| SELECT o.carrier"),
            "numbered console text"
        );
    }

    let ask = Fake::new(vec![vec![edit_call], vec![text("ok")]]);
    let (_, events) = go(&ask, &input(), &Ctx::new(), false).await;
    assert!(!events.iter().any(|e| matches!(e, AiEvent::Edit { .. })));
    assert!(ask.seen.lock().unwrap()[0]
        .tools
        .iter()
        .all(|t| t.name != "edit_console"));
}

/// (spec: ai-providers › Production schema-only)
#[tokio::test]
async fn attached_rows_are_refused_on_production_with_the_exact_message() {
    let mut i = input();
    i.rows = Some(RowsAttachment {
        columns: vec!["id".into()],
        rows: vec![vec!["1".into()]],
    });
    let mut ctx = Ctx::new();
    ctx.settings.privacy.rows = true; // even when sharing rows is on elsewhere
    let fake = Fake::new(vec![]);
    let (r, _) = go(&fake, &i, &ctx, true).await;
    let e = r.unwrap_err();
    assert_eq!(
        e.message,
        "Row data isn't shared for Production connections"
    );
    assert!(fake.seen.lock().unwrap().is_empty(), "nothing was sent");
}

#[tokio::test]
async fn rows_are_sent_on_other_connections_only_when_enabled() {
    let mut i = input();
    i.rows = Some(RowsAttachment {
        columns: vec!["id".into()],
        rows: vec![vec!["1".into()]],
    });
    let off = Fake::new(vec![vec![text("x")]]);
    assert_eq!(
        go(&off, &i, &Ctx::new(), false).await.0.unwrap_err().code,
        "ai_rows_refused"
    );
    let mut ctx = Ctx::new();
    ctx.settings.privacy.rows = true;
    let on = Fake::new(vec![vec![text("x")]]);
    let (r, events) = go(&on, &i, &ctx, false).await;
    r.unwrap();
    assert!(context_labels(&events).contains(&"1 sample rows".to_string()));
}

/// (spec: ai-providers › AI disabled on production)
#[tokio::test]
async fn ai_can_be_switched_off_for_production_entirely() {
    let mut ctx = Ctx::new();
    ctx.settings.privacy.production = ProductionPolicy::Disabled;
    let fake = Fake::new(vec![vec![text("x")]]);
    let (r, _) = go(&fake, &input(), &ctx, true).await;
    assert_eq!(
        r.unwrap_err().message,
        "AI is off for Production connections"
    );
    assert!(fake.seen.lock().unwrap().is_empty());
    // Other connections still work.
    assert!(go(&Fake::new(vec![vec![text("x")]]), &input(), &ctx, false)
        .await
        .0
        .is_ok());
}

#[tokio::test]
async fn the_privacy_toggles_remove_context_from_what_is_sent() {
    let mut ctx = Ctx::new();
    ctx.settings.privacy = Privacy {
        schema: false,
        sql: false,
        ..Privacy::default()
    };
    let fake = Fake::new(vec![vec![text("x")]]);
    let (_, events) = go(&fake, &input(), &ctx, false).await;
    assert_eq!(context_labels(&events), vec!["dialect"]);
    let system = fake.seen.lock().unwrap()[0].system.clone();
    assert!(!system.contains("orders") && !system.contains("SELECT o.carrier"));
}

#[tokio::test]
async fn edit_mode_needs_the_editor_sql_to_be_shared() {
    let mut ctx = Ctx::new();
    ctx.settings.privacy.sql = false;
    let mut i = input();
    i.mode = Mode::Edit;
    let fake = Fake::new(vec![]);
    assert_eq!(
        go(&fake, &i, &ctx, false).await.0.unwrap_err().code,
        "ai_sql_not_shared"
    );
}

#[tokio::test]
async fn error_text_has_hosts_and_users_redacted_before_it_is_sent() {
    let mut ctx = Ctx::new();
    ctx.hosts = vec!["db.internal.example.com".into()];
    ctx.users = vec!["app_reader".into()];
    let mut i = input();
    i.error = Some(
        "FATAL: password authentication failed for user \"app_reader\" at db.internal.example.com"
            .into(),
    );
    let fake = Fake::new(vec![vec![text("x")]]);
    go(&fake, &i, &ctx, false).await.0.unwrap();
    let system = fake.seen.lock().unwrap()[0].system.clone();
    assert!(system.contains("<user>") && system.contains("<host>"));
    assert!(!system.contains("app_reader") && !system.contains("internal.example"));
}

#[tokio::test]
async fn history_is_replayed_and_suggestions_are_reported() {
    let mut i = input();
    i.history = vec![
        HistoryMsg {
            role: Role::User,
            text: "first".into(),
        },
        HistoryMsg {
            role: Role::Assistant,
            text: "answer".into(),
        },
    ];
    let fake = Fake::new(vec![
        vec![
            text("done"),
            tool(
                "s",
                "suggest_followups",
                json!({"items": ["Draft the index"]}),
            ),
        ],
        vec![ChatEvent::Done],
    ]);
    let (_, events) = go(&fake, &i, &Ctx::new(), false).await;
    assert!(events.contains(&AiEvent::Suggestions {
        items: vec!["Draft the index".into()]
    }));
    let first = &fake.seen.lock().unwrap()[0];
    assert_eq!(first.messages.len(), 3);
    assert_eq!(first.messages[2], Msg::User("why is this slow?".into()));
}

/// (spec: ai-assistant › Provider error)
#[tokio::test]
async fn a_provider_error_becomes_a_chat_error_with_a_code() {
    let mut fake = Fake::new(vec![]);
    fake.fail = Some(ProviderError::new(
        crate::ai::providers::ErrorKind::RateLimited,
        "The provider is rate limiting requests (429)",
    ));
    let (r, events) = go(&fake, &input(), &Ctx::new(), false).await;
    assert_eq!(r.unwrap_err().code, "ai_rate_limited");
    assert!(!events.contains(&AiEvent::Done));
}

#[tokio::test]
async fn a_model_that_never_stops_calling_tools_is_cut_off() {
    let turns = (0..30)
        .map(|n| vec![tool(&format!("t{n}"), "list_tables", json!({}))])
        .collect();
    let fake = Fake::new(turns);
    let (r, _) = go(&fake, &input(), &Ctx::new(), false).await;
    assert!(r.is_err());
    assert!(fake.seen.lock().unwrap().len() <= MAX_ROUNDS);
}

#[test]
fn code_fences_are_stripped_from_completions() {
    assert_eq!(strip_fences("```sql\nAND x = 1\n```"), "AND x = 1");
    assert_eq!(strip_fences("AND x = 1\n"), "AND x = 1");
    assert_eq!(strip_fences("```\nfoo"), "foo");
}

#[tokio::test]
async fn completion_returns_one_trimmed_suggestion_or_none() {
    let fake = Fake::new(vec![vec![text("```sql\nAND o.status = 'shipped'\n```")]]);
    let out = complete(
        &fake,
        "m",
        "postgres",
        "WHERE ",
        "",
        &[],
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(out, vec!["AND o.status = 'shipped'"]);
    let none = Fake::new(vec![vec![text("  ")]]);
    assert!(complete(
        &none,
        "m",
        "postgres",
        "",
        "",
        &[],
        CancellationToken::new()
    )
    .await
    .unwrap()
    .is_empty());
    let sent = &fake.seen.lock().unwrap()[0];
    assert!(sent.tools.is_empty());
    assert!(matches!(&sent.messages[0], Msg::User(m) if m.contains("<before>WHERE </before>")));
}
