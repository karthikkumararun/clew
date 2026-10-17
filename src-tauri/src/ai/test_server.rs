//! A tiny HTTP server for provider tests: answers each request with a canned response and
//! records what it received.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    /// Lower-cased header names.
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Clone)]
pub struct Canned {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl Canned {
    pub fn sse(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            body: body.into(),
        }
    }

    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.into(),
        }
    }
}

pub struct TestServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
}

/// Serve `responses` in order, one per connection; the last one repeats.
pub async fn serve(responses: Vec<Canned>) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    tokio::spawn(async move {
        let mut n = 0usize;
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let canned = responses[n.min(responses.len() - 1)].clone();
            n += 1;
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let (head_end, content_length) = loop {
                    let read = sock.read(&mut tmp).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        break (pos + 4, len);
                    }
                };
                while buf.len() < head_end + content_length {
                    let read = sock.read(&mut tmp).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end - 4]).to_string();
                let mut lines = head.lines();
                let first = lines.next().unwrap_or_default();
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let headers = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
                    .collect();
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                log.lock().unwrap().push(Recorded {
                    method,
                    path,
                    headers,
                    body,
                });
                let response = format!(
                    "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    canned.status,
                    canned.content_type,
                    canned.body.len(),
                    canned.body
                );
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    TestServer { url, requests }
}
