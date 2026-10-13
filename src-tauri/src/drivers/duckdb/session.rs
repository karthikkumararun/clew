//! A DuckDB session: one connection of the shared database, driven from blocking threads.
//!
//! DuckDB's API is synchronous, so a statement runs inside `spawn_blocking`, which owns the
//! connection and pushes rows through the shared [`paging`] channel; the session keeps the
//! receiver, like the SQLite session does. Cancel calls DuckDB's `interrupt`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use duckdb::arrow::datatypes::DataType;
use duckdb::core::LogicalTypeId as Id;
use duckdb::types::Value as D;
use duckdb::{Connection, InterruptHandle};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::error::map_error;
use super::types::{kind_of, to_param, to_value, type_name};
use super::Shared;
use crate::drivers::paging::{self, Msg, STREAM_BUFFER};
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, FullValueRequest, ResultEvent, ResultId, ResultSink, ServerInfo, Session, Value,
};

type OpenStream = paging::OpenStream<Connection>;

enum ConnState {
    Idle(Box<Connection>),
    Streaming,
    Gone,
}

pub struct DuckCancel {
    interrupt: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[async_trait]
impl CancelFn for DuckCancel {
    async fn cancel(&self) -> DriverResult<()> {
        if self.running.load(Ordering::SeqCst) {
            self.cancelled.store(true, Ordering::SeqCst);
            self.interrupt.interrupt();
        }
        Ok(())
    }
}

pub struct DuckSession {
    conn: ConnState,
    cancel: Arc<DuckCancel>,
    server: ServerInfo,
    next_result: ResultId,
    stream: Option<OpenStream>,
    path: String,
    /// Keeps the database open for as long as the session lives.
    _shared: Arc<Shared>,
}

/// What the blocking side learns first about a statement.
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

/// Statements whose result set the user wants to see. DuckDB answers every other statement with
/// a one-row `Count` or `Success` result that is not data.
pub fn returns_rows(sql: &str) -> bool {
    matches!(
        first_word(sql).as_str(),
        "SELECT"
            | "WITH"
            | "VALUES"
            | "SHOW"
            | "DESCRIBE"
            | "DESC"
            | "EXPLAIN"
            | "PRAGMA"
            | "FROM"
            | "PIVOT"
            | "UNPIVOT"
            | "SUMMARIZE"
            | "TABLE"
            | "CALL"
            | "EXECUTE"
    )
}

fn counts_rows(sql: &str) -> bool {
    matches!(
        first_word(sql).as_str(),
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "COPY"
    )
}

fn decimal_of(t: &DataType) -> Option<(u8, u8)> {
    match t {
        DataType::Decimal128(p, s) => Some((*p, (*s).max(0) as u8)),
        _ => None,
    }
}

/// Runs on a blocking thread. Reports the head of the result, then streams rows.
fn run_statement(
    conn: Connection,
    sql: String,
    path: String,
    cancelled: Arc<AtomicBool>,
    head: oneshot::Sender<Head>,
    tx: mpsc::Sender<Msg>,
) -> Connection {
    stream_into(&conn, &sql, &path, &cancelled, head, &tx);
    conn
}

fn fail(e: duckdb::Error, sql: &str, path: &str, cancelled: &AtomicBool) -> DriverError {
    if cancelled.load(Ordering::SeqCst) {
        return DriverError::new(ErrorCode::Cancelled, "The statement was cancelled");
    }
    map_error(e, path, Some(sql))
}

fn stream_into(
    conn: &Connection,
    sql: &str,
    path: &str,
    cancelled: &AtomicBool,
    head: oneshot::Sender<Head>,
    tx: &mpsc::Sender<Msg>,
) {
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            let _ = head.send(Head::Err(fail(e, sql, path, cancelled)));
            return;
        }
    };
    let mut rows = match stmt.query([]) {
        Ok(r) => r,
        Err(e) => {
            let _ = head.send(Head::Err(fail(e, sql, path, cancelled)));
            return;
        }
    };

    if !returns_rows(sql) {
        let dml = counts_rows(sql);
        let mut affected = 0u64;
        loop {
            match rows.next() {
                Ok(Some(row)) => {
                    if dml {
                        if let Ok(n) = row.get::<_, i64>(0) {
                            affected = n.max(0) as u64;
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = head.send(Head::Err(fail(e, sql, path, cancelled)));
                    return;
                }
            }
        }
        let _ = head.send(Head::Done(affected));
        return;
    }

    let (metas, ids) = {
        let s = rows.as_ref().expect("statement");
        let n = s.column_count();
        let names = s.column_names();
        let mut metas = Vec::with_capacity(n);
        let mut ids = Vec::with_capacity(n);
        for (i, name) in names.into_iter().enumerate().take(n) {
            let id = s.column_logical_type(i).id();
            metas.push(ColumnMeta {
                name,
                type_name: type_name(id, decimal_of(&s.column_type(i))),
                kind: kind_of(id),
                nullable: None,
                source_table: None,
                source_column: None,
                source_schema: None,
                source_updatable: None,
            });
            ids.push(id);
        }
        (metas, ids)
    };
    if head.send(Head::Columns(metas)).is_err() {
        return;
    }
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                let values: Vec<Value> = ids
                    .iter()
                    .enumerate()
                    .map(|(i, id)| match row.get::<_, D>(i) {
                        Ok(v) => to_value(v, Some(*id)),
                        Err(e) => Value::other(e.to_string(), "unreadable"),
                    })
                    .collect();
                if tx.blocking_send(Msg::Row(values)).is_err() {
                    return; // the consumer abandoned the result
                }
            }
            Ok(None) => {
                let _ = tx.blocking_send(Msg::End);
                return;
            }
            Err(e) => {
                let _ = tx.blocking_send(Msg::Err(fail(e, sql, path, cancelled)));
                return;
            }
        }
    }
}

impl DuckSession {
    pub fn new(shared: Arc<Shared>, conn: Connection, server: ServerInfo, path: String) -> Self {
        let cancel = Arc::new(DuckCancel {
            interrupt: conn.interrupt_handle(),
            cancelled: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
        });
        Self {
            conn: ConnState::Idle(Box::new(conn)),
            cancel,
            server,
            next_result: 1,
            stream: None,
            path,
            _shared: shared,
        }
    }

    fn lost(&self) -> DriverError {
        DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {} was lost", self.path),
        )
    }

    fn begin_statement(&self) {
        self.cancel.cancelled.store(false, Ordering::SeqCst);
        self.cancel.running.store(true, Ordering::SeqCst);
    }

    fn end_statement(&self) {
        self.cancel.running.store(false, Ordering::SeqCst);
    }

    async fn reclaim(&mut self) -> DriverResult<()> {
        if let Some(OpenStream { rx, task, .. }) = self.stream.take() {
            drop(rx);
            let _ = self.cancel.cancel().await;
            match task.await {
                Ok(conn) => self.conn = ConnState::Idle(Box::new(conn)),
                Err(_) => self.conn = ConnState::Gone,
            }
            self.end_statement();
        }
        Ok(())
    }

    fn take_idle(&mut self) -> DriverResult<Box<Connection>> {
        match std::mem::replace(&mut self.conn, ConnState::Gone) {
            ConnState::Idle(c) => Ok(c),
            ConnState::Streaming => Err(DriverError::internal("A result is still streaming")),
            ConnState::Gone => Err(self.lost()),
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
                match task.await {
                    Ok(conn) => self.conn = ConnState::Idle(Box::new(conn)),
                    Err(_) => self.conn = ConnState::Gone,
                }
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
impl Session for DuckSession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        self.reclaim().await?;
        let conn = self.take_idle()?;
        self.begin_statement();

        let (head_tx, head_rx) = oneshot::channel();
        let (tx, rx) = mpsc::channel(STREAM_BUFFER);
        let (path, sql, cancelled) = (
            self.path.clone(),
            req.sql.clone(),
            self.cancel.cancelled.clone(),
        );
        let task: JoinHandle<Connection> = tokio::task::spawn_blocking(move || {
            run_statement(*conn, sql, path, cancelled, head_tx, tx)
        });

        let head = head_rx.await;
        match head {
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
                Err(e)
            }
            Err(_) => {
                self.finish(task).await;
                Err(self.lost())
            }
        }
    }

    async fn execute_params(&mut self, sql: &str, params: &[Value]) -> DriverResult<u64> {
        self.reclaim().await?;
        let conn = self.take_idle()?;
        self.begin_statement();
        let (sql_owned, path) = (sql.to_string(), self.path.clone());
        let bound: Vec<D> = params.iter().map(to_param).collect();
        let cancelled = self.cancel.cancelled.clone();
        let task: JoinHandle<(Connection, Result<usize, DriverError>)> =
            tokio::task::spawn_blocking(move || {
                let result = conn
                    .prepare(&sql_owned)
                    .and_then(|mut s| s.execute(duckdb::params_from_iter(bound.iter())))
                    .map_err(|e| fail(e, &sql_owned, &path, &cancelled));
                (*conn, result)
            });
        let joined = task.await;
        self.end_statement();
        match joined {
            Ok((conn, result)) => {
                self.conn = ConnState::Idle(Box::new(conn));
                result.map(|n| n as u64)
            }
            Err(_) => {
                self.conn = ConnState::Gone;
                Err(self.lost())
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

    fn cancel_handle(&self) -> CancelHandle {
        struct Handle(Arc<DuckCancel>);
        #[async_trait]
        impl CancelFn for Handle {
            async fn cancel(&self) -> DriverResult<()> {
                self.0.cancel().await
            }
        }
        CancelHandle::new(Handle(self.cancel.clone()))
    }

    async fn fetch_full_value(&mut self, _req: FullValueRequest) -> DriverResult<Value> {
        Err(DriverError::unsupported("fetching full values"))
    }

    async fn set_read_only(&mut self, _read_only: bool) -> DriverResult<()> {
        Err(DriverError::unsupported(
            "Switching a DuckDB connection between read-only and read-write (reconnect instead)",
        ))
    }

    fn server_info(&self) -> ServerInfo {
        self.server.clone()
    }

    async fn close(mut self: Box<Self>) -> DriverResult<()> {
        let _ = self.reclaim().await;
        Ok(())
    }
}

impl DuckSession {
    async fn finish(&mut self, task: JoinHandle<Connection>) {
        match task.await {
            Ok(conn) => self.conn = ConnState::Idle(Box::new(conn)),
            Err(_) => self.conn = ConnState::Gone,
        }
        self.end_statement();
    }
}

#[allow(dead_code)]
fn _ids_are_used(_: Id) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_statements_show_rows() {
        for sql in [
            "SELECT 1",
            "  -- c\nselect 1",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "FROM t",
            "(SELECT 1)",
            "DESCRIBE t",
            "PRAGMA table_info('t')",
            "EXPLAIN SELECT 1",
            "SUMMARIZE t",
            "VALUES (1)",
        ] {
            assert!(returns_rows(sql), "{sql}");
        }
        for sql in [
            "INSERT INTO t VALUES (1)",
            "CREATE TABLE t (a int)",
            "BEGIN",
            "SET threads = 1",
            "COPY t TO 'x.csv'",
            "ATTACH 'x.db'",
        ] {
            assert!(!returns_rows(sql), "{sql}");
        }
        assert!(counts_rows("update t set a = 1") && counts_rows("COPY t FROM 'x.csv'"));
        assert!(!counts_rows("CREATE TABLE t (a int)"));
    }
}
