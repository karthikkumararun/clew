//! A SQLite session: one dedicated connection.
//!
//! sqlx runs each SQLite connection on its own worker thread. Cancellation uses SQLite's progress
//! handler: it is invoked every 1000 VM instructions on that thread and aborts the statement
//! (SQLITE_INTERRUPT) once the session's interrupt flag is set. Paging uses the shared
//! [`paging`] module like the other drivers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use futures::StreamExt;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{
    AssertSqlSafe, Column, ConnectOptions, Connection, Executor, Row, SqlSafeStr, Statement,
    TypeInfo, ValueRef,
};
use tokio::task::JoinHandle;

use super::config::attach_sql;
use super::decode::{decode_by_class, kind_for_declared};
use super::error::{is_connection_error, map_error};
use crate::drivers::introspect::NodeKind;
use crate::drivers::paging::{self, Msg, STREAM_BUFFER};
use crate::drivers::value::unhex;
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, FullValueRequest, ResultEvent, ResultId, ResultSink, ServerInfo, Session, Value,
};

type OpenStream = paging::OpenStream<SqliteConnection>;

/// VM instructions between progress-handler calls.
const PROGRESS_INTERVAL: i32 = 1000;

enum ConnState {
    Idle(Box<SqliteConnection>),
    Streaming,
    Gone,
}

/// Sets the flag the progress handler polls. Only has an effect while a statement runs.
pub struct SqliteCancel {
    interrupt: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[async_trait]
impl CancelFn for SqliteCancel {
    async fn cancel(&self) -> DriverResult<()> {
        if self.running.load(Ordering::SeqCst) {
            self.interrupt.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

pub struct SqliteSession {
    conn: ConnState,
    cancel: Arc<SqliteCancel>,
    server: ServerInfo,
    next_result: ResultId,
    stream: Option<OpenStream>,
    path: String,
}

/// `INSERT`/`UPDATE`/`DELETE`/`REPLACE` report a meaningful `changes()`; everything else would
/// report the previous statement's count.
fn is_dml(sql: &str) -> bool {
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
    let word: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    matches!(word.as_str(), "INSERT" | "UPDATE" | "DELETE" | "REPLACE")
}

fn decode_row(row: &SqliteRow) -> Vec<Value> {
    (0..row.len())
        .map(|i| {
            let Ok(raw) = row.try_get_raw(i) else {
                return Value::Null;
            };
            // a NULL reports its column's declared type, so ask for NULL explicitly
            if raw.is_null() {
                return Value::Null;
            }
            let class = raw.type_info().name().to_string();
            let declared = row.column(i).type_info().name().to_string();
            decode_cell(row, i, &class, &declared, true)
        })
        .collect()
}

fn decode_cell(row: &SqliteRow, i: usize, class: &str, declared: &str, truncate: bool) -> Value {
    match class {
        "NULL" => Value::Null,
        "INTEGER" | "INT4" | "INT8" | "BOOLEAN" => {
            let v = row.try_get_unchecked::<i64, _>(i).ok();
            decode_by_class(class, v, None, None, declared, truncate)
        }
        "REAL" => {
            let v = row.try_get_unchecked::<f64, _>(i).ok();
            decode_by_class(class, None, v, None, declared, truncate)
        }
        _ => {
            let bytes = row.try_get_unchecked::<Vec<u8>, _>(i).ok();
            decode_by_class(class, None, None, bytes.as_deref(), declared, truncate)
        }
    }
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl SqliteSession {
    pub async fn connect(
        opts: SqliteConnectOptions,
        attachments: &[(String, String)],
        server: ServerInfo,
        path: String,
    ) -> DriverResult<Self> {
        let mut conn = opts
            .connect()
            .await
            .map_err(|e| map_error(e, &path, None))?;
        for (name, file) in attachments {
            conn.execute(AssertSqlSafe(attach_sql(name, file)).into_sql_str())
                .await
                .map_err(|e| map_error(e, &path, None))?;
        }
        let interrupt = Arc::new(AtomicBool::new(false));
        let flag = interrupt.clone();
        {
            let mut handle = conn
                .lock_handle()
                .await
                .map_err(|e| map_error(e, &path, None))?;
            // returning false interrupts the running statement
            handle.set_progress_handler(PROGRESS_INTERVAL, move || !flag.load(Ordering::Relaxed));
        }
        Ok(Self {
            conn: ConnState::Idle(Box::new(conn)),
            cancel: Arc::new(SqliteCancel {
                interrupt,
                running: Arc::new(AtomicBool::new(false)),
            }),
            server,
            next_result: 1,
            stream: None,
            path,
        })
    }

    fn lost(&self) -> DriverError {
        DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {} was lost", self.path),
        )
    }

    fn begin_statement(&self) {
        self.cancel.interrupt.store(false, Ordering::SeqCst);
        self.cancel.running.store(true, Ordering::SeqCst);
    }

    fn end_statement(&self) {
        self.cancel.running.store(false, Ordering::SeqCst);
    }

    async fn reclaim(&mut self) -> DriverResult<()> {
        if let Some(OpenStream { rx, task, .. }) = self.stream.take() {
            drop(rx);
            // interrupt the rest of the result, then wait for the task to hand the connection back
            let _ = self.cancel.cancel().await;
            match task.await {
                Ok(conn) => self.conn = ConnState::Idle(Box::new(conn)),
                Err(_) => self.conn = ConnState::Gone,
            }
            self.end_statement();
        }
        Ok(())
    }

    fn take_idle(&mut self) -> DriverResult<Box<SqliteConnection>> {
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
impl Session for SqliteSession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let sql = req.sql;
        self.begin_statement();

        let columns: Vec<(String, String, Option<(String, String)>)> = match conn
            .prepare(AssertSqlSafe(sql.clone()).into_sql_str())
            .await
        {
            Ok(p) => p
                .columns()
                .iter()
                .map(|c| {
                    let origin = c
                        .origin()
                        .table_column()
                        .map(|t| (t.table.to_string(), t.name.to_string()));
                    (
                        c.name().to_string(),
                        c.type_info().name().to_string(),
                        origin,
                    )
                })
                .collect(),
            Err(e) => {
                self.end_statement();
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                return Err(map_error(e, &self.path, Some(&sql)));
            }
        };

        if columns.is_empty() {
            let result = sqlx::query(AssertSqlSafe(sql.clone()))
                .persistent(false)
                .execute(&mut *conn)
                .await;
            self.end_statement();
            return match result {
                Ok(done) => {
                    self.conn = ConnState::Idle(conn);
                    let summary = ExecSummary {
                        rows_affected: Some(if is_dml(&sql) {
                            done.rows_affected()
                        } else {
                            0
                        }),
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        has_more: false,
                    };
                    let id = self.next_result;
                    self.next_result += 1;
                    sink.send(ResultEvent::Done {
                        result_id: id,
                        summary: summary.clone(),
                    })
                    .await;
                    Ok(summary)
                }
                Err(e) => {
                    if !is_connection_error(&e) {
                        self.conn = ConnState::Idle(conn);
                    }
                    Err(map_error(e, &self.path, Some(&sql)))
                }
            };
        }

        let metas: Vec<ColumnMeta> = columns
            .iter()
            .map(|(name, declared, origin)| ColumnMeta {
                name: name.clone(),
                type_name: declared.clone(),
                kind: kind_for_declared(declared),
                nullable: None,
                source_table: origin.as_ref().map(|(t, _)| t.clone()),
                source_column: origin.as_ref().map(|(_, c)| c.clone()),
            })
            .collect();
        let result_id = self.next_result;
        self.next_result += 1;
        sink.send(ResultEvent::Columns {
            result_id,
            statement: 0,
            columns: metas,
        })
        .await;

        let (tx, rx) = tokio::sync::mpsc::channel(STREAM_BUFFER);
        let mut owned = *conn;
        let path = self.path.clone();
        let sql_for_errors = sql.clone();
        let task: JoinHandle<SqliteConnection> = tokio::spawn(async move {
            {
                let mut rows = sqlx::query(AssertSqlSafe(sql))
                    .persistent(false)
                    .fetch(&mut owned);
                let mut failed = false;
                while let Some(item) = rows.next().await {
                    match item {
                        Ok(row) => {
                            if tx.send(Msg::Row(decode_row(&row))).await.is_err() {
                                failed = true; // consumer abandoned the result
                                break;
                            }
                        }
                        Err(e) => {
                            let err = map_error(e, &path, Some(&sql_for_errors));
                            let _ = tx.send(Msg::Err(err)).await;
                            failed = true;
                            break;
                        }
                    }
                }
                if !failed {
                    let _ = tx.send(Msg::End).await;
                }
            }
            owned
        });
        self.conn = ConnState::Streaming;
        self.stream = Some(OpenStream::new(result_id, rx, task));
        self.page(result_id, req.page_size.max(1), &sink, started)
            .await
    }

    async fn execute_params(&mut self, sql: &str, params: &[Value]) -> DriverResult<u64> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        self.begin_statement();
        let mut query = sqlx::query(AssertSqlSafe(sql.to_string())).persistent(false);
        for p in params {
            query = match p {
                Value::Null => query.bind(None::<String>),
                Value::Int { value } => query.bind(*value),
                Value::Bool { value } => query.bind(*value),
                Value::Float { value } => query.bind(*value),
                Value::Bytes { value, .. } => query.bind(unhex(value)),
                other => query.bind(other.sql_text()),
            };
        }
        let result = query.execute(&mut *conn).await;
        self.end_statement();
        match result {
            Ok(done) => {
                self.conn = ConnState::Idle(conn);
                Ok(done.rows_affected())
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.path, Some(sql)))
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
        struct Handle(Arc<SqliteCancel>);
        #[async_trait]
        impl CancelFn for Handle {
            async fn cancel(&self) -> DriverResult<()> {
                self.0.cancel().await
            }
        }
        CancelHandle::new(Handle(self.cancel.clone()))
    }

    async fn fetch_full_value(&mut self, req: FullValueRequest) -> DriverResult<Value> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        self.begin_statement();
        let result = fetch_full(&mut conn, &req, &self.path).await;
        self.end_statement();
        if !matches!(&result, Err(e) if e.code == ErrorCode::ConnectionLost) {
            self.conn = ConnState::Idle(conn);
        }
        result
    }

    fn server_info(&self) -> ServerInfo {
        self.server.clone()
    }

    async fn close(mut self: Box<Self>) -> DriverResult<()> {
        let _ = self.reclaim().await;
        if let ConnState::Idle(conn) = std::mem::replace(&mut self.conn, ConnState::Gone) {
            let _ = conn.close().await;
        }
        Ok(())
    }
}

async fn fetch_full(
    conn: &mut SqliteConnection,
    req: &FullValueRequest,
    path: &str,
) -> DriverResult<Value> {
    let database = req.table.find(NodeKind::Database).unwrap_or("main");
    let table = req
        .table
        .0
        .iter()
        .rev()
        .find(|s| matches!(s.kind, NodeKind::Table | NodeKind::View))
        .map(|s| s.name.as_str())
        .ok_or_else(|| DriverError::internal("The path does not name a table"))?;

    let mut conditions = Vec::new();
    let mut binds: Vec<Value> = Vec::new();
    for (col, value) in &req.key {
        if value.is_null() {
            conditions.push(format!("{} IS NULL", quote_ident(col)));
        } else {
            conditions.push(format!("{} = ?", quote_ident(col)));
            binds.push(value.clone());
        }
    }
    if conditions.is_empty() {
        return Err(DriverError::internal("A key is needed to find the row"));
    }
    let sql = format!(
        "SELECT {} FROM {}.{} WHERE {} LIMIT 1",
        quote_ident(&req.column),
        quote_ident(database),
        quote_ident(table),
        conditions.join(" AND ")
    );
    let mut query = sqlx::query(AssertSqlSafe(sql.clone())).persistent(false);
    for b in binds {
        query = match b {
            Value::Int { value } => query.bind(value),
            Value::Bool { value } => query.bind(value),
            Value::Float { value } => query.bind(value),
            Value::Bytes { value, .. } => query.bind(unhex(&value)),
            other => query.bind(other.sql_text().unwrap_or_default()),
        };
    }
    let row = query
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| map_error(e, path, Some(&sql)))?
        .ok_or_else(|| DriverError::new(ErrorCode::QueryFailed, "The row no longer exists"))?;
    let raw = row.try_get_raw(0).map_err(|e| map_error(e, path, None))?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let class = raw.type_info().name().to_string();
    let declared = row.column(0).type_info().name().to_string();
    Ok(decode_cell(&row, 0, &class, &declared, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_dml_reports_changes() {
        assert!(is_dml("INSERT INTO t VALUES (1)"));
        assert!(is_dml("  update t set a = 1"));
        assert!(is_dml("-- note\nDELETE FROM t"));
        assert!(is_dml("/* x */ replace into t values (1)"));
        assert!(!is_dml("CREATE TABLE t (a)"));
        assert!(!is_dml("BEGIN"));
        assert!(!is_dml("PRAGMA foreign_keys = ON"));
        assert!(!is_dml(""));
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(unhex("dead00"), [0xde, 0xad, 0x00]);
        assert_eq!(unhex(""), Vec::<u8>::new());
    }

    #[test]
    fn identifiers_are_quoted() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }
}
