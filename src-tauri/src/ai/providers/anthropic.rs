//! The Anthropic Messages API (and compatible endpoints): streaming with tool use.

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use super::{
    authorize, http_client, send_error, status_error, ChatEvent, ChatProvider, ChatRequest,
    Credentials, ErrorKind, ModelInfo, Msg, ProviderError, ProviderResult, ToolCall, IDLE_TIMEOUT,
};
use crate::ai::config::{AuthStyle, ProviderConfig, ProviderKind};
use crate::ai::sse::SseParser;

const VERSION: &str = "2023-06-01";

pub struct Anthropic {
    base: String,
    creds: Credentials,
    extra: Vec<(String, String)>,
    client: reqwest::Client,
}

impl Anthropic {
    pub fn new(cfg: &ProviderConfig, mut creds: Credentials) -> Self {
        if cfg.kind == ProviderKind::Anthropic {
            // The first-party API takes the key in `x-api-key`.
            creds.style = AuthStyle::Header;
            creds.header = "x-api-key".to_string();
        }
        Self {
            base: cfg.base_url.trim_end_matches('/').to_string(),
            creds,
            extra: cfg.extra_headers.clone(),
            client: http_client(),
        }
    }

    /// `<base>/v1/<path>`, without doubling a `/v1` the base already ends with.
    fn url(&self, path: &str) -> String {
        if self.base.ends_with("/v1") {
            format!("{}/{path}", self.base)
        } else {
            format!("{}/v1/{path}", self.base)
        }
    }

    fn request(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        authorize(
            rb.header("anthropic-version", VERSION),
            &self.creds,
            &self.extra,
        )
    }
}

pub fn body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for m in &req.messages {
        match m {
            Msg::User(t) => messages.push(json!({ "role": "user", "content": t })),
            Msg::Assistant { text, calls } => {
                let mut content: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for c in calls {
                    content.push(
                        json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.args }),
                    );
                }
                messages.push(json!({ "role": "assistant", "content": content }));
            }
            Msg::ToolResult { call_id, content } => {
                let block =
                    json!({ "type": "tool_result", "tool_use_id": call_id, "content": content });
                // Results of one turn's calls share a user message.
                match messages.last_mut() {
                    Some(last) if last["role"] == "user" && last["content"].is_array() => {
                        last["content"].as_array_mut().unwrap().push(block);
                    }
                    _ => messages.push(json!({ "role": "user", "content": [block] })),
                }
            }
        }
    }
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "messages": messages,
    });
    if !req.system.is_empty() {
        body["system"] = json!(req.system);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({ "name": t.name, "description": t.description, "input_schema": t.schema })
                })
                .collect(),
        );
    }
    body
}

/// Turns the streamed events of one reply into [`ChatEvent`]s.
#[derive(Default)]
pub struct Reader {
    /// Open content blocks by index: tool id, name and the JSON text read so far.
    tools: BTreeMap<u64, (String, String, String)>,
}

impl Reader {
    /// Handle one SSE event. `Ok(true)` when the reply is complete.
    pub fn handle(
        &mut self,
        event: &str,
        data: &str,
        tx: &UnboundedSender<ChatEvent>,
    ) -> ProviderResult<bool> {
        let v: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::new(ErrorKind::Protocol, "Unreadable stream event"))?;
        let kind = v["type"].as_str().unwrap_or(event);
        match kind {
            "content_block_start" => {
                let index = v["index"].as_u64().unwrap_or(0);
                let block = &v["content_block"];
                if block["type"] == "tool_use" {
                    self.tools.insert(
                        index,
                        (
                            block["id"].as_str().unwrap_or_default().to_string(),
                            block["name"].as_str().unwrap_or_default().to_string(),
                            String::new(),
                        ),
                    );
                }
            }
            "content_block_delta" => {
                let index = v["index"].as_u64().unwrap_or(0);
                let delta = &v["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(t) = delta["text"].as_str().filter(|t| !t.is_empty()) {
                            let _ = tx.send(ChatEvent::Text(t.to_string()));
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(t) = self.tools.get_mut(&index) {
                            t.2.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = v["index"].as_u64().unwrap_or(0);
                if let Some((id, name, json)) = self.tools.remove(&index) {
                    let args = if json.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&json).map_err(|_| {
                            ProviderError::new(
                                ErrorKind::Protocol,
                                format!("The model sent unreadable arguments for {name}"),
                            )
                        })?
                    };
                    let _ = tx.send(ChatEvent::Tool(ToolCall { id, name, args }));
                }
            }
            "message_stop" => return Ok(true),
            "error" => {
                let msg = v["error"]["message"]
                    .as_str()
                    .unwrap_or("The provider reported an error");
                let kind = match v["error"]["type"].as_str() {
                    Some("overloaded_error") | Some("api_error") => ErrorKind::Server,
                    Some("rate_limit_error") => ErrorKind::RateLimited,
                    Some("authentication_error") | Some("permission_error") => ErrorKind::Auth,
                    _ => ErrorKind::Other,
                };
                return Err(ProviderError::new(kind, msg));
            }
            _ => {}
        }
        Ok(false)
    }
}

#[async_trait]
impl ChatProvider for Anthropic {
    async fn models(&self) -> ProviderResult<Vec<ModelInfo>> {
        let resp = self
            .request(
                self.client
                    .get(self.url("models"))
                    .query(&[("limit", "100")]),
            )
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| send_error(&e, &self.base))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(status_error(status, &text));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|_| ProviderError::new(ErrorKind::Protocol, "Unreadable model list"))?;
        Ok(v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| {
                        let id = m["id"].as_str()?.to_string();
                        let name = m["display_name"].as_str().unwrap_or(&id).to_string();
                        Some(ModelInfo { id, name })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn chat(
        &self,
        req: ChatRequest,
        tx: UnboundedSender<ChatEvent>,
        cancel: CancellationToken,
    ) -> ProviderResult<()> {
        let send = self
            .request(self.client.post(self.url("messages")))
            .json(&body(&req))
            .send();
        let resp = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ProviderError::new(ErrorKind::Cancelled, "Stopped")),
            r = send => r.map_err(|e| send_error(&e, &self.base))?,
        };
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(status_error(status, &text));
        }
        let mut stream = resp.bytes_stream();
        let mut sse = SseParser::default();
        let mut reader = Reader::default();
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::new(ErrorKind::Cancelled, "Stopped")),
                n = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => n,
            };
            let chunk = match next {
                Err(_) => {
                    return Err(ProviderError::new(
                        ErrorKind::Unreachable,
                        "The provider stopped answering",
                    ))
                }
                Ok(None) => break,
                Ok(Some(Err(_))) => {
                    return Err(ProviderError::new(
                        ErrorKind::Unreachable,
                        "The connection to the provider dropped",
                    ))
                }
                Ok(Some(Ok(c))) => c,
            };
            for ev in sse.push(&chunk) {
                if reader.handle(ev.event.as_deref().unwrap_or(""), &ev.data, &tx)? {
                    let _ = tx.send(ChatEvent::Done);
                    return Ok(());
                }
            }
        }
        let _ = tx.send(ChatEvent::Done);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::providers::ToolDef;

    fn run(events: &[(&str, &str)]) -> (Vec<ChatEvent>, ProviderResult<bool>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut r = Reader::default();
        let mut last = Ok(false);
        for (e, d) in events {
            last = r.handle(e, d, &tx);
            if last.is_err() || last == Ok(true) {
                break;
            }
        }
        drop(tx);
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            out.push(ev);
        }
        (out, last)
    }

    #[test]
    fn streams_text_and_a_tool_call() {
        let (events, last) = run(&[
            ("message_start", r#"{"type":"message_start","message":{}}"#),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"look."}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":0}"#,
            ),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"describe_table","input":{}}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"name\":"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"orders\"}"}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":1}"#,
            ),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        assert_eq!(last, Ok(true));
        assert_eq!(
            events,
            vec![
                ChatEvent::Text("Let me ".into()),
                ChatEvent::Text("look.".into()),
                ChatEvent::Tool(ToolCall {
                    id: "tu_1".into(),
                    name: "describe_table".into(),
                    args: json!({ "name": "orders" })
                }),
            ]
        );
    }

    #[test]
    fn an_error_event_maps_to_a_kind() {
        let (_, last) = run(&[(
            "error",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        )]);
        let err = last.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Server);
        assert_eq!(err.message, "Overloaded");
    }

    #[test]
    fn unreadable_tool_arguments_are_a_protocol_error() {
        let (_, last) = run(&[
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"x"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{oops"}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":0}"#,
            ),
        ]);
        assert_eq!(last.unwrap_err().kind, ErrorKind::Protocol);
    }

    #[test]
    fn request_body_carries_tools_and_groups_results() {
        let req = ChatRequest {
            model: "claude-sonnet-5-5".into(),
            system: "sys".into(),
            messages: vec![
                Msg::User("hi".into()),
                Msg::Assistant {
                    text: String::new(),
                    calls: vec![
                        ToolCall {
                            id: "a".into(),
                            name: "list_tables".into(),
                            args: json!({}),
                        },
                        ToolCall {
                            id: "b".into(),
                            name: "describe_table".into(),
                            args: json!({"name":"o"}),
                        },
                    ],
                },
                Msg::ToolResult {
                    call_id: "a".into(),
                    content: "[]".into(),
                },
                Msg::ToolResult {
                    call_id: "b".into(),
                    content: "cols".into(),
                },
            ],
            tools: vec![ToolDef {
                name: "list_tables",
                description: "d",
                schema: json!({"type":"object"}),
            }],
            max_tokens: 100,
            temperature: None,
        };
        let b = body(&req);
        assert_eq!(b["stream"], true);
        assert_eq!(b["system"], "sys");
        assert_eq!(b["tools"][0]["input_schema"]["type"], "object");
        let msgs = b["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3, "both results share one user message");
        assert_eq!(msgs[2]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn urls_do_not_double_v1() {
        let mut cfg = ProviderConfig {
            kind: ProviderKind::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            ..Default::default()
        };
        let creds = Credentials {
            style: AuthStyle::None,
            header: String::new(),
            secret: None,
        };
        assert_eq!(
            Anthropic::new(&cfg, creds.clone()).url("messages"),
            "https://api.anthropic.com/v1/messages"
        );
        cfg.base_url = "https://gw.example.com/anthropic/v1".into();
        assert_eq!(
            Anthropic::new(&cfg, creds).url("messages"),
            "https://gw.example.com/anthropic/v1/messages"
        );
    }
}
