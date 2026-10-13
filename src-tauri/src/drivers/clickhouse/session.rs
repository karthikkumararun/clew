//! A ClickHouse session over HTTP. HTTP has no connection state, so a session is a `session_id`
//! sent with every request (which keeps `SET`, temporary tables and `USE` between statements).
//! Rows stream from the response body, line by line, through the shared [`paging`] channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use futures::StreamExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::client::{http_error, Client, Opts};
use super::types::{is_nullable, kind_of, to_value, unwrap_type};
use crate::drivers::paging::{self, Msg, STREAM_BUFFER};
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, ResultEvent, ResultId, ResultSink, ServerInfo, Session, Value,
};

type OpenStream = paging::OpenStream<()>;

pub struct ChCancel {
    client: Arc<Client>,
    query_id: Mutex<Option<String>>,
    cancelled: AtomicBool,
}

#[async_trait]
impl CancelFn for ChCancel {
    async fn cancel(&self) -> DriverResult<()> {
        let id = self.query_id.lock().unwrap().clone();
        if let Some(id) = id {
            self.cancelled.store(true, Ordering::SeqCst);
            self.client.kill(&id).await?;
        }
        Ok(())
    }
}

pub struct ChSession {
    client: Arc<Client>,
    session_id: String,
    read_only: bool,
    cancel: Arc<ChCancel>,
    server: ServerInfo,
    next_result: ResultId,
    stream: Option<OpenStream>,
}

enum Head {
    Columns(Vec<ColumnMeta>),
    Done(u64),
    Err(DriverError),
}

fn first_word(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, t)| t).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, t)| t).trim_start();
        } else {
            break;
        }
    }
    if rest.starts_with('(') {
        return "SELECT".into();
    }
    rest.split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// Statements that produce a result set (ClickHouse would reject `FORMAT` on the others).
pub fn returns_rows(sql: &str) -> bool {
    matches!(
        first_word(sql).as_str(),
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "EXISTS" | "VALUES"
    )
}

/// `written_rows` from the `X-ClickHouse-Summary` header.
fn written_rows(summary: Option<&str>) -> u64 {
    summary
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|j| {
            j.get("written_rows").and_then(|v| {
                v.as_str()
                    .map(str::to_string)
                    .or_else(|| v.as_u64().map(|n| n.to_string()))
            })
        })
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Pull complete lines out of a growing buffer.
fn take_line(buf: &mut Vec<u8>) -> Option<String> {
    let at = buf.iter().position(|b| *b == b'\n')?;
    let line: Vec<u8> = buf.drain(..=at).collect();
    Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned())
}

/// A line of the body that isn't a row: ClickHouse reports an exception raised mid-stream as text.
fn stream_error(line: &str, sql: &str) -> DriverError {
    http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR, line, sql)
}

#[allow(clippy::too_many_arguments)]
async fn run_statement(
    client: Arc<Client>,
    opts: (String, String, bool),
    sql: String,
    rows: bool,
    cancel: Arc<ChCancel>,
    head: oneshot::Sender<Head>,
    tx: mpsc::Sender<Msg>,
) {
    let (session, query_id, read_only) = opts;
    let o = Opts {
        session: Some(&session),
        query_id: Some(&query_id),
        read_only,
        plain_numbers: false,
        wait: !rows,
    };
    let body = if rows {
        format!(
            "{}\nFORMAT JSONCompactEachRowWithNamesAndTypes",
            sql.trim().trim_end_matches(';')
        )
    } else {
        sql.clone()
    };
    let fail = |e: DriverError| {
        if cancel.cancelled.load(Ordering::SeqCst) {
            DriverError::new(ErrorCode::Cancelled, "The statement was cancelled")
        } else {
            e
        }
    };
    let response = match client.send(client.request(&o, body), &sql).await {
        Ok(r) => r,
        Err(e) => {
            let _ = head.send(Head::Err(fail(e)));
            return;
        }
    };
    if !rows {
        let summary = response
            .headers()
            .get("x-clickhouse-summary")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let _ = response.bytes().await;
        let _ = head.send(Head::Done(written_rows(summary.as_deref())));
        return;
    }

    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut header: Vec<Vec<String>> = Vec::new();
    let mut head = Some(head);
    let mut types: Vec<String> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let err = fail(client.transport_error(e));
                match head.take() {
                    Some(h) => {
                        let _ = h.send(Head::Err(err));
                    }
                    None => {
                        let _ = tx.send(Msg::Err(err)).await;
                    }
                }
                return;
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some(line) = take_line(&mut buf) {
            if line.is_empty() {
                continue;
            }
            if !line.starts_with('[') {
                let err = fail(stream_error(&line, &sql));
                match head.take() {
                    Some(h) => {
                        let _ = h.send(Head::Err(err));
                    }
                    None => {
                        let _ = tx.send(Msg::Err(err)).await;
                    }
                }
                return;
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let items = json.as_array().cloned().unwrap_or_default();
            if header.len() < 2 {
                header.push(
                    items
                        .iter()
                        .map(|i| i.as_str().unwrap_or_default().to_string())
                        .collect(),
                );
                if header.len() == 2 {
                    types = header[1].clone();
                    let metas = header[0]
                        .iter()
                        .zip(&types)
                        .map(|(name, ty)| ColumnMeta {
                            name: name.clone(),
                            type_name: unwrap_type(ty).to_string(),
                            kind: kind_of(ty),
                            nullable: Some(is_nullable(ty)),
                            source_table: None,
                            source_column: None,
                            source_schema: None,
                            source_updatable: None,
                        })
                        .collect();
                    if let Some(h) = head.take() {
                        if h.send(Head::Columns(metas)).is_err() {
                            return;
                        }
                    }
                }
                continue;
            }
            let row: Vec<Value> = items
                .iter()
                .enumerate()
                .map(|(i, v)| to_value(types.get(i).map_or("String", String::as_str), v))
                .collect();
            if tx.send(Msg::Row(row)).await.is_err() {
                return; // the consumer abandoned the result
            }
        }
    }
    match head.take() {
        // No header at all: an empty body (a statement that returns nothing).
        Some(h) => {
            let _ = h.send(Head::Done(0));
        }
        None => {
            let _ = tx.send(Msg::End).await;
        }
    }
}

impl ChSession {
    pub fn new(client: Arc<Client>, server: ServerInfo) -> Self {
        let cancel = Arc::new(ChCancel {
            client: client.clone(),
            query_id: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        });
        Self {
            read_only: client.read_only_default(),
            session_id: format!("clew-{}", uuid::Uuid::new_v4()),
            client,
            cancel,
            server,
            next_result: 1,
            stream: None,
        }
    }

    fn begin_statement(&self) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.cancel.cancelled.store(false, Ordering::SeqCst);
        *self.cancel.query_id.lock().unwrap() = Some(id.clone());
        id
    }

    fn end_statement(&self) {
        *self.cancel.query_id.lock().unwrap() = None;
    }

    async fn reclaim(&mut self) {
        if let Some(OpenStream { rx, task, .. }) = self.stream.take() {
            drop(rx);
            let _ = self.cancel.cancel().await;
            let _ = task.await;
            self.end_statement();
        }
    }

    async fn page(
        &mut self,
        result_id: ResultId,
        count: usize,
        sink: &ResultSink,
        started: Instant,
    ) -> DriverResult<ExecSummary> {
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| DriverError::internal("No open result to read from"))?;
        let outcome = paging::read_page(stream, count, sink).await;
        if outcome.finished {
            if let Some(OpenStream { task, .. }) = self.stream.take() {
                let _ = task.await;
            }
            self.end_statement();
        }
        if let Some(e) = outcome.error {
            return Err(e);
        }
        let summary = ExecSummary {
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            has_more: outcome.has_more,
        };
        if !outcome.receiver_gone {
            sink.send(ResultEvent::Done {
                result_id,
                summary: summary.clone(),
            })
            .await;
        }
        Ok(summary)
    }
}

#[async_trait]
impl Session for ChSession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        self.reclaim().await;
        let query_id = self.begin_statement();
        let rows = returns_rows(&req.sql);
        let (head_tx, head_rx) = oneshot::channel();
        let (tx, rx) = mpsc::channel(STREAM_BUFFER);
        let task: JoinHandle<()> = tokio::spawn(run_statement(
            self.client.clone(),
            (self.session_id.clone(), query_id, self.read_only),
            req.sql.clone(),
            rows,
            self.cancel.clone(),
            head_tx,
            tx,
        ));
        match head_rx.await {
            Ok(Head::Columns(columns)) => {
                let result_id = self.next_result;
                self.next_result += 1;
                sink.send(ResultEvent::Columns {
                    result_id,
                    statement: 0,
                    columns,
                })
                .await;
                self.stream = Some(OpenStream::new(result_id, rx, task));
                self.page(result_id, req.page_size.max(1), &sink, started)
                    .await
            }
            Ok(Head::Done(affected)) => {
                let _ = task.await;
                self.end_statement();
                let result_id = self.next_result;
                self.next_result += 1;
                let summary = ExecSummary {
                    rows_affected: if rows { None } else { Some(affected) },
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    has_more: false,
                };
                sink.send(ResultEvent::Done {
                    result_id,
                    summary: summary.clone(),
                })
                .await;
                Ok(summary)
            }
            Ok(Head::Err(e)) => {
                let _ = task.await;
                self.end_statement();
                Err(e)
            }
            Err(_) => {
                self.end_statement();
                Err(DriverError::new(
                    ErrorCode::ConnectionLost,
                    format!("The connection to {} was lost", self.client.target()),
                ))
            }
        }
    }

    async fn fetch_more(
        &mut self,
        result_id: ResultId,
        n: usize,
        sink: ResultSink,
    ) -> DriverResult<bool> {
        match &self.stream {
            Some(s) if s.result_id == result_id => {}
            _ => {
                return Err(DriverError::new(
                    ErrorCode::Unsupported,
                    "That result is no longer open; run the statement again",
                ))
            }
        }
        let summary = self
            .page(result_id, n.max(1), &sink, Instant::now())
            .await?;
        Ok(summary.has_more)
    }

    /// `readonly=1` is sent with every request of a read-only session, so switching is a flag.
    async fn set_read_only(&mut self, read_only: bool) -> DriverResult<()> {
        self.read_only = read_only;
        Ok(())
    }

    fn cancel_handle(&self) -> CancelHandle {
        struct Handle(Arc<ChCancel>);
        #[async_trait]
        impl CancelFn for Handle {
            async fn cancel(&self) -> DriverResult<()> {
                self.0.cancel().await
            }
        }
        CancelHandle::new(Handle(self.cancel.clone()))
    }

    fn server_info(&self) -> ServerInfo {
        self.server.clone()
    }

    async fn close(mut self: Box<Self>) -> DriverResult<()> {
        self.reclaim().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_statements_show_rows() {
        for sql in [
            "SELECT 1",
            " -- c\nselect 1",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SHOW TABLES",
            "DESCRIBE t",
            "EXPLAIN SELECT 1",
            "EXISTS TABLE t",
            "(SELECT 1)",
        ] {
            assert!(returns_rows(sql), "{sql}");
        }
        for sql in [
            "INSERT INTO t VALUES (1)",
            "CREATE TABLE t (a Int8) ENGINE = Memory",
            "SET max_threads = 1",
            "USE db",
            "OPTIMIZE TABLE t",
            "ALTER TABLE t DELETE WHERE 1",
        ] {
            assert!(!returns_rows(sql), "{sql}");
        }
    }

    #[test]
    fn the_summary_header_gives_rows_written() {
        assert_eq!(
            written_rows(Some(
                r#"{"read_rows":"0","written_rows":"3","written_bytes":"12"}"#
            )),
            3
        );
        assert_eq!(written_rows(Some("not json")), 0);
        assert_eq!(written_rows(None), 0);
    }

    #[test]
    fn lines_are_cut_from_a_growing_buffer() {
        let mut b = b"[1]\n[2".to_vec();
        assert_eq!(take_line(&mut b).as_deref(), Some("[1]"));
        assert_eq!(take_line(&mut b), None);
        b.extend_from_slice(b"]\n");
        assert_eq!(take_line(&mut b).as_deref(), Some("[2]"));
    }
}
