//! A MySQL / MariaDB session: one dedicated physical connection.
//!
//! Results are read over the text protocol (`raw_sql`) so values arrive exactly as the server
//! formats them; the statement is prepared first (when the server allows it) purely to learn the
//! columns and where they come from. Paging uses the shared [`paging`] module: a task owns the
//! connection and feeds a bounded channel while the session holds the receiver.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::StreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlRow};
use sqlx::{
    AssertSqlSafe, Column, ConnectOptions, Connection, Executor, Row, SqlSafeStr, Statement,
    TypeInfo,
};
use tokio::task::JoinHandle;

use super::decode::{decode_text, effective_type_name, kind_for_type};
use super::error::{is_connection_error, map_error};
use crate::drivers::introspect::NodeKind;
use crate::drivers::paging::{self, Msg, STREAM_BUFFER};
use crate::drivers::split_source;
use crate::drivers::value::unhex;
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, FullValueRequest, ResultEvent, ResultId, ResultSink, ServerInfo, Session, TxState,
    Value,
};

/// What MySQL and MariaDB let a session choose.
pub const ISOLATION_LEVELS: &[&str] = &[
    "READ UNCOMMITTED",
    "READ COMMITTED",
    "REPEATABLE READ",
    "SERIALIZABLE",
];

/// The statement that sets the isolation level of the session's following transactions.
pub fn set_isolation_sql(level: &str) -> String {
    format!("SET SESSION TRANSACTION ISOLATION LEVEL {level}")
}

type OpenStream = paging::OpenStream<MySqlConnection>;

enum ConnState {
    Idle(Box<MySqlConnection>),
    /// The connection is inside the stream task.
    Streaming,
    Gone,
}

/// Cancels the running statement from a second connection (`KILL QUERY <id>`).
pub struct MyCancel {
    opts: MySqlConnectOptions,
    connection_id: u64,
    running: AtomicBool,
    target: String,
}

#[async_trait]
impl CancelFn for MyCancel {
    async fn cancel(&self) -> DriverResult<()> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        let connect = self.opts.connect();
        let mut conn = tokio::time::timeout(Duration::from_secs(5), connect)
            .await
            .map_err(|_| {
                DriverError::new(
                    ErrorCode::Timeout,
                    "Could not open a connection to cancel the statement",
                )
            })?
            .map_err(|e| map_error(e, &self.target, None))?;
        // KILL does not accept bind parameters; the id is a number we read from the server.
        conn.execute(AssertSqlSafe(format!("KILL QUERY {}", self.connection_id)).into_sql_str())
            .await
            .map_err(|e| map_error(e, &self.target, None))?;
        let _ = conn.close().await;
        Ok(())
    }
}

pub struct MySession {
    conn: ConnState,
    cancel: Arc<MyCancel>,
    server: ServerInfo,
    next_result: ResultId,
    stream: Option<OpenStream>,
    target: String,
}

fn type_name_of(info: &sqlx::mysql::MySqlTypeInfo) -> String {
    effective_type_name(info.name(), &format!("{info:?}"))
}

fn decode_row(row: &MySqlRow) -> Vec<Value> {
    (0..row.len())
        .map(|i| {
            let ty = type_name_of(row.column(i).type_info());
            match row.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
                Ok(Some(bytes)) => decode_text(&ty, &bytes, true),
                _ => Value::Null,
            }
        })
        .collect()
}

pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

impl MySession {
    pub async fn connect(
        opts: MySqlConnectOptions,
        server: ServerInfo,
        read_only: bool,
        target: String,
    ) -> DriverResult<Self> {
        let opts = opts.statement_cache_capacity(0);
        let mut conn = opts
            .connect()
            .await
            .map_err(|e| map_error(e, &target, None))?;
        if read_only {
            conn.execute("SET SESSION TRANSACTION READ ONLY")
                .await
                .map_err(|e| map_error(e, &target, None))?;
        }
        let id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut conn)
            .await
            .map_err(|e| map_error(e, &target, None))?;
        let cancel = Arc::new(MyCancel {
            opts: opts.clone(),
            connection_id: id,
            running: AtomicBool::new(false),
            target: target.clone(),
        });
        Ok(Self {
            conn: ConnState::Idle(Box::new(conn)),
            cancel,
            server,
            next_result: 1,
            stream: None,
            target,
        })
    }

    fn lost(&self) -> DriverError {
        DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {} was lost", self.target),
        )
    }

    /// Run a one-value query over the text protocol and return the value as text.
    async fn query_text(&mut self, sql: &str) -> DriverResult<Option<String>> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let result = sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
            .fetch_optional(&mut *conn)
            .await;
        match result {
            Ok(row) => {
                self.conn = ConnState::Idle(conn);
                Ok(row.and_then(|r| {
                    r.try_get_unchecked::<Option<Vec<u8>>, _>(0)
                        .ok()
                        .flatten()
                        .map(|b| String::from_utf8_lossy(&b).into_owned())
                }))
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.target, None))
            }
        }
    }

    /// End any open result stream and take the connection back.
    async fn reclaim(&mut self) -> DriverResult<()> {
        if let Some(OpenStream { rx, task, .. }) = self.stream.take() {
            drop(rx);
            let _ = self.cancel.cancel().await;
            match task.await {
                Ok(conn) => self.conn = ConnState::Idle(Box::new(conn)),
                Err(_) => self.conn = ConnState::Gone,
            }
            self.cancel.running.store(false, Ordering::SeqCst);
        }
        Ok(())
    }

    fn take_idle(&mut self) -> DriverResult<Box<MySqlConnection>> {
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
            self.cancel.running.store(false, Ordering::SeqCst);
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

/// `ER_UNSUPPORTED_PS`: the statement cannot be prepared (BEGIN, USE, SET, ... on some servers).
fn is_unsupported_prepare(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(db)
        if db.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>().is_some_and(|m| m.number() == 1295))
}

#[async_trait]
impl Session for MySession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let sql = req.sql;
        self.cancel.running.store(true, Ordering::SeqCst);

        // Prepare to learn the columns before any rows arrive. A statement the server will not
        // prepare is run as a plain command.
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
                    (c.name().to_string(), type_name_of(c.type_info()), origin)
                })
                .collect(),
            Err(e) if is_unsupported_prepare(&e) => Vec::new(),
            Err(e) => {
                self.cancel.running.store(false, Ordering::SeqCst);
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                return Err(map_error(e, &self.target, Some(&sql)));
            }
        };

        if columns.is_empty() {
            // Either a command, or a statement whose columns the server can't describe before
            // running it (EXPLAIN on MySQL 8). Run it as text and see whether rows come back.
            let mut affected = 0u64;
            let mut rows: Vec<MySqlRow> = Vec::new();
            let mut failure = None;
            {
                let mut stream = sqlx::raw_sql(AssertSqlSafe(sql.clone())).fetch_many(&mut *conn);
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(sqlx::Either::Left(done)) => affected += done.rows_affected(),
                        Ok(sqlx::Either::Right(row)) => rows.push(row),
                        Err(e) => {
                            failure = Some(e);
                            break;
                        }
                    }
                }
            }
            self.cancel.running.store(false, Ordering::SeqCst);
            if let Some(e) = failure {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                return Err(map_error(e, &self.target, Some(&sql)));
            }
            self.conn = ConnState::Idle(conn);
            let id = self.next_result;
            self.next_result += 1;
            let summary = ExecSummary {
                rows_affected: if rows.is_empty() {
                    Some(affected)
                } else {
                    None
                },
                elapsed_ms: started.elapsed().as_millis() as u64,
                has_more: false,
            };
            if let Some(first) = rows.first() {
                let metas = first
                    .columns()
                    .iter()
                    .map(|c| {
                        let ty = type_name_of(c.type_info());
                        ColumnMeta {
                            name: c.name().to_string(),
                            kind: kind_for_type(&ty),
                            type_name: ty,
                            nullable: None,
                            source_table: None,
                            source_column: None,
                            source_schema: None,
                            source_updatable: None,
                        }
                    })
                    .collect();
                sink.send(ResultEvent::Columns {
                    result_id: id,
                    statement: 0,
                    columns: metas,
                })
                .await;
                sink.send(ResultEvent::Rows {
                    result_id: id,
                    rows: rows.iter().map(decode_row).collect(),
                })
                .await;
            }
            sink.send(ResultEvent::Done {
                result_id: id,
                summary: summary.clone(),
            })
            .await;
            return Ok(summary);
        }

        let metas: Vec<ColumnMeta> = columns
            .iter()
            .map(|(name, ty, origin)| ColumnMeta {
                name: name.clone(),
                type_name: ty.clone(),
                kind: kind_for_type(ty),
                nullable: None,
                source_table: origin.as_ref().map(|(t, _)| t.clone()),
                source_column: origin.as_ref().map(|(_, c)| c.clone()),
                source_schema: origin
                    .as_ref()
                    .and_then(|(t, _)| split_source(t).0.map(str::to_string)),
                // A column without a table is an expression, an aggregate or a literal.
                source_updatable: Some(origin.is_some()),
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
        let target = self.target.clone();
        let sql_for_errors = sql.clone();
        let task: JoinHandle<MySqlConnection> = tokio::spawn(async move {
            {
                let mut rows = sqlx::raw_sql(AssertSqlSafe(sql)).fetch(&mut owned);
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
                            let err = map_error(e, &target, Some(&sql_for_errors));
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

    async fn set_read_only(&mut self, read_only: bool) -> DriverResult<()> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let mode = if read_only { "READ ONLY" } else { "READ WRITE" };
        let result = sqlx::raw_sql(AssertSqlSafe(format!("SET SESSION TRANSACTION {mode}")))
            .execute(&mut *conn)
            .await;
        match result {
            Ok(_) => {
                self.conn = ConnState::Idle(conn);
                Ok(())
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.target, None))
            }
        }
    }

    async fn execute_params(&mut self, sql: &str, params: &[Value]) -> DriverResult<u64> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        self.cancel.running.store(true, Ordering::SeqCst);
        // Transaction control (START TRANSACTION, SAVEPOINT) is not allowed in the prepared
        // protocol on MySQL, so parameterless statements go over the text protocol.
        let result = if params.is_empty() {
            sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
                .execute(&mut *conn)
                .await
        } else {
            let mut query = sqlx::query(AssertSqlSafe(sql.to_string())).persistent(false);
            for p in params {
                query = match p {
                    Value::Null => query.bind(None::<String>),
                    Value::Int { value } => query.bind(*value),
                    Value::Float { value } => query.bind(*value),
                    Value::Bool { value } => query.bind(*value as i64),
                    Value::Bytes { value, .. } => query.bind(unhex(value)),
                    other => query.bind(other.sql_text()),
                };
            }
            query.execute(&mut *conn).await
        };
        self.cancel.running.store(false, Ordering::SeqCst);
        match result {
            Ok(done) => {
                self.conn = ConnState::Idle(conn);
                Ok(done.rows_affected())
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.target, Some(sql)))
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
        struct Handle(Arc<MyCancel>);
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
        let result = fetch_full(&mut conn, &req, &self.target).await;
        if !matches!(&result, Err(e) if e.code == ErrorCode::ConnectionLost) {
            self.conn = ConnState::Idle(conn);
        }
        result
    }

    fn server_info(&self) -> ServerInfo {
        self.server.clone()
    }

    fn backend_id(&self) -> Option<String> {
        Some(self.cancel.connection_id.to_string())
    }

    /// MariaDB has `@@in_transaction`; MySQL reports its open transactions in the performance
    /// schema, which not every user may read. Without it, `SET TRANSACTION ISOLATION LEVEL` (set
    /// to the level already in force) tells the states apart: the server refuses it with error
    /// 1568 inside a transaction. When nothing answers, the manager's own bookkeeping stands.
    async fn transaction_state(&mut self) -> DriverResult<Option<TxState>> {
        let sql = if self.server.product.eq_ignore_ascii_case("MariaDB") {
            "SELECT @@in_transaction"
        } else {
            "SELECT COUNT(*) FROM performance_schema.events_transactions_current \
             WHERE STATE = 'ACTIVE' AND THREAD_ID = PS_CURRENT_THREAD_ID()"
        };
        match self.query_text(sql).await {
            Ok(Some(v)) => {
                return Ok(Some(if v.trim() == "0" {
                    TxState::Idle
                } else {
                    TxState::InTransaction
                }))
            }
            Err(e) if e.code == ErrorCode::ConnectionLost => return Err(e),
            _ => {}
        }
        let Some(level) = self.isolation_level().await? else {
            return Ok(None);
        };
        let Ok(level) = crate::drivers::canonical_isolation(ISOLATION_LEVELS, &level) else {
            return Ok(None);
        };
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let result = sqlx::raw_sql(AssertSqlSafe(format!(
            "SET TRANSACTION ISOLATION LEVEL {level}"
        )))
        .execute(&mut *conn)
        .await;
        match result {
            Ok(_) => {
                self.conn = ConnState::Idle(conn);
                Ok(Some(TxState::Idle))
            }
            Err(sqlx::Error::Database(db))
                if db
                    .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                    .is_some_and(|m| m.number() == 1568) =>
            {
                self.conn = ConnState::Idle(conn);
                Ok(Some(TxState::InTransaction))
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.target, None))
            }
        }
    }

    fn supported_isolation_levels(&self) -> &'static [&'static str] {
        ISOLATION_LEVELS
    }

    async fn isolation_level(&mut self) -> DriverResult<Option<String>> {
        // `transaction_isolation` since MySQL 5.7.20 / MariaDB 11.1; `tx_isolation` before.
        for var in ["@@transaction_isolation", "@@tx_isolation"] {
            match self.query_text(&format!("SELECT {var}")).await {
                Ok(Some(v)) => return Ok(Some(v.replace('-', " ").to_ascii_uppercase())),
                Err(e) if e.code == ErrorCode::ConnectionLost => return Err(e),
                _ => {}
            }
        }
        Ok(None)
    }

    async fn set_isolation(&mut self, level: &str) -> DriverResult<()> {
        let level = crate::drivers::canonical_isolation(ISOLATION_LEVELS, level)?;
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let result = sqlx::raw_sql(AssertSqlSafe(set_isolation_sql(level)))
            .execute(&mut *conn)
            .await;
        match result {
            Ok(_) => {
                self.conn = ConnState::Idle(conn);
                Ok(())
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.target, None))
            }
        }
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
    conn: &mut MySqlConnection,
    req: &FullValueRequest,
    target: &str,
) -> DriverResult<Value> {
    // In MySQL the "database" is the top level; there are no schemas below it.
    let database = req.table.find(NodeKind::Database);
    let table = req
        .table
        .0
        .iter()
        .rev()
        .find(|s| matches!(s.kind, NodeKind::Table | NodeKind::View))
        .map(|s| s.name.as_str())
        .ok_or_else(|| DriverError::internal("The path does not name a table"))?;
    let qualified = match database {
        Some(db) => format!("{}.{}", quote_ident(db), quote_ident(table)),
        None => quote_ident(table),
    };

    let mut conditions = Vec::new();
    let mut binds = Vec::new();
    for (col, value) in &req.key {
        match value.sql_text() {
            Some(text) => {
                conditions.push(format!("{} = ?", quote_ident(col)));
                binds.push(text);
            }
            None => conditions.push(format!("{} IS NULL", quote_ident(col))),
        }
    }
    if conditions.is_empty() {
        return Err(DriverError::internal("A key is needed to find the row"));
    }
    let sql = format!(
        "SELECT {} FROM {} WHERE {} LIMIT 1",
        quote_ident(&req.column),
        qualified,
        conditions.join(" AND ")
    );
    let mut query = sqlx::query(AssertSqlSafe(sql.clone())).persistent(false);
    for b in binds {
        query = query.bind(b);
    }
    let row = query
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| map_error(e, target, Some(&sql)))?
        .ok_or_else(|| DriverError::new(ErrorCode::QueryFailed, "The row no longer exists"))?;
    let ty = type_name_of(row.column(0).type_info());
    match row.try_get_unchecked::<Option<Vec<u8>>, _>(0) {
        Ok(Some(bytes)) => Ok(decode_text(&ty, &bytes, false)),
        Ok(None) => Ok(Value::Null),
        Err(e) => Err(map_error(e, target, None)),
    }
}
