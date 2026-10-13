//! An Oracle session: one connection driven from blocking threads (ODPI-C is synchronous).
//!
//! Statements run in `spawn_blocking`; rows reach the session through the shared [`paging`]
//! channel. The connection is shared (`Arc`) so cancelling can call `break_execution` from any
//! thread while a statement runs. Statements are committed as they finish unless the user is in
//! a manual transaction, like the other drivers (the connection handle is shared, so ODPI-C's
//! own autocommit switch, which needs `&mut`, isn't used); DBMS_OUTPUT is switched on and drained after every
//! statement into notices (the Output tab).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use oracle::sql_type::{OracleType, ToSql};
use oracle::Connection;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::error::map_error;
use super::types::{kind_of, to_value};
use crate::drivers::paging::{self, Msg, STREAM_BUFFER};
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, ResultEvent, ResultId, ResultSink, ServerInfo, Session, Value,
};

type OpenStream = paging::OpenStream<()>;

pub struct OraCancel {
    conn: Arc<Connection>,
    running: AtomicBool,
    cancelled: AtomicBool,
}

#[async_trait]
impl CancelFn for OraCancel {
    async fn cancel(&self) -> DriverResult<()> {
        if self.running.load(Ordering::SeqCst) {
            self.cancelled.store(true, Ordering::SeqCst);
            let conn = self.conn.clone();
            let _ = tokio::task::spawn_blocking(move || conn.break_execution()).await;
        }
        Ok(())
    }
}

pub struct OraSession {
    conn: Arc<Connection>,
    cancel: Arc<OraCancel>,
    server: ServerInfo,
    next_result: ResultId,
    stream: Option<OpenStream>,
    target: String,
    read_only: bool,
    /// A manual transaction is open: statements are not committed until COMMIT.
    manual: Arc<AtomicBool>,
    /// DBMS_OUTPUT lines waiting to be sent as notices.
    notices: Arc<Mutex<Vec<String>>>,
    alive: bool,
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

/// A PL/SQL block or stored-program definition keeps its trailing `;`; plain SQL must lose it.
pub fn is_plsql(sql: &str) -> bool {
    let (a, b) = first_words(sql);
    if a == "BEGIN" || a == "DECLARE" || a == "CALL" {
        return true;
    }
    if a != "CREATE" {
        return false;
    }
    let rest = sql.to_ascii_uppercase();
    ["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"]
        .iter()
        .any(|k| rest.contains(&format!(" {k} ")) || b == *k)
}

fn clean_sql(sql: &str) -> String {
    let t = sql.trim();
    if is_plsql(t) {
        t.to_string()
    } else {
        t.trim_end_matches(';').trim_end().to_string()
    }
}

/// Transaction words the session handles itself: ODPI-C has no BEGIN statement, a manual
/// transaction is simply autocommit being off.
#[derive(Debug, PartialEq, Eq)]
enum Control {
    Begin,
    Commit,
    Rollback,
}

fn control_of(sql: &str) -> Option<Control> {
    let t = sql.trim().trim_end_matches(';').trim();
    let (a, b) = first_words(t);
    match (a.as_str(), b.as_str()) {
        ("BEGIN", "TRANSACTION" | "TRAN") if t.split_whitespace().count() == 2 => {
            Some(Control::Begin)
        }
        ("COMMIT", _) if t.split_whitespace().count() <= 2 => Some(Control::Commit),
        ("ROLLBACK", "") => Some(Control::Rollback),
        ("ROLLBACK", "WORK") => Some(Control::Rollback),
        _ => None,
    }
}

fn drain_output(conn: &Connection, into: &Mutex<Vec<String>>) {
    for _ in 0..10_000 {
        let Ok(mut stmt) = conn
            .statement("BEGIN DBMS_OUTPUT.GET_LINE(:1, :2); END;")
            .build()
        else {
            return;
        };
        if stmt
            .execute(&[&OracleType::Varchar2(32767), &OracleType::Number(0, 0)])
            .is_err()
        {
            return;
        }
        let status: i64 = stmt.bind_value(2).unwrap_or(1);
        if status != 0 {
            return;
        }
        let line: Option<String> = stmt.bind_value(1).unwrap_or(None);
        into.lock().unwrap().push(line.unwrap_or_default());
    }
}

#[allow(clippy::too_many_arguments)]
fn run_statement(
    conn: Arc<Connection>,
    sql: String,
    read_only: bool,
    manual: Arc<AtomicBool>,
    cancel: Arc<OraCancel>,
    target: String,
    notices: Arc<Mutex<Vec<String>>>,
    head: oneshot::Sender<Head>,
    tx: mpsc::Sender<Msg>,
) {
    let fail = |e: oracle::Error, sql: &str| {
        if cancel.cancelled.load(Ordering::SeqCst) || e.oci_code() == Some(1013) {
            DriverError::new(ErrorCode::Cancelled, "The statement was cancelled")
        } else {
            map_error(e, &target, Some(sql))
        }
    };
    // Oracle has no session-wide read-only mode: each statement of a read-only session runs in
    // a read-only transaction (the previous one is closed first; it only ever read).
    if read_only {
        let _ = conn.commit();
        let _ = conn.execute("SET TRANSACTION READ ONLY", &[]);
    }
    let text = clean_sql(&sql);
    let mut stmt = match conn.statement(&text).fetch_array_size(200).build() {
        Ok(s) => s,
        Err(e) => {
            let _ = head.send(Head::Err(fail(e, &text)));
            return;
        }
    };
    if !stmt.is_query() {
        let result = stmt.execute(&[]).and_then(|()| {
            if manual.load(Ordering::SeqCst) {
                Ok(())
            } else {
                conn.commit()
            }
        });
        drain_output(&conn, &notices);
        let reply = match result {
            Ok(()) => Head::Done(stmt.row_count().unwrap_or(0)),
            Err(e) => Head::Err(fail(e, &text)),
        };
        let _ = head.send(reply);
        return;
    }
    let rows = match stmt.query(&[]) {
        Ok(r) => r,
        Err(e) => {
            let _ = head.send(Head::Err(fail(e, &text)));
            return;
        }
    };
    let info: Vec<(String, OracleType)> = rows
        .column_info()
        .iter()
        .map(|c| (c.name().to_string(), c.oracle_type().clone()))
        .collect();
    let metas = info
        .iter()
        .map(|(name, t)| ColumnMeta {
            name: name.clone(),
            type_name: t.to_string(),
            kind: kind_of(t),
            nullable: None,
            source_table: None,
            source_column: None,
            source_schema: None,
            source_updatable: None,
        })
        .collect();
    if head.send(Head::Columns(metas)).is_err() {
        return;
    }
    for row in rows {
        match row {
            Ok(row) => {
                let values: Vec<Value> = row
                    .sql_values()
                    .iter()
                    .zip(&info)
                    .map(|(v, (_, t))| to_value(v, t))
                    .collect();
                if tx.blocking_send(Msg::Row(values)).is_err() {
                    break; // the consumer abandoned the result
                }
            }
            Err(e) => {
                let _ = tx.blocking_send(Msg::Err(fail(e, &text)));
                return;
            }
        }
    }
    drain_output(&conn, &notices);
    let _ = tx.blocking_send(Msg::End);
}

impl OraSession {
    pub fn new(conn: Connection, server: ServerInfo, target: String, read_only: bool) -> Self {
        let conn = Arc::new(conn);
        Self {
            cancel: Arc::new(OraCancel {
                conn: conn.clone(),
                running: AtomicBool::new(false),
                cancelled: AtomicBool::new(false),
            }),
            conn,
            server,
            next_result: 1,
            stream: None,
            target,
            read_only,
            manual: Arc::default(),
            notices: Arc::default(),
            alive: true,
        }
    }

    fn begin_statement(&self) {
        self.cancel.cancelled.store(false, Ordering::SeqCst);
        self.cancel.running.store(true, Ordering::SeqCst);
    }

    fn end_statement(&self) {
        self.cancel.running.store(false, Ordering::SeqCst);
    }

    async fn reclaim(&mut self) {
        if let Some(OpenStream { rx, task, .. }) = self.stream.take() {
            drop(rx);
            let _ = self.cancel.cancel().await;
            let _ = task.await;
            self.end_statement();
        }
    }

    async fn flush_notices(&self, sink: &ResultSink) {
        let lines: Vec<String> = std::mem::take(&mut *self.notices.lock().unwrap());
        for message in lines {
            sink.send(ResultEvent::Notice { message }).await;
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
            self.flush_notices(sink).await;
        }
        if let Some(e) = outcome.error {
            if e.code == ErrorCode::ConnectionLost {
                self.alive = false;
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

    async fn control(
        &mut self,
        c: Control,
        sink: &ResultSink,
        started: Instant,
    ) -> DriverResult<ExecSummary> {
        let conn = self.conn.clone();
        let target = self.target.clone();
        let manual = self.manual.clone();
        tokio::task::spawn_blocking(move || -> DriverResult<()> {
            let r = match c {
                Control::Begin => {
                    manual.store(true, Ordering::SeqCst);
                    Ok(())
                }
                Control::Commit => {
                    manual.store(false, Ordering::SeqCst);
                    conn.commit()
                }
                Control::Rollback => {
                    manual.store(false, Ordering::SeqCst);
                    conn.rollback()
                }
            };
            r.map_err(|e| map_error(e, &target, None))
        })
        .await
        .map_err(|_| DriverError::internal("The statement was interrupted"))??;
        let result_id = self.next_result;
        self.next_result += 1;
        let summary = ExecSummary {
            rows_affected: Some(0),
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
}

#[async_trait]
impl Session for OraSession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        self.reclaim().await;
        if let Some(c) = control_of(&req.sql) {
            return self.control(c, &sink, started).await;
        }
        self.begin_statement();
        let (head_tx, head_rx) = oneshot::channel();
        let (tx, rx) = mpsc::channel(STREAM_BUFFER);
        let task: JoinHandle<()> = {
            let (conn, cancel, notices) =
                (self.conn.clone(), self.cancel.clone(), self.notices.clone());
            let (sql, target, read_only) = (req.sql.clone(), self.target.clone(), self.read_only);
            let manual = self.manual.clone();
            tokio::task::spawn_blocking(move || {
                run_statement(
                    conn, sql, read_only, manual, cancel, target, notices, head_tx, tx,
                )
            })
        };
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
                self.flush_notices(&sink).await;
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
                let _ = task.await;
                self.end_statement();
                self.flush_notices(&sink).await;
                if e.code == ErrorCode::ConnectionLost {
                    self.alive = false;
                }
                Err(e)
            }
            Err(_) => {
                let _ = task.await;
                self.end_statement();
                self.alive = false;
                Err(DriverError::new(
                    ErrorCode::ConnectionLost,
                    format!("The connection to {} was lost", self.target),
                ))
            }
        }
    }

    async fn execute_params(&mut self, sql: &str, params: &[Value]) -> DriverResult<u64> {
        self.reclaim().await;
        if params.is_empty() {
            if let Some(c) = control_of(sql) {
                let (sink, _rx) = ResultSink::channel(4);
                return self.control(c, &sink, Instant::now()).await.map(|_| 0);
            }
        }
        self.begin_statement();
        let (conn, target) = (self.conn.clone(), self.target.clone());
        let (sql_owned, bound) = (clean_sql(sql), params.to_vec());
        let manual = self.manual.clone();
        let result = tokio::task::spawn_blocking(move || -> DriverResult<u64> {
            let boxed: Vec<Box<dyn ToSql>> = bound.iter().map(to_param).collect();
            let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
            let stmt = conn
                .execute(&sql_owned, &refs)
                .map_err(|e| map_error(e, &target, Some(&sql_owned)))?;
            if !manual.load(Ordering::SeqCst) {
                conn.commit()
                    .map_err(|e| map_error(e, &target, Some(&sql_owned)))?;
            }
            stmt.row_count()
                .map_err(|e| map_error(e, &target, Some(&sql_owned)))
        })
        .await;
        self.end_statement();
        match result {
            Ok(r) => r,
            Err(_) => Err(DriverError::internal("The statement was interrupted")),
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

    /// There is no session-wide switch; a read-only session simply opens each statement's
    /// transaction with `SET TRANSACTION READ ONLY`.
    async fn set_read_only(&mut self, read_only: bool) -> DriverResult<()> {
        self.read_only = read_only;
        if !read_only {
            // The last statement left its read-only transaction open; end it so writes can start.
            let (conn, target) = (self.conn.clone(), self.target.clone());
            tokio::task::spawn_blocking(move || {
                conn.commit().map_err(|e| map_error(e, &target, None))
            })
            .await
            .map_err(|_| DriverError::internal("The switch was interrupted"))??;
        }
        Ok(())
    }

    fn cancel_handle(&self) -> CancelHandle {
        struct Handle(Arc<OraCancel>);
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
        self.alive
    }

    async fn close(mut self: Box<Self>) -> DriverResult<()> {
        self.reclaim().await;
        let conn = self.conn.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = conn.rollback();
            conn.close()
        })
        .await;
        Ok(())
    }
}

fn to_param(v: &Value) -> Box<dyn ToSql> {
    match v {
        Value::Null => Box::new(None::<String>),
        Value::Bool { value } => Box::new(i32::from(*value)),
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
    fn plsql_keeps_its_semicolon_and_sql_loses_it() {
        assert_eq!(clean_sql("SELECT 1 FROM dual;"), "SELECT 1 FROM dual");
        assert_eq!(clean_sql("BEGIN NULL; END;"), "BEGIN NULL; END;");
        assert_eq!(
            clean_sql("  DECLARE x NUMBER; BEGIN x := 1; END; "),
            "DECLARE x NUMBER; BEGIN x := 1; END;"
        );
        assert_eq!(
            clean_sql("CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"),
            "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"
        );
        assert_eq!(
            clean_sql("CREATE TABLE t (a NUMBER);"),
            "CREATE TABLE t (a NUMBER)"
        );
        assert!(is_plsql("CREATE PACKAGE BODY p AS END;"));
        assert!(!is_plsql("CREATE INDEX i ON t (a)"));
    }

    #[test]
    fn transaction_words_are_recognised_but_blocks_are_not() {
        assert_eq!(control_of("BEGIN TRANSACTION"), Some(Control::Begin));
        assert_eq!(control_of("begin transaction;"), Some(Control::Begin));
        assert_eq!(control_of("COMMIT"), Some(Control::Commit));
        assert_eq!(control_of("commit work;"), Some(Control::Commit));
        assert_eq!(control_of("ROLLBACK"), Some(Control::Rollback));
        assert_eq!(control_of("ROLLBACK TO SAVEPOINT x"), None);
        assert_eq!(control_of("BEGIN NULL; END;"), None);
        assert_eq!(control_of("COMMIT COMMENT 'x' WRITE IMMEDIATE"), None);
    }
}
