//! Fakes for the Copilot tests: a package archive and an in-memory language server.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use tokio::io::{duplex, split, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::install::binary_name;
use super::rpc::read_message;
use super::service::{Launched, Launcher};

/// A `.tgz` shaped like the platform package.
pub fn package(binary: &[u8]) -> Vec<u8> {
    let mut tar_bytes = Vec::new();
    {
        let mut b = tar::Builder::new(&mut tar_bytes);
        let binary_path = format!("package/{}", binary_name());
        for (name, data) in [
            ("package/package.json", b"{}".as_slice()),
            (binary_path.as_str(), binary),
        ] {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, name, data).unwrap();
        }
        b.finish().unwrap();
    }
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&tar_bytes).unwrap();
    gz.finish().unwrap()
}

pub fn integrity_of(bytes: &[u8]) -> String {
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
    )
}

/// Pretend the component is installed.
pub fn fake_install(data_dir: &Path, version: &str) {
    let dir = super::install::install_dir(data_dir, version);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(binary_name()), b"fake").unwrap();
}

/// What the fake server does, and what it saw.
#[derive(Default)]
pub struct Script {
    /// Who is signed in, as `checkStatus` reports it.
    pub user: Mutex<Option<String>>,
    /// `executeCommand` waits for a value here, then answers with it (`{"__error": ...}` errors).
    pub finish: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    pub finish_rx: Mutex<Option<mpsc::UnboundedReceiver<Value>>>,
    /// The answer to `textDocument/inlineCompletion`.
    pub completion: Mutex<Value>,
    /// Every request and notification received: (method, params).
    pub log: Mutex<Vec<(String, Value)>>,
    pub launches: AtomicUsize,
    /// Set to make the next server die right after `initialize`.
    pub die_after_init: Mutex<bool>,
}

impl Script {
    pub fn new() -> Arc<Self> {
        let s = Arc::new(Self::default());
        let (tx, rx) = mpsc::unbounded_channel();
        *s.finish.lock().unwrap() = Some(tx);
        *s.finish_rx.lock().unwrap() = Some(rx);
        *s.completion.lock().unwrap() = json!({ "items": [] });
        s
    }

    /// Answer the pending `finishDeviceFlow` call.
    pub fn finish_with(&self, v: Value) {
        self.finish
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .send(v)
            .unwrap();
    }

    pub fn methods(&self) -> Vec<String> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .map(|(m, _)| m.clone())
            .collect()
    }

    pub fn calls(&self, method: &str) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == method)
            .map(|(_, p)| p.clone())
            .collect()
    }
}

pub struct FakeLauncher(pub Arc<Script>);

#[async_trait]
impl Launcher for FakeLauncher {
    async fn launch(&self, _binary: &Path) -> std::io::Result<Launched> {
        let script = self.0.clone();
        script.launches.fetch_add(1, Ordering::SeqCst);
        let (client_end, server_end) = duplex(256 * 1024);
        let (cr, cw) = split(client_end);
        let (sr, sw) = split(server_end);
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let writer = Arc::new(tokio::sync::Mutex::new(sw));
        tokio::spawn(async move {
            let mut reader = BufReader::new(sr);
            loop {
                let msg = tokio::select! {
                    _ = stopped.cancelled() => break,
                    m = read_message(&mut reader) => match m { Some(m) => m, None => break },
                };
                let method = msg["method"].as_str().unwrap_or_default().to_string();
                script
                    .log
                    .lock()
                    .unwrap()
                    .push((method.clone(), msg["params"].clone()));
                let Some(id) = msg.get("id").cloned() else {
                    continue; // a notification
                };
                if method == "initialize" && *script.die_after_init.lock().unwrap() {
                    *script.die_after_init.lock().unwrap() = false;
                    let w = writer.clone();
                    let reply = json!({"jsonrpc":"2.0","id":id,"result":{"capabilities":{}}});
                    reply_to(&w, reply).await;
                    break; // the server goes away
                }
                let writer = writer.clone();
                let script = script.clone();
                tokio::spawn(async move {
                    let result: Result<Value, Value> = match method.as_str() {
                        "initialize" => Ok(json!({ "capabilities": {} })),
                        "checkStatus" => Ok(match script.user.lock().unwrap().clone() {
                            Some(u) => json!({ "status": "OK", "user": u }),
                            None => json!({ "status": "NotSignedIn" }),
                        }),
                        "signIn" => Ok(json!({
                            "userCode": "ABCD-EFGH",
                            "command": {
                                "command": "github.copilot.finishDeviceFlow",
                                "arguments": [],
                                "title": "Sign in",
                            },
                        })),
                        "workspace/executeCommand" => {
                            let rx = script.finish_rx.lock().unwrap().take();
                            let Some(mut rx) = rx else {
                                return;
                            };
                            let v = rx.recv().await;
                            *script.finish_rx.lock().unwrap() = Some(rx);
                            match v {
                                Some(v) if v.get("__error").is_some() => {
                                    Err(json!({ "code": -32000, "message": v["__error"] }))
                                }
                                Some(v) => {
                                    if v["status"] == "OK" {
                                        *script.user.lock().unwrap() =
                                            v["user"].as_str().map(str::to_string);
                                    }
                                    Ok(v)
                                }
                                None => return,
                            }
                        }
                        "signOut" => {
                            *script.user.lock().unwrap() = None;
                            Ok(json!({ "status": "NotSignedIn" }))
                        }
                        "textDocument/inlineCompletion" => {
                            Ok(script.completion.lock().unwrap().clone())
                        }
                        _ => Err(json!({ "code": -32601, "message": "Method not found" })),
                    };
                    let reply = match result {
                        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
                        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
                    };
                    reply_to(&writer, reply).await;
                });
            }
        });
        Ok(Launched {
            reader: Box::new(cr),
            writer: Box::new(cw),
            stop: Box::new(move || stop.cancel()),
        })
    }
}

async fn reply_to(
    w: &Arc<tokio::sync::Mutex<tokio::io::WriteHalf<tokio::io::DuplexStream>>>,
    v: Value,
) {
    let body = serde_json::to_vec(&v).unwrap();
    let mut w = w.lock().await;
    let _ = w
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await;
    let _ = w.write_all(&body).await;
    let _ = w.flush().await;
}
