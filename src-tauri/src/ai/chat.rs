//! One assistant request: assemble the context under the data-sharing policy, stream the model's
//! answer, answer its schema lookups from the snapshot, and hand proposed edits to the UI. The
//! model can never execute a statement: there is no tool for it.

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::unbounded_channel;
use tokio_util::sync::CancellationToken;

use super::config::AiSettings;
use super::context::{self, ContextInput, RowsAttachment};
use super::policy::{self, Access, ContextItem, ItemKind};
use super::providers::{ChatEvent, ChatProvider, ChatRequest, Msg, ProviderError, ProviderResult};
use super::tools::{self, LineEdit, Mode, Outcome, Toolbox, MAX_TOOL_CALLS};
use crate::drivers::introspect::SchemaSnapshot;

/// Model turns in one request: every schema lookup may need one, plus an edit and the answer.
const MAX_ROUNDS: usize = MAX_TOOL_CALLS + 3;
const MAX_ANSWER_TOKENS: u32 = 4096;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    Chat,
    /// Fix with AI / Explain error.
    Fix,
    /// Natural language → SQL.
    NlSql,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryMsg {
    pub role: Role,
    pub text: String,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInput {
    /// Lets the panel stop this request.
    pub request_id: String,
    pub feature: Feature,
    /// A provider chosen in the model picker; otherwise the feature's routing decides.
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub mode: Mode,
    pub connection_id: String,
    pub database: String,
    pub text: String,
    /// Tables @-mentioned in the message.
    pub mentions: Vec<String>,
    /// The statement or selection the question is about.
    pub statement: Option<String>,
    pub error: Option<String>,
    pub rows: Option<RowsAttachment>,
    /// The whole console text: what Edit mode may change.
    pub console_text: Option<String>,
    pub server_version: Option<String>,
    pub history: Vec<HistoryMsg>,
}

/// What the panel receives while a request runs.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    /// The exact context sent with this request (spec: ai-providers › What was sent).
    #[serde(rename_all = "camelCase")]
    Context {
        items: Vec<ContextItem>,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
    },
    /// The model read the schema of these tables, for the answer's header.
    #[serde(rename_all = "camelCase")]
    Read {
        tables: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Edit {
        edits: Vec<LineEdit>,
        summary: String,
    },
    #[serde(rename_all = "camelCase")]
    Suggestions {
        items: Vec<String>,
    },
    Done,
}

/// Everything a request needs besides the provider.
pub struct Env<'a> {
    pub settings: &'a AiSettings,
    pub driver: &'a str,
    pub production: bool,
    pub hosts: &'a [String],
    pub users: &'a [String],
    pub snapshot: Option<&'a SchemaSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatError {
    pub code: &'static str,
    pub message: String,
}

impl From<ProviderError> for ChatError {
    fn from(e: ProviderError) -> Self {
        Self {
            code: e.code(),
            message: e.message,
        }
    }
}

fn numbered(text: &str) -> String {
    text.split('\n')
        .enumerate()
        .map(|(i, l)| format!("{:>3}| {l}", i + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

fn system_prompt(env: &Env<'_>, input: &ChatInput, items: &[ContextItem], edit: bool) -> String {
    let dialect = context::dialect_name(env.driver);
    let mut s = format!(
        "You are the assistant inside Clew, a database IDE. The user works with {dialect}.\n\
         Rules:\n\
         - You can never run a statement or read table rows. The user decides what to run.\n\
         - Write {dialect} that is valid for the server version below. Put SQL in fenced code blocks.\n\
         - Use list_tables and describe_table to look up schema instead of guessing names.\n\
         - Be concise. Explain the cause of a problem in a sentence or two.\n\
         - You may call suggest_followups once, at the end, with up to three short next steps.\n"
    );
    if edit {
        s.push_str(
            "- You are in Edit mode: to change the user's console, call edit_console with line-based edits. \
             The user reviews them before keeping them. Explain what you changed in your reply.\n",
        );
    } else {
        s.push_str("- You are in Ask mode: answer in text and show SQL in code blocks. You cannot change the console.\n");
    }
    if input.feature == Feature::Fix {
        s.push_str("- The user asked to fix or explain an error: find the cause first.\n");
    }
    s.push_str("\nContext:\n");
    for item in items {
        s.push_str(&format!("## {}\n{}\n\n", item.label, item.content));
    }
    s
}

/// Run one request to completion. Events go to `emit` as they happen.
pub async fn run(
    provider: &dyn ChatProvider,
    model: &str,
    input: &ChatInput,
    env: &Env<'_>,
    emit: &(dyn Fn(AiEvent) + Send + Sync),
    cancel: CancellationToken,
) -> Result<(), ChatError> {
    let access: Access = policy::access(&env.settings.privacy, env.production);
    if !access.allowed {
        return Err(ChatError {
            code: "ai_disabled_production",
            message: policy::OFF_FOR_PRODUCTION.into(),
        });
    }
    let edit = input.mode == Mode::Edit;
    if edit && !access.sql {
        return Err(ChatError {
            code: "ai_sql_not_shared",
            message: "Sharing the editor SQL is turned off, so the assistant can't edit it.".into(),
        });
    }
    if let Some(rows) = &input.rows {
        if !access.rows && !rows.rows.is_empty() {
            return Err(ChatError {
                code: "ai_rows_refused",
                message: if access.production {
                    policy::ROWS_REFUSED.into()
                } else {
                    "Sharing sample rows is turned off in Settings › AI assistant".into()
                },
            });
        }
    }

    // Candidate context, then the policy.
    let (mut items, mut read) = context::build(&ContextInput {
        driver: env.driver,
        server_version: input.server_version.as_deref(),
        snapshot: env.snapshot,
        mentioned: &input.mentions,
        statement: input.statement.as_deref(),
        error: input.error.as_deref(),
        rows: input.rows.as_ref(),
        hosts: env.hosts,
        users: env.users,
    });
    if edit {
        if let Some(text) = &input.console_text {
            items.push(ContextItem {
                kind: ItemKind::Statement,
                label: "console".into(),
                content: numbered(text),
            });
        }
    }
    let items = policy::filter(items, &access);
    if !access.schema {
        read.clear();
    }
    emit(AiEvent::Context {
        items: items.clone(),
    });

    let mut messages: Vec<Msg> = input
        .history
        .iter()
        .map(|m| match m.role {
            Role::User => Msg::User(m.text.clone()),
            Role::Assistant => Msg::Assistant {
                text: m.text.clone(),
                calls: Vec::new(),
            },
        })
        .collect();
    messages.push(Msg::User(input.text.clone()));

    let mut toolbox = Toolbox {
        mode: input.mode,
        snapshot: env.snapshot,
        schema_allowed: access.schema,
        console_text: input.console_text.as_deref().filter(|_| access.sql),
        used: 0,
    };
    let system = system_prompt(env, input, &items, edit);
    let mut announced: Vec<String> = Vec::new();

    for _ in 0..MAX_ROUNDS {
        let req = ChatRequest {
            model: model.to_string(),
            system: system.clone(),
            messages: messages.clone(),
            tools: tools::defs(input.mode),
            max_tokens: MAX_ANSWER_TOKENS,
            temperature: None,
        };
        let (tx, mut rx) = unbounded_channel();
        let mut text = String::new();
        let mut calls = Vec::new();
        let (res, ()) = tokio::join!(provider.chat(req, tx, cancel.clone()), async {
            while let Some(ev) = rx.recv().await {
                match ev {
                    ChatEvent::Text(t) => {
                        text.push_str(&t);
                        emit(AiEvent::Text { text: t });
                    }
                    ChatEvent::Tool(c) => calls.push(c),
                    ChatEvent::Done => {}
                }
            }
        });
        res?;
        if calls.is_empty() {
            emit(AiEvent::Done);
            return Ok(());
        }
        messages.push(Msg::Assistant {
            text,
            calls: calls.clone(),
        });
        for call in &calls {
            let outcome = toolbox.run(call);
            match &outcome {
                Outcome::Reply {
                    read: Some(table), ..
                } if !announced.contains(table) => {
                    announced.push(table.clone());
                    emit(AiEvent::Read {
                        tables: announced.clone(),
                    });
                }
                Outcome::Edit { edits, summary, .. } => emit(AiEvent::Edit {
                    edits: edits.clone(),
                    summary: summary.clone(),
                }),
                Outcome::Suggestions { items, .. } if !items.is_empty() => {
                    emit(AiEvent::Suggestions {
                        items: items.clone(),
                    })
                }
                _ => {}
            }
            messages.push(Msg::ToolResult {
                call_id: call.id.clone(),
                content: outcome.content().to_string(),
            });
        }
    }
    Err(ChatError {
        code: "ai_error",
        message: "The assistant kept calling tools without answering. Try again.".into(),
    })
}

/// One-shot text completion for the editor's ghost text: the model returns only what to insert
/// at the cursor.
pub async fn complete(
    provider: &dyn ChatProvider,
    model: &str,
    driver: &str,
    prefix: &str,
    suffix: &str,
    schema: &[ContextItem],
    cancel: CancellationToken,
) -> ProviderResult<Vec<String>> {
    let dialect = context::dialect_name(driver);
    let mut system = format!(
        "You complete {dialect} code in a database IDE. The user's text is split at the cursor into \
         <before> and <after>. Reply with only the text to insert at the cursor: no explanation, no \
         code fences, no repetition of text that is already there. Keep it short: finish the statement \
         or the line. If nothing sensible follows, reply with nothing.\n"
    );
    for item in schema {
        system.push_str(&format!("\n{}: {}", item.label, item.content));
    }
    let req = ChatRequest {
        model: model.to_string(),
        system,
        messages: vec![Msg::User(format!(
            "<before>{prefix}</before>\n<after>{suffix}</after>"
        ))],
        tools: Vec::new(),
        max_tokens: 160,
        temperature: Some(0.0),
    };
    let (tx, mut rx) = unbounded_channel();
    let mut text = String::new();
    let (res, ()) = tokio::join!(provider.chat(req, tx, cancel), async {
        while let Some(ev) = rx.recv().await {
            if let ChatEvent::Text(t) = ev {
                text.push_str(&t);
            }
        }
    });
    res?;
    let cleaned = strip_fences(&text);
    Ok(if cleaned.trim().is_empty() {
        Vec::new()
    } else {
        vec![cleaned]
    })
}

/// Models sometimes wrap a completion in a code fence anyway.
pub fn strip_fences(text: &str) -> String {
    let t = text.trim_end_matches('\n');
    let Some(rest) = t.strip_prefix("```") else {
        return t.to_string();
    };
    let body = rest.split_once('\n').map(|(_, b)| b).unwrap_or("");
    body.strip_suffix("```")
        .unwrap_or(body)
        .trim_end_matches('\n')
        .to_string()
}

#[cfg(test)]
mod tests;
