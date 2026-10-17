//! A small JSON-RPC 2.0 client over LSP framing (`Content-Length` headers) for the Copilot
//! language server.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const CLOSED: i64 = -32099;

    pub fn closed() -> Self {
        Self {
            code: Self::CLOSED,
            message: "The Copilot component stopped".into(),
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

/// Answers requests the server sends to the client, and sees its notifications.
pub trait Handler: Send + Sync {
    fn request(&self, method: &str, params: &Value) -> Result<Value, RpcError>;
    fn notification(&self, method: &str, params: &Value);
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct RpcClient {
    writer: AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pending: Pending,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
}

/// Write one framed message.
async fn write_message(
    w: &mut (dyn AsyncWrite + Send + Unpin),
    value: &Value,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(value)?;
    w.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await?;
    w.write_all(&body).await?;
    w.flush().await
}

/// Read one framed message; `None` at the end of the stream.
pub async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> Option<Value> {
    let mut length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).await.ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line
            .strip_prefix("Content-Length:")
            .or_else(|| line.strip_prefix("content-length:"))
        {
            length = v.trim().parse().ok();
        }
    }
    let mut body = vec![0u8; length?];
    r.read_exact(&mut body).await.ok()?;
    serde_json::from_slice(&body).ok()
}

impl RpcClient {
    /// Start reading from `reader`; `handler` hears about everything the server initiates.
    pub fn new<R, W>(reader: R, writer: W, handler: Arc<dyn Handler>) -> Arc<Self>
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let client = Arc::new(Self {
            writer: AsyncMutex::new(Box::new(writer)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            closed: Arc::new(AtomicBool::new(false)),
        });
        let weak = Arc::downgrade(&client);
        let pending = client.pending.clone();
        let closed = client.closed.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            while let Some(msg) = read_message(&mut reader).await {
                let method = msg.get("method").and_then(|m| m.as_str());
                let id = msg.get("id").cloned();
                match (method, id) {
                    // A request from the server.
                    (Some(method), Some(id)) => {
                        let params = msg.get("params").cloned().unwrap_or(Value::Null);
                        let reply = match handler.request(method, &params) {
                            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            Err(e) => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": { "code": e.code, "message": e.message },
                            }),
                        };
                        if let Some(c) = weak.upgrade() {
                            let mut w = c.writer.lock().await;
                            let _ = write_message(&mut **w, &reply).await;
                        }
                    }
                    // A notification.
                    (Some(method), None) => {
                        handler.notification(method, msg.get("params").unwrap_or(&Value::Null));
                    }
                    // A reply to one of our requests.
                    (None, Some(id)) => {
                        let Some(id) = id.as_u64() else { continue };
                        let tx = pending.lock().unwrap().remove(&id);
                        if let Some(tx) = tx {
                            let result = match msg.get("error") {
                                Some(e) => Err(RpcError {
                                    code: e["code"].as_i64().unwrap_or(-32000),
                                    message: e["message"].as_str().unwrap_or("error").to_string(),
                                }),
                                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(result);
                        }
                    }
                    _ => {}
                }
            }
            closed.store(true, Ordering::SeqCst);
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err(RpcError::closed()));
            }
        });
        client
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if self.is_closed() {
            return Err(RpcError::closed());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        {
            let mut w = self.writer.lock().await;
            if write_message(&mut **w, &msg).await.is_err() {
                self.pending.lock().unwrap().remove(&id);
                return Err(RpcError::closed());
            }
        }
        rx.await.unwrap_or_else(|_| Err(RpcError::closed()))
    }

    pub async fn notify(&self, method: &str, params: Value) {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut w = self.writer.lock().await;
        let _ = write_message(&mut **w, &msg).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

    struct Quiet;
    impl Handler for Quiet {
        fn request(&self, method: &str, _: &Value) -> Result<Value, RpcError> {
            if method == "ping" {
                Ok(json!("pong"))
            } else {
                Err(RpcError {
                    code: RpcError::METHOD_NOT_FOUND,
                    message: "nope".into(),
                })
            }
        }
        fn notification(&self, _: &str, _: &Value) {}
    }

    /// The server end of a duplex pair: reads framed messages, writes framed replies.
    struct Server {
        reader: BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
        writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    }

    impl Server {
        async fn recv(&mut self) -> Value {
            read_message(&mut self.reader).await.expect("a message")
        }
        async fn send(&mut self, v: Value) {
            write_message(&mut self.writer, &v).await.unwrap();
        }
    }

    fn pair() -> (Arc<RpcClient>, Server) {
        let (a, b) = duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        (
            RpcClient::new(ar, aw, Arc::new(Quiet)),
            Server {
                reader: BufReader::new(br),
                writer: bw,
            },
        )
    }

    #[tokio::test]
    async fn requests_are_framed_and_matched_to_their_replies() {
        let (client, mut server) = pair();
        let c = client.clone();
        let task = tokio::spawn(async move { c.request("signIn", json!({"a": 1})).await });
        let req = server.recv().await;
        assert_eq!(req["method"], "signIn");
        assert_eq!(req["params"]["a"], 1);
        server
            .send(json!({"jsonrpc":"2.0","id":req["id"],"result":{"userCode":"ABCD-EFGH"}}))
            .await;
        assert_eq!(task.await.unwrap().unwrap()["userCode"], "ABCD-EFGH");
    }

    #[tokio::test]
    async fn out_of_order_replies_reach_the_right_caller() {
        let (client, mut server) = pair();
        let (c1, c2) = (client.clone(), client.clone());
        let t1 = tokio::spawn(async move { c1.request("a", json!({})).await });
        let r1 = server.recv().await;
        let t2 = tokio::spawn(async move { c2.request("b", json!({})).await });
        let r2 = server.recv().await;
        server
            .send(json!({"id": r2["id"], "result": "second"}))
            .await;
        server
            .send(json!({"id": r1["id"], "result": "first"}))
            .await;
        assert_eq!(t1.await.unwrap().unwrap(), "first");
        assert_eq!(t2.await.unwrap().unwrap(), "second");
    }

    #[tokio::test]
    async fn errors_come_back_as_errors() {
        let (client, mut server) = pair();
        let c = client.clone();
        let t = tokio::spawn(async move { c.request("x", json!({})).await });
        let req = server.recv().await;
        server
            .send(
                json!({"id": req["id"], "error": {"code": -32601, "message": "Method not found"}}),
            )
            .await;
        let err = t.await.unwrap().unwrap_err();
        assert_eq!(err.code, RpcError::METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn requests_from_the_server_get_answers() {
        let (_client, mut server) = pair();
        server
            .send(json!({"jsonrpc":"2.0","id":7,"method":"ping","params":{}}))
            .await;
        let reply = server.recv().await;
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["result"], "pong");
        server
            .send(json!({"jsonrpc":"2.0","id":8,"method":"unknown","params":{}}))
            .await;
        let reply = server.recv().await;
        assert_eq!(reply["error"]["code"], RpcError::METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn frames_split_across_writes_and_back_to_back_messages_parse() {
        let (a, b) = duplex(1024);
        let (mut bw, _br) = (b, ());
        let task = tokio::spawn(async move {
            let mut r = BufReader::new(a);
            (
                read_message(&mut r).await,
                read_message(&mut r).await,
                read_message(&mut r).await,
            )
        });
        let one = br#"{"id":1}"#;
        let two = "{\"id\":2,\"x\":\"é\"}".as_bytes().to_vec();
        let frame = |b: &[u8]| {
            [
                format!("Content-Length: {}\r\n\r\n", b.len()).into_bytes(),
                b.to_vec(),
            ]
            .concat()
        };
        let f1 = frame(one);
        bw.write_all(&f1[..10]).await.unwrap();
        bw.write_all(&f1[10..]).await.unwrap();
        bw.write_all(&frame(&two)).await.unwrap();
        drop(bw);
        let (m1, m2, m3) = task.await.unwrap();
        assert_eq!(m1.unwrap()["id"], 1);
        assert_eq!(m2.unwrap()["x"], "é");
        assert!(m3.is_none());
    }

    #[tokio::test]
    async fn pending_requests_fail_when_the_server_goes_away() {
        let (client, server) = pair();
        let c = client.clone();
        let t = tokio::spawn(async move { c.request("slow", json!({})).await });
        tokio::task::yield_now().await;
        drop(server);
        let err = t.await.unwrap().unwrap_err();
        assert_eq!(err.code, RpcError::CLOSED);
        assert!(client.request("again", json!({})).await.is_err());
    }
}
