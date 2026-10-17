//! The OpenAI Chat Completions API: OpenAI itself, OpenAI-compatible custom endpoints and local
//! servers (Ollama, LM Studio).

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
use crate::ai::config::ProviderConfig;
use crate::ai::sse::SseParser;

pub struct OpenAi {
    base: String,
    creds: Credentials,
    extra: Vec<(String, String)>,
    client: reqwest::Client,
    local: bool,
}

/// A local server address like `http://localhost:11434` has no path; its OpenAI-compatible API
/// lives under `/v1`.
fn api_base(base: &str, local: bool) -> String {
    let base = base.trim_end_matches('/');
    if local {
        if let Ok(u) = url::Url::parse(base) {
            if u.path().trim_matches('/').is_empty() {
                return format!("{base}/v1");
            }
        }
    }
    base.to_string()
}

impl OpenAi {
    pub fn new(cfg: &ProviderConfig, creds: Credentials, local: bool) -> Self {
        Self {
            base: api_base(&cfg.base_url, local),
            creds,
            extra: cfg.extra_headers.clone(),
            client: http_client(),
            local,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base)
    }

    /// The error shown when nothing answers: a local server gets a hint about Ollama.
    fn unreachable(&self, e: &reqwest::Error) -> ProviderError {
        let err = send_error(e, &self.base);
        if self.local && err.kind == ErrorKind::Unreachable && e.is_connect() {
            if let Ok(u) = url::Url::parse(&self.base) {
                let hostport = match (u.host_str(), u.port_or_known_default()) {
                    (Some(h), Some(p)) => format!("{h}:{p}"),
                    (Some(h), None) => h.to_string(),
                    _ => self.base.clone(),
                };
                return ProviderError::new(
                    ErrorKind::Unreachable,
                    format!("Nothing is listening on {hostport} — is Ollama running?"),
                );
            }
        }
        err
    }
}

pub fn body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if !req.system.is_empty() {
        messages.push(json!({ "role": "system", "content": req.system }));
    }
    for m in &req.messages {
        match m {
            Msg::User(t) => messages.push(json!({ "role": "user", "content": t })),
            Msg::Assistant { text, calls } => {
                let mut msg = json!({
                    "role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { json!(text) },
                });
                if !calls.is_empty() {
                    msg["tool_calls"] = Value::Array(
                        calls
                            .iter()
                            .map(|c| {
                                json!({
                                    "id": c.id,
                                    "type": "function",
                                    "function": { "name": c.name, "arguments": c.args.to_string() },
                                })
                            })
                            .collect(),
                    );
                }
                messages.push(msg);
            }
            Msg::ToolResult { call_id, content } => messages
                .push(json!({ "role": "tool", "tool_call_id": call_id, "content": content })),
        }
    }
    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "stream": true,
        "max_tokens": req.max_tokens,
    });
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.schema,
                        }
                    })
                })
                .collect(),
        );
    }
    body
}

/// Turns the streamed chunks of one reply into [`ChatEvent`]s.
#[derive(Default)]
pub struct Reader {
    /// Tool calls being assembled, by index: id, name and the argument text so far.
    calls: BTreeMap<u64, (String, String, String)>,
}

impl Reader {
    fn flush(&mut self, tx: &UnboundedSender<ChatEvent>) -> ProviderResult<()> {
        for (_, (id, name, args)) in std::mem::take(&mut self.calls) {
            let args = if args.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&args).map_err(|_| {
                    ProviderError::new(
                        ErrorKind::Protocol,
                        format!("The model sent unreadable arguments for {name}"),
                    )
                })?
            };
            let _ = tx.send(ChatEvent::Tool(ToolCall { id, name, args }));
        }
        Ok(())
    }

    /// Handle one `data:` payload. `Ok(true)` when the reply is complete.
    pub fn handle(&mut self, data: &str, tx: &UnboundedSender<ChatEvent>) -> ProviderResult<bool> {
        if data.trim() == "[DONE]" {
            self.flush(tx)?;
            return Ok(true);
        }
        let v: Value = serde_json::from_str(data)
            .map_err(|_| ProviderError::new(ErrorKind::Protocol, "Unreadable stream event"))?;
        if let Some(msg) = v["error"]["message"].as_str() {
            return Err(ProviderError::new(ErrorKind::Other, msg));
        }
        let Some(choice) = v["choices"].get(0) else {
            return Ok(false);
        };
        let delta = &choice["delta"];
        if let Some(t) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            let _ = tx.send(ChatEvent::Text(t.to_string()));
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for c in calls {
                let index = c["index"].as_u64().unwrap_or(0);
                let entry = self.calls.entry(index).or_default();
                if let Some(id) = c["id"].as_str() {
                    entry.0 = id.to_string();
                }
                if let Some(name) = c["function"]["name"].as_str() {
                    entry.1.push_str(name);
                }
                if let Some(args) = c["function"]["arguments"].as_str() {
                    entry.2.push_str(args);
                }
            }
        }
        if choice["finish_reason"].is_string() {
            self.flush(tx)?;
        }
        Ok(false)
    }
}

#[async_trait]
impl ChatProvider for OpenAi {
    async fn models(&self) -> ProviderResult<Vec<ModelInfo>> {
        let resp = authorize(
            self.client.get(self.url("models")),
            &self.creds,
            &self.extra,
        )
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| self.unreachable(&e))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(status_error(status, &text));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|_| ProviderError::new(ErrorKind::Protocol, "Unreadable model list"))?;
        let mut models: Vec<ModelInfo> = v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| {
                        let id = m["id"].as_str()?.to_string();
                        Some(ModelInfo {
                            name: id.clone(),
                            id,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(models)
    }

    async fn chat(
        &self,
        req: ChatRequest,
        tx: UnboundedSender<ChatEvent>,
        cancel: CancellationToken,
    ) -> ProviderResult<()> {
        let send = authorize(
            self.client.post(self.url("chat/completions")),
            &self.creds,
            &self.extra,
        )
        .json(&body(&req))
        .send();
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err(ProviderError::new(ErrorKind::Cancelled, "Stopped")),
            r = send => r.map_err(|e| self.unreachable(&e))?,
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
                if reader.handle(&ev.data, &tx)? {
                    let _ = tx.send(ChatEvent::Done);
                    return Ok(());
                }
            }
        }
        reader.flush(&tx)?;
        let _ = tx.send(ChatEvent::Done);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::config::{AuthStyle, ProviderKind};
    use crate::ai::providers::ToolDef;

    fn run(chunks: &[&str]) -> (Vec<ChatEvent>, ProviderResult<bool>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut r = Reader::default();
        let mut last = Ok(false);
        for c in chunks {
            last = r.handle(c, &tx);
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
    fn streams_text_then_done() {
        let (events, last) = run(&[
            r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"{"choices":[{"delta":{"content":"lo"}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            "[DONE]",
        ]);
        assert_eq!(last, Ok(true));
        assert_eq!(
            events,
            vec![ChatEvent::Text("Hel".into()), ChatEvent::Text("lo".into())]
        );
    }

    #[test]
    fn assembles_a_tool_call_from_fragments() {
        let (events, _) = run(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"describe_table","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"name\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"orders\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            "[DONE]",
        ]);
        assert_eq!(
            events,
            vec![ChatEvent::Tool(ToolCall {
                id: "call_1".into(),
                name: "describe_table".into(),
                args: json!({ "name": "orders" })
            })]
        );
    }

    #[test]
    fn an_error_payload_is_reported() {
        let (_, last) = run(&[r#"{"error":{"message":"model overloaded"}}"#]);
        assert_eq!(last.unwrap_err().message, "model overloaded");
    }

    #[test]
    fn request_body_uses_tool_roles() {
        let req = ChatRequest {
            model: "gpt".into(),
            system: "sys".into(),
            messages: vec![
                Msg::User("hi".into()),
                Msg::Assistant {
                    text: String::new(),
                    calls: vec![ToolCall {
                        id: "c1".into(),
                        name: "list_tables".into(),
                        args: json!({}),
                    }],
                },
                Msg::ToolResult {
                    call_id: "c1".into(),
                    content: "[]".into(),
                },
            ],
            tools: vec![ToolDef {
                name: "list_tables",
                description: "d",
                schema: json!({"type":"object"}),
            }],
            max_tokens: 10,
            temperature: Some(0.0),
        };
        let b = body(&req);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(
            b["messages"][2]["tool_calls"][0]["function"]["arguments"],
            "{}"
        );
        assert_eq!(b["messages"][3]["role"], "tool");
        assert_eq!(b["tools"][0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn local_addresses_get_the_v1_prefix() {
        assert_eq!(
            api_base("http://localhost:11434", true),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            api_base("http://localhost:1234/v1/", true),
            "http://localhost:1234/v1"
        );
        assert_eq!(
            api_base("https://llm.example.com/v1", false),
            "https://llm.example.com/v1"
        );
        assert_eq!(
            api_base("https://x.example.com", false),
            "https://x.example.com"
        );
    }

    #[test]
    fn debug_never_shows_the_secret() {
        let creds = Credentials {
            style: AuthStyle::Bearer,
            header: String::new(),
            secret: Some("sk-very-secret".into()),
        };
        assert!(!format!("{creds:?}").contains("sk-very-secret"));
        let cfg = ProviderConfig {
            kind: ProviderKind::Openai,
            base_url: OPENAI_BASE_FOR_TEST.into(),
            ..Default::default()
        };
        let _ = OpenAi::new(&cfg, creds, false);
    }

    const OPENAI_BASE_FOR_TEST: &str = "https://api.openai.com/v1";
}
