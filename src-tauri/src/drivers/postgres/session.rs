//! A PostgreSQL session: one dedicated physical connection.
//!
//! sqlx streams rows by borrowing the connection, so a result set that is paged keeps its stream
//! alive inside a task that owns the connection and feeds an mpsc channel (bounded, so the server
//! is paused by TCP back-pressure once a page ahead is buffered). `fetch_more` pulls from that
//! channel; running another statement ends the stream first.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::StreamExt;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgRow};
use sqlx::{
    AssertSqlSafe, Column, ConnectOptions, Connection, Executor, Row, SqlSafeStr, Statement,
    TypeInfo,
};

use super::decode::{decode_value, decode_value_opts, kind_for_info};
use super::error::{is_connection_error, map_error};
use crate::drivers::introspect::NodeKind;
use crate::drivers::paging::{self, Msg, STREAM_BUFFER};
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, FullValueRequest, ResultEvent, ResultId, ResultSink, ServerInfo, Session, TxState,
    Value,
};

/// What PostgreSQL lets a session choose (READ UNCOMMITTED is accepted but behaves as READ COMMITTED,
/// so it is not offered).
pub const ISOLATION_LEVELS: &[&str] = &["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"];

/// The statement that sets the default isolation level of the session's following transactions.
pub fn set_isolation_sql(level: &str) -> String {
    format!("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL {level}")
}

type OpenStream = paging::OpenStream<PgConnection>;

enum ConnState {
    Idle(Box<PgConnection>),
    /// The connection is inside the stream task.
    Streaming,
    Gone,
}

/// Cancels the running statement from a second connection (`pg_cancel_backend`).
pub struct PgCancel {
    opts: PgConnectOptions,
    pid: i32,
    /// Only cancel while a statement is actually running, so a late cancel cannot hit the next one.
    running: AtomicBool,
    target: String,
}

#[async_trait]
impl CancelFn for PgCancel {
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
            .map_err(|e| map_error(e, &self.target))?;
        sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(self.pid)
            .execute(&mut conn)
            .await
            .map_err(|e| map_error(e, &self.target))?;
        let _ = conn.close().await;
        Ok(())
    }
}

#[derive(Default)]
struct NameCache {
    tables: HashMap<u32, String>,
    /// The schema of each relation in `tables`.
    schemas: HashMap<u32, String>,
    attributes: HashMap<(u32, i16), String>,
    /// Columns the database always fills (`GENERATED ALWAYS` identity or stored generated).
    always_generated: std::collections::HashSet<(u32, i16)>,
}

pub struct PgSession {
    conn: ConnState,
    cancel: Arc<PgCancel>,
    server: ServerInfo,
    next_result: ResultId,
    stream: Option<OpenStream>,
    names: NameCache,
    target: String,
}

/// A value as the text PostgreSQL parses for its column type (`None` is NULL).
fn param_text(v: &Value) -> Option<String> {
    match v {
        Value::Bytes { value, .. } => Some(format!("\\x{value}")),
        Value::Bool { value } => Some(if *value { "true" } else { "false" }.to_string()),
        other => other.sql_text(),
    }
}

impl PgSession {
    pub async fn connect(
        opts: PgConnectOptions,
        server: ServerInfo,
        read_only: bool,
        target: String,
    ) -> DriverResult<Self> {
        let opts = opts.statement_cache_capacity(0);
        let mut conn = opts.connect().await.map_err(|e| map_error(e, &target))?;
        if read_only {
            conn.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                .await
                .map_err(|e| map_error(e, &target))?;
        }
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut conn)
            .await
            .map_err(|e| map_error(e, &target))?;
        let cancel = Arc::new(PgCancel {
            opts: opts.clone(),
            pid,
            running: AtomicBool::new(false),
            target: target.clone(),
        });
        Ok(Self {
            conn: ConnState::Idle(Box::new(conn)),
            cancel,
            server,
            next_result: 1,
            stream: None,
            names: NameCache::default(),
            target,
        })
    }

    fn lost(&self) -> DriverError {
        DriverError::new(
            ErrorCode::ConnectionLost,
            format!("The connection to {} was lost", self.target),
        )
    }

    /// End any open result stream and take the connection back.
    async fn reclaim(&mut self) -> DriverResult<()> {
        if let Some(OpenStream { rx, task, .. }) = self.stream.take() {
            // Stop the server producing rows nobody will read, then let the task wind down.
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

    fn take_idle(&mut self) -> DriverResult<Box<PgConnection>> {
        match std::mem::replace(&mut self.conn, ConnState::Gone) {
            ConnState::Idle(c) => Ok(c),
            ConnState::Streaming => Err(DriverError::internal("A result is still streaming")),
            ConnState::Gone => Err(self.lost()),
        }
    }

    /// Fill the name caches for the relations referenced by the result columns.
    async fn resolve_sources(
        &mut self,
        conn: &mut PgConnection,
        relations: &[(u32, i16)],
    ) -> Result<(), sqlx::Error> {
        let missing_tables: Vec<i64> = relations
            .iter()
            .map(|(oid, _)| *oid)
            .filter(|oid| !self.names.tables.contains_key(oid))
            .map(i64::from)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        if !missing_tables.is_empty() {
            let rows: Vec<(i64, String, String)> = sqlx::query_as(
                "SELECT c.oid::int8, n.nspname, c.relname FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid::int8 = ANY($1)",
            )
            .bind(&missing_tables)
            .fetch_all(&mut *conn)
            .await?;
            for (oid, schema, name) in rows {
                self.names
                    .tables
                    .insert(oid as u32, format!("{schema}.{name}"));
                self.names.schemas.insert(oid as u32, schema);
            }
            let attrs: Vec<(i64, i16, String, bool)> = sqlx::query_as(
                "SELECT attrelid::int8, attnum, attname, (attidentity = 'a' OR attgenerated <> '') \
                 FROM pg_attribute WHERE attrelid::int8 = ANY($1) AND attnum > 0",
            )
            .bind(&missing_tables)
            .fetch_all(&mut *conn)
            .await?;
            for (oid, num, name, always) in attrs {
                self.names.attributes.insert((oid as u32, num), name);
                if always {
                    self.names.always_generated.insert((oid as u32, num));
                }
            }
        }
        Ok(())
    }

    /// Send the rows of one page (and peek whether more remain). Shared by execute and fetch_more.
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

fn decode_row(row: &PgRow) -> Vec<Value> {
    (0..row.len())
        .map(|i| match row.try_get_raw(i) {
            Ok(v) => decode_value(v),
            Err(_) => Value::Null,
        })
        .collect()
}

/// Quote an identifier for use in SQL text.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn value_text(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => return None,
        Value::Bool { value } => value.to_string(),
        Value::Int { value } => value.to_string(),
        Value::Float { value } => value.to_string(),
        Value::Bigint { value }
        | Value::Decimal { value }
        | Value::Text { value, .. }
        | Value::Date { value }
        | Value::Time { value }
        | Value::Timestamp { value }
        | Value::Timestamptz { value }
        | Value::Interval { value }
        | Value::Uuid { value }
        | Value::Other { value, .. } => value.clone(),
        Value::Bytes { value, .. } => format!("\\x{value}"),
        Value::Json { value } => value.to_string(),
        Value::Array { .. }
        | Value::Node { .. }
        | Value::Relationship { .. }
        | Value::Path { .. } => return None,
    })
}

#[async_trait]
impl Session for PgSession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let sql = req.sql;
        self.cancel.running.store(true, Ordering::SeqCst);

        // Prepare first: that tells us the columns (and where they come from) before any rows.
        let prepared = match conn
            .prepare(AssertSqlSafe(sql.clone()).into_sql_str())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                self.cancel.running.store(false, Ordering::SeqCst);
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                return Err(map_error(e, &self.target));
            }
        };

        let columns: Vec<_> = prepared.columns().to_vec();
        if columns.is_empty() {
            let result = sqlx::query(AssertSqlSafe(sql))
                .persistent(false)
                .execute(&mut *conn)
                .await;
            self.cancel.running.store(false, Ordering::SeqCst);
            return match result {
                Ok(done) => {
                    self.conn = ConnState::Idle(conn);
                    let summary = ExecSummary {
                        rows_affected: Some(done.rows_affected()),
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
                    Err(map_error(e, &self.target))
                }
            };
        }

        let relations: Vec<(u32, i16)> = columns
            .iter()
            .filter_map(|c| Some((c.relation_id()?.0, c.relation_attribute_no()?)))
            .collect();
        if let Err(e) = self.resolve_sources(&mut conn, &relations).await {
            self.cancel.running.store(false, Ordering::SeqCst);
            if !is_connection_error(&e) {
                self.conn = ConnState::Idle(conn);
            }
            return Err(map_error(e, &self.target));
        }

        let metas: Vec<ColumnMeta> = columns
            .iter()
            .map(|c| {
                let (table, column, schema, updatable) =
                    match (c.relation_id(), c.relation_attribute_no()) {
                        (Some(rel), Some(num)) => {
                            let column = self.names.attributes.get(&(rel.0, num)).cloned();
                            let updatable = column
                                .is_some()
                                .then(|| !self.names.always_generated.contains(&(rel.0, num)));
                            (
                                self.names.tables.get(&rel.0).cloned(),
                                column,
                                self.names.schemas.get(&rel.0).cloned(),
                                updatable,
                            )
                        }
                        // No relation: an expression, an aggregate or a literal.
                        _ => (None, None, None, Some(false)),
                    };
                ColumnMeta {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                    kind: kind_for_info(c.type_info()),
                    nullable: None,
                    source_table: table,
                    source_column: column,
                    source_schema: schema,
                    source_updatable: updatable,
                }
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

        // The stream task owns the connection until the result ends or is abandoned.
        let (tx, rx) = tokio::sync::mpsc::channel(STREAM_BUFFER);
        let mut owned = *conn;
        let task = tokio::spawn(async move {
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
                            let target = String::new();
                            let _ = tx.send(Msg::Err(map_error(e, &target))).await;
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
        let result = conn
            .execute(AssertSqlSafe(format!(
                "SET SESSION CHARACTERISTICS AS TRANSACTION {mode}"
            )))
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
                Err(map_error(e, &self.target))
            }
        }
    }

    async fn execute_params(&mut self, sql: &str, params: &[Value]) -> DriverResult<u64> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        self.cancel.running.store(true, Ordering::SeqCst);
        // Everything is sent as text; the generated SQL casts each placeholder to its column type.
        let mut query = sqlx::query(AssertSqlSafe(sql.to_string())).persistent(false);
        for p in params {
            query = query.bind(param_text(p));
        }
        let result = query.execute(&mut *conn).await;
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
                Err(map_error(e, &self.target))
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
        struct Handle(Arc<PgCancel>);
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
        Some(self.cancel.pid.to_string())
    }

    /// `SAVEPOINT` tells the three states apart: it fails with 25P01 outside a transaction block,
    /// with 25P02 inside an aborted one, and works inside a healthy one. Outside a transaction the
    /// failed statement leaves nothing behind.
    async fn transaction_state(&mut self) -> DriverResult<Option<TxState>> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let result = conn.execute("SAVEPOINT clew_state_probe").await;
        let state = match result {
            Ok(_) => {
                let released = conn.execute("RELEASE SAVEPOINT clew_state_probe").await;
                if let Err(e) = released {
                    if !is_connection_error(&e) {
                        self.conn = ConnState::Idle(conn);
                    }
                    return Err(map_error(e, &self.target));
                }
                TxState::InTransaction
            }
            Err(sqlx::Error::Database(db)) => match db.code().as_deref() {
                Some("25P01") => TxState::Idle,
                Some("25P02") => TxState::Aborted,
                _ => {
                    self.conn = ConnState::Idle(conn);
                    return Err(map_error(sqlx::Error::Database(db), &self.target));
                }
            },
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                return Err(map_error(e, &self.target));
            }
        };
        self.conn = ConnState::Idle(conn);
        Ok(Some(state))
    }

    fn supported_isolation_levels(&self) -> &'static [&'static str] {
        ISOLATION_LEVELS
    }

    async fn isolation_level(&mut self) -> DriverResult<Option<String>> {
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let result: Result<String, sqlx::Error> =
            sqlx::query_scalar("SELECT current_setting('default_transaction_isolation')")
                .persistent(false)
                .fetch_one(&mut *conn)
                .await;
        match result {
            Ok(level) => {
                self.conn = ConnState::Idle(conn);
                Ok(Some(level.to_ascii_uppercase()))
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.target))
            }
        }
    }

    async fn set_isolation(&mut self, level: &str) -> DriverResult<()> {
        let level = crate::drivers::canonical_isolation(ISOLATION_LEVELS, level)?;
        self.reclaim().await?;
        let mut conn = self.take_idle()?;
        let result = conn.execute(AssertSqlSafe(set_isolation_sql(level))).await;
        match result {
            Ok(_) => {
                self.conn = ConnState::Idle(conn);
                Ok(())
            }
            Err(e) => {
                if !is_connection_error(&e) {
                    self.conn = ConnState::Idle(conn);
                }
                Err(map_error(e, &self.target))
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
    conn: &mut PgConnection,
    req: &FullValueRequest,
    target: &str,
) -> DriverResult<Value> {
    let schema = req.table.find(NodeKind::Schema);
    let table = req
        .table
        .0
        .iter()
        .rev()
        .find(|s| {
            matches!(
                s.kind,
                NodeKind::Table | NodeKind::View | NodeKind::MaterializedView
            )
        })
        .map(|s| s.name.as_str())
        .ok_or_else(|| DriverError::internal("The path does not name a table"))?;
    let qualified = match schema {
        Some(s) => format!("{}.{}", quote_ident(s), quote_ident(table)),
        None => quote_ident(table),
    };

    // Compare each key column as `col = $n::text::<its type>` so any key type works.
    let key_cols: Vec<String> = req.key.iter().map(|(c, _)| c.clone()).collect();
    let types: Vec<(String, String)> = sqlx::query_as(
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a \
         WHERE a.attrelid = to_regclass($1) AND a.attname::text = ANY($2) AND NOT a.attisdropped",
    )
    .bind(&qualified)
    .bind(&key_cols)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| map_error(e, target))?;
    let type_of: HashMap<_, _> = types.into_iter().collect();

    let mut conditions = Vec::new();
    let mut binds = Vec::new();
    for (col, value) in &req.key {
        let ty = type_of
            .get(col)
            .ok_or_else(|| DriverError::internal(format!("Unknown key column \"{col}\"")))?;
        match value_text(value) {
            Some(text) => {
                binds.push(text);
                conditions.push(format!(
                    "{} = ${}::text::{}",
                    quote_ident(col),
                    binds.len(),
                    ty
                ));
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
    let mut query = sqlx::query(AssertSqlSafe(sql)).persistent(false);
    for b in binds {
        query = query.bind(b);
    }
    let row = query
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| map_error(e, target))?
        .ok_or_else(|| DriverError::new(ErrorCode::QueryFailed, "The row no longer exists"))?;
    let raw = row.try_get_raw(0).map_err(|e| map_error(e, target))?;
    Ok(decode_value_opts(raw, false))
}
