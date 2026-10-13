//! A SQL Server session: one TDS connection driven by tiberius (pure async Rust).
//!
//! A statement runs in a task that owns the client and feeds rows through the shared [`paging`]
//! channel, like the other drivers. Cancel sends a TDS *attention* (`cancel_query`), which the
//! task issues once it has dropped its result stream.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use futures::TryStreamExt;
use tiberius::{Client, ColumnType, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;
use tokio_util::compat::Compat;

use super::error::map_error;
use super::types::{kind_of, to_value, type_name};
use crate::drivers::paging::{self, Msg, STREAM_BUFFER};
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, ResultEvent, ResultId, ResultSink, ServerInfo, Session, Value,
};

pub type TdsClient = Client<Compat<TcpStream>>;
type OpenStream = paging::OpenStream<TdsClient>;

enum ConnState {
    Idle(Box<TdsClient>),
    Streaming,
    Gone,
}

pub struct TdsCancel {
    /// Replaced for every statement so a stale signal can't cancel the next one.
    notify: Mutex<Arc<Notify>>,
    running: std::sync::atomic::AtomicBool,
    cancelled: std::sync::atomic::AtomicBool,
    /// The connection could not be brought back to a clean state after a cancel.
    broken: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl CancelFn for TdsCancel {
    async fn cancel(&self) -> DriverResult<()> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.running.load(SeqCst) {
            self.cancelled.store(true, SeqCst);
            self.notify.lock().unwrap().notify_one();
        }
        Ok(())
    }
}

pub struct MsSession {
    conn: ConnState,
    cancel: Arc<TdsCancel>,
    server: ServerInfo,
    next_result: ResultId,
    stream: Option<OpenStream>,
    target: String,
}

enum Head {
    Columns(Vec<ColumnMeta>),
    Done(u64),
    Err(DriverError),
}

fn first_words(sql: &str) -> (String, String) {
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
    let mut words = rest
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_uppercase);
    (
        words.next().unwrap_or_default(),
        words.next().unwrap_or_default(),
    )
}

/// Statements that report how many rows they changed.
pub fn is_dml(sql: &str) -> bool {
    matches!(
        first_words(sql).0.as_str(),
        "INSERT" | "UPDATE" | "DELETE" | "MERGE"
    )
}

fn is_money(t: ColumnType) -> bool {
    matches!(t, ColumnType::Money | ColumnType::Money4)
}

/// Ask the server to stop the running batch with a TDS attention.
///
/// tiberius waits for the acknowledgement only for as long as the current message lasts. When the
/// server answers in a message of its own (or has not answered yet) `cancel_query` fails, and the
/// late acknowledgement would then be read as the answer to the *next* query, one query behind
/// forever. The attention has still done its job on the server, so on failure the connection is
/// marked broken and not reused: the session reconnects before its next statement.
async fn stop_server_work(client: &mut TdsClient, cancel: &TdsCancel) {
    if client.cancel_query().await.is_err() {
        cancel
            .broken
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Read and discard what is left of an abandoned result, for a moment. A result that is nearly
/// done is cheaper to finish than to cancel; a long one is cancelled.
async fn drain(stream: &mut tiberius::QueryStream<'_>) -> bool {
    let finish = async { while let Ok(Some(_)) = stream.try_next().await {} };
    tokio::time::timeout(std::time::Duration::from_millis(1500), finish)
        .await
        .is_ok()
}

async fn run_batch(
    mut client: TdsClient,
    sql: String,
    target: String,
    notify: Arc<Notify>,
    cancel: Arc<TdsCancel>,
    head: oneshot::Sender<Head>,
    tx: mpsc::Sender<Msg>,
) -> TdsClient {
    let cancelled_error = || DriverError::new(ErrorCode::Cancelled, "The statement was cancelled");
    let mut head = Some(head);

    // Row-returning batch: stream the first result set, ignore any further ones.
    enum Ended {
        Clean,
        Interrupted,
        Abandoned,
    }
    // Statements that report a count run as a plain SQL batch (so USE, SET, temp tables and
    // transactions keep their session scope; `execute` would wrap them in sp_executesql) with the
    // count read back from @@ROWCOUNT.
    let counting = is_dml(&sql);
    let sent = if counting {
        format!("{}\n;SELECT @@ROWCOUNT AS clew_rowcount", sql.trim_end())
    } else {
        sql.clone()
    };
    let ended = 'stream: {
        let started = tokio::select! {
            _ = notify.notified() => break 'stream Ended::Interrupted,
            r = client.simple_query(sent.as_str()) => r,
        };
        let mut stream = match started {
            Ok(stream) => stream,
            Err(e) => {
                if let Some(h) = head.take() {
                    let _ = h.send(Head::Err(map_error(e, &target)));
                }
                break 'stream Ended::Clean;
            }
        };
        let mut money: Vec<bool> = Vec::new();
        let mut seen_set = false;
        let mut counted: u64 = 0;
        loop {
            let item = tokio::select! {
                _ = notify.notified() => break 'stream Ended::Interrupted,
                item = stream.try_next() => item,
            };
            match item {
                Ok(Some(QueryItem::Metadata(_))) if counting => {}
                Ok(Some(QueryItem::Row(row))) if counting => {
                    if let Some(n) = row.get::<i32, _>(0) {
                        counted = n.max(0) as u64;
                    }
                }
                Ok(Some(QueryItem::Metadata(meta))) => {
                    if seen_set {
                        continue; // a further result set: not shown
                    }
                    seen_set = true;
                    let columns: Vec<ColumnMeta> = meta
                        .columns()
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            type_name: type_name(c.column_type()).to_string(),
                            kind: kind_of(c.column_type()),
                            nullable: None,
                            source_table: None,
                            source_column: None,
                            source_schema: None,
                            source_updatable: None,
                        })
                        .collect();
                    money = meta
                        .columns()
                        .iter()
                        .map(|c| is_money(c.column_type()))
                        .collect();
                    if let Some(h) = head.take() {
                        if h.send(Head::Columns(columns)).is_err() {
                            break 'stream Ended::Abandoned;
                        }
                    }
                }
                Ok(Some(QueryItem::Row(row))) => {
                    if row.result_index() > 0 {
                        continue;
                    }
                    let values: Vec<Value> = row
                        .cells()
                        .enumerate()
                        .map(|(i, (_, data))| {
                            to_value(data, money.get(i).copied().unwrap_or(false))
                        })
                        .collect();
                    if tx.send(Msg::Row(values)).await.is_err() {
                        // The consumer abandoned the result.
                        break 'stream if drain(&mut stream).await {
                            Ended::Clean
                        } else {
                            Ended::Abandoned
                        };
                    }
                }
                Ok(None) => {
                    match head.take() {
                        Some(h) => {
                            let _ = h.send(Head::Done(counted));
                        }
                        None => {
                            let _ = tx.send(Msg::End).await;
                        }
                    }
                    break 'stream Ended::Clean;
                }
                Err(e) => {
                    let err = map_error(e, &target);
                    match head.take() {
                        Some(h) => {
                            let _ = h.send(Head::Err(err));
                        }
                        None => {
                            let _ = tx.send(Msg::Err(err)).await;
                        }
                    }
                    break 'stream Ended::Clean;
                }
            }
        }
    };

    match ended {
        Ended::Clean => {}
        // Cancelled: tell the server to stop, then report it.
        Ended::Interrupted => {
            stop_server_work(&mut client, &cancel).await;
            match head.take() {
                Some(h) => {
                    let _ = h.send(Head::Err(cancelled_error()));
                }
                None => {
                    let _ = tx.send(Msg::Err(cancelled_error())).await;
                }
            }
        }
        // The consumer went away mid-result: stop the server work too.
        Ended::Abandoned => {
            stop_server_work(&mut client, &cancel).await;
        }
    }
    client
}

impl MsSession {
    pub fn new(client: TdsClient, server: ServerInfo, target: String) -> Self {
        Self {
            conn: ConnState::Idle(Box::new(client)),
            cancel: Arc::new(TdsCancel {
                notify: Mutex::new(Arc::new(Notify::new())),
                running: Default::default(),
                cancelled: Default::default(),
                broken: Default::default(),
            }),
            server,
            next_result: 1,
            stream: None,
            target,
        }
    }

    fn lost(&self) -> DriverError {
        DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {} was lost", self.target),
        )
    }

    /// A fresh signal for this statement.
    fn begin_statement(&self) -> Arc<Notify> {
        use std::sync::atomic::Ordering::SeqCst;
        let notify = Arc::new(Notify::new());
        *self.cancel.notify.lock().unwrap() = notify.clone();
        self.cancel.cancelled.store(false, SeqCst);
        self.cancel.running.store(true, SeqCst);
        notify
    }

    fn end_statement(&self) {
        self.cancel
            .running
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    async fn reclaim(&mut self) {
        if let Some(OpenStream { rx, task, .. }) = self.stream.take() {
            drop(rx);
            let _ = self.cancel.cancel().await;
            self.finish(task).await;
        }
    }

    fn take_idle(&mut self) -> DriverResult<Box<TdsClient>> {
        match std::mem::replace(&mut self.conn, ConnState::Gone) {
            ConnState::Idle(c) => Ok(c),
            ConnState::Streaming => Err(DriverError::internal("A result is still streaming")),
            ConnState::Gone => Err(self.lost()),
        }
    }

    async fn finish(&mut self, task: JoinHandle<TdsClient>) {
        match task.await {
            Ok(client) if !self.cancel.broken.load(std::sync::atomic::Ordering::SeqCst) => {
                self.conn = ConnState::Idle(Box::new(client));
            }
            _ => self.conn = ConnState::Gone,
        }
        self.end_statement();
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
                self.finish(task).await;
            }
        }
        if let Some(e) = outcome.error {
            if e.code == ErrorCode::ConnectionLost {
                self.conn = ConnState::Gone;
            }
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
impl Session for MsSession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        self.reclaim().await;
        let client = self.take_idle()?;
        let notify = self.begin_statement();
        let (head_tx, head_rx) = oneshot::channel();
        let (tx, rx) = mpsc::channel(STREAM_BUFFER);
        let task: JoinHandle<TdsClient> = tokio::spawn(run_batch(
            *client,
            req.sql.clone(),
            self.target.clone(),
            notify,
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
                self.conn = ConnState::Streaming;
                self.stream = Some(OpenStream::new(result_id, rx, task));
                self.page(result_id, req.page_size.max(1), &sink, started)
                    .await
            }
            Ok(Head::Done(affected)) => {
                self.finish(task).await;
                let result_id = self.next_result;
                self.next_result += 1;
                let summary = ExecSummary {
                    rows_affected: Some(affected),
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
                self.finish(task).await;
                if e.code == ErrorCode::ConnectionLost {
                    self.conn = ConnState::Gone;
                }
                Err(e)
            }
            Err(_) => {
                self.finish(task).await;
                Err(self.lost())
            }
        }
    }

    async fn execute_params(&mut self, sql: &str, params: &[Value]) -> DriverResult<u64> {
        self.reclaim().await;
        let mut client = self.take_idle()?;
        self.begin_statement();
        if params.is_empty() {
            // Transaction control and the like must run in the session's own scope, which
            // sp_executesql (what `execute` uses) would not give it.
            let result = match client.simple_query(sql).await {
                Ok(stream) => stream.into_results().await.map(|_| ()),
                Err(e) => Err(e),
            };
            self.end_statement();
            return match result {
                Ok(()) => {
                    self.conn = ConnState::Idle(client);
                    Ok(0)
                }
                Err(e) => {
                    let err = map_error(e, &self.target);
                    if err.code != ErrorCode::ConnectionLost {
                        self.conn = ConnState::Idle(client);
                    }
                    Err(err)
                }
            };
        }
        let bound: Vec<Box<dyn tiberius::ToSql>> = params.iter().map(to_param).collect();
        let refs: Vec<&dyn tiberius::ToSql> = bound.iter().map(|b| b.as_ref()).collect();
        let result = client.execute(sql, &refs).await;
        self.end_statement();
        match result {
            Ok(done) => {
                self.conn = ConnState::Idle(client);
                Ok(done.total())
            }
            Err(e) => {
                let err = map_error(e, &self.target);
                if err.code != ErrorCode::ConnectionLost {
                    self.conn = ConnState::Idle(client);
                }
                Err(err)
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

    /// SQL Server has no session-level read-only mode; the guard alone enforces it, so there is
    /// nothing to change on the server.
    async fn set_read_only(&mut self, _read_only: bool) -> DriverResult<()> {
        Ok(())
    }

    fn cancel_handle(&self) -> CancelHandle {
        struct Handle(Arc<TdsCancel>);
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

    fn is_alive(&self) -> bool {
        !matches!(self.conn, ConnState::Gone)
    }

    async fn close(mut self: Box<Self>) -> DriverResult<()> {
        self.reclaim().await;
        if let ConnState::Idle(client) = std::mem::replace(&mut self.conn, ConnState::Gone) {
            let _ = client.close().await;
        }
        Ok(())
    }
}

/// A value the table editor writes, as tiberius binds it.
fn to_param(v: &Value) -> Box<dyn tiberius::ToSql> {
    match v {
        Value::Null => Box::new(None::<String>),
        Value::Bool { value } => Box::new(*value),
        Value::Int { value } => Box::new(*value),
        Value::Float { value } => Box::new(*value),
        Value::Bytes { value, .. } => Box::new(crate::drivers::value::unhex(value)),
        other => Box::new(other.sql_text()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_statements_report_a_count() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            " -- c\nupdate t set a = 1",
            "DELETE FROM t",
            "MERGE t USING s ON 1 = 1 WHEN MATCHED THEN DELETE;",
        ] {
            assert!(is_dml(sql), "{sql}");
        }
        for sql in [
            "SELECT 1",
            "CREATE TABLE t (a int)",
            "BEGIN TRANSACTION",
            "SET NOCOUNT ON",
            "USE shop",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "EXEC sp_who",
        ] {
            assert!(!is_dml(sql), "{sql}");
        }
    }
}
