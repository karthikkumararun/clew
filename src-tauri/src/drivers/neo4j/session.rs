//! A Neo4j session: one logical connection that runs Cypher in explicit transactions, streams
//! records in batches (an open result keeps its connection until it is read to the end or
//! closed), and cancels a running query with Bolt's RESET.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use tokio::sync::watch;

use super::bolt::conn::{self, failure_error};
use super::bolt::{Client, Conn, Ps, Resp};
use super::convert::{convert, json_to_ps, params_to_ps, Elements};
use super::plan::plan_of;
use crate::drivers::graph::{
    GraphAccess, GraphMode, GraphRequest, GraphResult, GraphSummary, DEFAULT_FETCH_SIZE,
};
use crate::drivers::{
    CancelFn, CancelHandle, ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest,
    ExecSummary, GraphSession, ResultEvent, ResultId, ResultSink, ServerInfo, Session, Value,
    ValueKind,
};
use crate::safety::cypher;

/// Rows of a write query or a PROFILE kept in memory past the first batch.
const BUFFER_CAP: usize = 50_000;
/// Records per PULL while a result is drained internally.
const DRAIN_BATCH: i64 = 1_000;

struct Cancel(Arc<watch::Sender<u64>>);

#[async_trait]
impl CancelFn for Cancel {
    async fn cancel(&self) -> DriverResult<()> {
        self.0.send_modify(|generation| *generation += 1);
        Ok(())
    }
}

enum Source {
    /// The result is still on the server; the connection and its transaction stay open.
    Live { conn: Conn, explicit_tx: bool },
    /// The result was read to the end already (writes and PROFILE); what is left is buffered.
    Buffered { rows: VecDeque<Vec<Ps>>, meta: Ps },
}

struct OpenCursor {
    id: String,
    fields: Vec<String>,
    source: Source,
    fetch_size: usize,
    database: String,
    started: Instant,
}

pub struct Neo4jSession {
    client: Client,
    info: ServerInfo,
    /// `None` = the user's home database.
    database: Option<String>,
    /// Bolt major version learned at connect; decides `elementId()` versus `id()`.
    bolt_major: u8,
    read_only: bool,
    /// Ends a transaction on the server after this long (`tx_timeout`).
    query_timeout: Option<std::time::Duration>,
    cursor: Option<OpenCursor>,
    next_cursor: u64,
    cancel: Arc<watch::Sender<u64>>,
    cancel_seen: watch::Receiver<u64>,
    alive: bool,
}

fn cancelled() -> DriverError {
    DriverError::new(ErrorCode::Cancelled, "The query was cancelled")
}

/// `RETURN 1` style failures that mean the routing table is stale.
fn routing_stale(e: &DriverError) -> bool {
    e.detail.as_deref().is_some_and(|d| {
        d.contains("NotALeader")
            || d.contains("ForbiddenOnReadOnlyDatabase")
            || d.contains("DatabaseUnavailable")
    })
}

async fn recv_cancellable(
    conn: &mut Conn,
    cancel: &mut watch::Receiver<u64>,
) -> DriverResult<Resp> {
    tokio::select! {
        r = conn.recv() => r,
        changed = cancel.changed() => {
            if changed.is_ok() {
                // RESET interrupts the running query on the server and clears the stream
                conn.recover().await;
                Err(cancelled())
            } else {
                conn.recv().await
            }
        }
    }
}

/// A summary the query waits for: failures reset the connection and become errors.
async fn recv_summary(conn: &mut Conn, cancel: &mut watch::Receiver<u64>) -> DriverResult<Ps> {
    match recv_cancellable(conn, cancel).await? {
        Resp::Success(meta) => Ok(meta),
        Resp::Failure { code, message } => {
            conn.recover().await;
            Err(failure_error(&code, &message))
        }
        Resp::Ignored => {
            conn.recover().await;
            Err(DriverError::new(
                ErrorCode::QueryFailed,
                "The server ignored the request",
            ))
        }
        Resp::Record(_) => Err(DriverError::internal(
            "a record where a summary was expected",
        )),
    }
}

/// One PULL's worth: records until the summary.
async fn read_batch(
    conn: &mut Conn,
    cancel: &mut watch::Receiver<u64>,
) -> DriverResult<(Vec<Vec<Ps>>, Ps)> {
    let mut rows = Vec::new();
    loop {
        match recv_cancellable(conn, cancel).await? {
            Resp::Record(values) => rows.push(values),
            Resp::Success(meta) => return Ok((rows, meta)),
            Resp::Failure { code, message } => {
                conn.recover().await;
                return Err(failure_error(&code, &message));
            }
            Resp::Ignored => {
                conn.recover().await;
                return Err(DriverError::new(
                    ErrorCode::QueryFailed,
                    "The server ignored the request",
                ));
            }
        }
    }
}

fn has_more(meta: &Ps) -> bool {
    meta.get("has_more").and_then(Ps::as_bool).unwrap_or(false)
}

fn fields_of(meta: &Ps) -> Vec<String> {
    meta.get("fields")
        .and_then(Ps::as_list)
        .unwrap_or_default()
        .iter()
        .filter_map(|f| f.as_str().map(str::to_string))
        .collect()
}

fn counters_of(meta: &Ps) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    for (k, v) in meta.get("stats").and_then(Ps::as_map).unwrap_or_default() {
        if let Some(n) = v.as_i64().filter(|n| *n != 0) {
            out.insert(k.clone(), n);
        }
    }
    out
}

/// `EXPLAIN` / `PROFILE` in front of the query, unless the text already starts with one.
fn prepare_text(cypher_text: &str, mode: GraphMode) -> String {
    let text = cypher_text
        .trim()
        .trim_end_matches(';')
        .trim_end()
        .to_string();
    let prefix = match mode {
        GraphMode::Run => return text,
        GraphMode::Explain => "EXPLAIN",
        GraphMode::Profile => "PROFILE",
    };
    match cypher::first_keyword(&text).as_deref() {
        Some("EXPLAIN" | "PROFILE") => text,
        _ => format!("{prefix} {text}"),
    }
}

impl Neo4jSession {
    pub(crate) fn new(
        client: Client,
        info: ServerInfo,
        database: Option<String>,
        bolt_major: u8,
        read_only: bool,
        query_timeout: Option<std::time::Duration>,
    ) -> Self {
        let (tx, rx) = watch::channel(0u64);
        Self {
            client,
            info,
            database,
            bolt_major,
            read_only,
            query_timeout,
            cursor: None,
            next_cursor: 1,
            cancel: Arc::new(tx),
            cancel_seen: rx,
            alive: true,
        }
    }

    fn note(&mut self, e: &DriverError) {
        if e.code == ErrorCode::ConnectionLost {
            self.alive = false;
        }
        if routing_stale(e) {
            self.client.forget_routing();
        }
    }

    /// Release what an open result holds: the server aborts its transaction.
    async fn close_cursor(&mut self) {
        if let Some(OpenCursor {
            source: Source::Live { mut conn, .. },
            ..
        }) = self.cursor.take()
        {
            conn.recover().await;
            self.client.release(conn);
        }
        self.cursor = None;
    }

    /// Run `text`, return the first batch. The heart of the session.
    async fn start(
        &mut self,
        text: String,
        params: Ps,
        access: GraphAccess,
        mode: GraphMode,
        fetch_size: u32,
    ) -> DriverResult<GraphResult> {
        self.close_cursor().await;
        self.cancel_seen.borrow_and_update();
        let started = Instant::now();
        let access = if self.read_only {
            GraphAccess::Read
        } else {
            access
        };
        let fetch = if fetch_size == 0 {
            DEFAULT_FETCH_SIZE
        } else {
            fetch_size
        } as i64;
        let mut result = self
            .start_inner(text.clone(), params.clone(), access, mode, fetch, started)
            .await;
        // A pooled connection the server closed while idle fails the first request on it. A read
        // can simply go again on a fresh connection; a write might already have run.
        if access == GraphAccess::Read
            && matches!(&result, Err(e) if e.code == ErrorCode::ConnectionLost)
        {
            result = self
                .start_inner(text, params, access, mode, fetch, started)
                .await;
        }
        if let Err(e) = &result {
            self.note(e);
        }
        result
    }

    async fn start_inner(
        &mut self,
        text: String,
        params: Ps,
        access: GraphAccess,
        mode: GraphMode,
        fetch: i64,
        started: Instant,
    ) -> DriverResult<GraphResult> {
        let db = self.database.clone();
        let mut conn = self.client.acquire(db.as_deref(), access).await?;
        let explicit_tx = !cypher::needs_auto_commit(&text);
        let mut extra: Vec<(String, Ps)> = Vec::new();
        if access == GraphAccess::Read {
            extra.push(("mode".into(), Ps::str("r")));
        }
        if let Some(d) = &db {
            extra.push(("db".into(), Ps::str(d.clone())));
        }
        if let Some(t) = self.query_timeout {
            extra.push(("tx_timeout".into(), Ps::Int(t.as_millis() as i64)));
        }
        let explain = mode == GraphMode::Explain;
        // EXPLAIN streams no records; PROFILE and writes are read to the end here
        let first_pull = if explain { -1 } else { fetch };
        if explicit_tx {
            conn.queue(conn::BEGIN, vec![Ps::Map(extra)]);
            conn.queue(conn::RUN, vec![Ps::Str(text), params, Ps::Map(vec![])]);
        } else {
            conn.queue(conn::RUN, vec![Ps::Str(text), params, Ps::Map(extra)]);
        }
        conn.queue(conn::PULL, vec![Ps::map([("n", Ps::Int(first_pull))])]);

        let outcome = async {
            conn.flush().await?;
            if explicit_tx {
                recv_summary(&mut conn, &mut self.cancel_seen).await?;
            }
            let run = recv_summary(&mut conn, &mut self.cancel_seen).await?;
            let fields = fields_of(&run);
            let (rows, meta) = read_batch(&mut conn, &mut self.cancel_seen).await?;
            Ok::<_, DriverError>((fields, rows, meta))
        }
        .await;
        let (fields, rows, meta) = match outcome {
            Ok(v) => v,
            Err(e) => {
                self.client.release(conn);
                return Err(e);
            }
        };

        let id = format!("c{}", self.next_cursor);
        self.next_cursor += 1;
        let database = meta
            .get("db")
            .and_then(Ps::as_str)
            .map(str::to_string)
            .or_else(|| db.clone())
            .unwrap_or_default();
        let drain_all =
            has_more(&meta) && (mode == GraphMode::Profile || access == GraphAccess::Write);

        if !has_more(&meta) {
            // finished in one batch
            let meta = self.finish(&mut conn, explicit_tx, meta).await;
            self.client.release(conn);
            let meta = meta?;
            return Ok(batch(&fields, rows, None, Some(&meta), started, &database));
        }

        if drain_all {
            let mut kept: VecDeque<Vec<Ps>> = VecDeque::new();
            let mut final_meta = meta;
            let mut keep_rows = mode != GraphMode::Profile;
            let drained: DriverResult<()> = async {
                while has_more(&final_meta) {
                    conn.send(conn::PULL, vec![Ps::map([("n", Ps::Int(DRAIN_BATCH))])])
                        .await?;
                    let (more, m) = read_batch(&mut conn, &mut self.cancel_seen).await?;
                    if keep_rows {
                        for row in more {
                            if kept.len() >= BUFFER_CAP {
                                keep_rows = false;
                                break;
                            }
                            kept.push_back(row);
                        }
                    }
                    final_meta = m;
                }
                Ok(())
            }
            .await;
            if let Err(e) = drained {
                self.client.release(conn);
                return Err(e);
            }
            let final_meta = self.finish(&mut conn, explicit_tx, final_meta).await;
            self.client.release(conn);
            let final_meta = final_meta?;
            if kept.is_empty() {
                return Ok(batch(
                    &fields,
                    rows,
                    None,
                    Some(&final_meta),
                    started,
                    &database,
                ));
            }
            self.cursor = Some(OpenCursor {
                id: id.clone(),
                fields: fields.clone(),
                source: Source::Buffered {
                    rows: kept,
                    meta: final_meta,
                },
                fetch_size: fetch as usize,
                database: database.clone(),
                started,
            });
            return Ok(batch(&fields, rows, Some(id), None, started, &database));
        }

        self.cursor = Some(OpenCursor {
            id: id.clone(),
            fields: fields.clone(),
            source: Source::Live { conn, explicit_tx },
            fetch_size: fetch as usize,
            database: database.clone(),
            started,
        });
        Ok(batch(&fields, rows, Some(id), None, started, &database))
    }

    /// Commit the explicit transaction of a result that has been read to the end. The returned
    /// metadata is the result's summary (the COMMIT's own metadata is not interesting).
    async fn finish(&mut self, conn: &mut Conn, explicit_tx: bool, meta: Ps) -> DriverResult<Ps> {
        if explicit_tx {
            conn.send(conn::COMMIT, vec![]).await?;
            recv_summary(conn, &mut self.cancel_seen).await?;
        }
        Ok(meta)
    }

    async fn fetch(&mut self, cursor_id: &str) -> DriverResult<GraphResult> {
        self.cancel_seen.borrow_and_update();
        let Some(mut cursor) = self.cursor.take() else {
            return Err(DriverError::new(
                ErrorCode::QueryFailed,
                "This result is no longer open; run the query again",
            ));
        };
        if cursor.id != cursor_id {
            self.cursor = Some(cursor);
            return Err(DriverError::new(
                ErrorCode::QueryFailed,
                "This result is no longer open; run the query again",
            ));
        }
        let fields = cursor.fields.clone();
        let database = cursor.database.clone();
        let started = cursor.started;
        match cursor.source {
            Source::Buffered { mut rows, meta } => {
                let take = cursor.fetch_size.min(rows.len());
                let batch_rows: Vec<Vec<Ps>> = rows.drain(..take).collect();
                if rows.is_empty() {
                    return Ok(batch(
                        &fields,
                        batch_rows,
                        None,
                        Some(&meta),
                        started,
                        &database,
                    ));
                }
                let id = cursor.id.clone();
                cursor.source = Source::Buffered { rows, meta };
                self.cursor = Some(cursor);
                Ok(batch(
                    &fields,
                    batch_rows,
                    Some(id),
                    None,
                    started,
                    &database,
                ))
            }
            Source::Live {
                mut conn,
                explicit_tx,
            } => {
                let pulled: DriverResult<(Vec<Vec<Ps>>, Ps)> = async {
                    conn.send(
                        conn::PULL,
                        vec![Ps::map([("n", Ps::Int(cursor.fetch_size as i64))])],
                    )
                    .await?;
                    read_batch(&mut conn, &mut self.cancel_seen).await
                }
                .await;
                let (rows, meta) = match pulled {
                    Ok(v) => v,
                    Err(e) => {
                        self.client.release(conn);
                        self.note(&e);
                        return Err(e);
                    }
                };
                if has_more(&meta) {
                    let id = cursor.id.clone();
                    cursor.source = Source::Live { conn, explicit_tx };
                    self.cursor = Some(cursor);
                    return Ok(batch(&fields, rows, Some(id), None, started, &database));
                }
                let meta = self.finish(&mut conn, explicit_tx, meta).await;
                self.client.release(conn);
                let meta = meta.inspect_err(|e| self.note(e))?;
                Ok(batch(&fields, rows, None, Some(&meta), started, &database))
            }
        }
    }

    /// Open and roll back an empty transaction on `name`: the server checks the database there.
    async fn probe_database(&mut self, name: &str) -> DriverResult<()> {
        let mut conn = self.client.acquire(Some(name), GraphAccess::Read).await?;
        let begin = Ps::map([("mode", Ps::str("r")), ("db", Ps::str(name))]);
        let outcome = async {
            conn.send(conn::BEGIN, vec![begin]).await?;
            recv_summary(&mut conn, &mut self.cancel_seen).await?;
            conn.send(conn::ROLLBACK, vec![]).await?;
            recv_summary(&mut conn, &mut self.cancel_seen).await?;
            Ok(())
        }
        .await;
        self.client.release(conn);
        if let Err(e) = &outcome {
            self.note(e);
        }
        outcome
    }

    fn expand_query(&self) -> &'static str {
        if self.bolt_major >= 5 {
            "MATCH (n)-[r]-(m) WHERE elementId(n) = $id RETURN r, m LIMIT $limit"
        } else {
            "MATCH (n)-[r]-(m) WHERE id(n) = toInteger($id) RETURN r, m LIMIT $limit"
        }
    }

    fn update_query(&self, kind: &str) -> &'static str {
        match (self.bolt_major >= 5, kind) {
            (true, "relationship") => {
                "MATCH ()-[r]->() WHERE elementId(r) = $id SET r += $props RETURN r"
            }
            (true, _) => "MATCH (n) WHERE elementId(n) = $id SET n += $props RETURN n",
            (false, "relationship") => {
                "MATCH ()-[r]->() WHERE id(r) = toInteger($id) SET r += $props RETURN r"
            }
            (false, _) => "MATCH (n) WHERE id(n) = toInteger($id) SET n += $props RETURN n",
        }
    }
}

/// A batch of rows as a result. `meta` is the final summary (None while more is waiting).
fn batch(
    fields: &[String],
    rows: Vec<Vec<Ps>>,
    cursor_id: Option<String>,
    meta: Option<&Ps>,
    started: Instant,
    database: &str,
) -> GraphResult {
    let mut elements = Elements::default();
    let records: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| row.iter().map(|v| convert(v, &mut elements)).collect())
        .collect();
    GraphResult {
        has_more: cursor_id.is_some(),
        cursor_id,
        columns: fields.to_vec(),
        records,
        nodes: elements.nodes,
        relationships: elements.relationships,
        summary: GraphSummary {
            elapsed_ms: started.elapsed().as_millis() as u64,
            counters: meta.map(counters_of).unwrap_or_default(),
            database: meta
                .and_then(|m| m.get("db"))
                .and_then(Ps::as_str)
                .map_or_else(|| database.to_string(), str::to_string),
        },
        plan: meta.and_then(plan_of),
    }
}

#[async_trait]
impl GraphSession for Neo4jSession {
    async fn query(&mut self, request: GraphRequest) -> DriverResult<GraphResult> {
        let text = prepare_text(&request.cypher, request.mode);
        if text.trim().is_empty() {
            return Err(DriverError::new(
                ErrorCode::QueryFailed,
                "There is no query to run",
            ));
        }
        let params = params_to_ps(&request.params);
        self.start(
            text,
            params,
            request.access,
            request.mode,
            request.fetch_size,
        )
        .await
    }

    async fn fetch_more(&mut self, cursor_id: &str) -> DriverResult<GraphResult> {
        let r = self.fetch(cursor_id).await;
        if let Err(e) = &r {
            self.note(e);
        }
        r
    }

    async fn expand(&mut self, element_id: &str, limit: u32) -> DriverResult<GraphResult> {
        let params = Ps::map([
            ("id", Ps::str(element_id)),
            ("limit", Ps::Int(i64::from(limit.max(1)))),
        ]);
        self.start(
            self.expand_query().to_string(),
            params,
            GraphAccess::Read,
            GraphMode::Run,
            limit.max(1),
        )
        .await
    }

    async fn update_properties(
        &mut self,
        element_id: &str,
        kind: &str,
        properties: serde_json::Map<String, serde_json::Value>,
    ) -> DriverResult<GraphResult> {
        let props = Ps::Map(
            properties
                .iter()
                .map(|(k, v)| (k.clone(), json_to_ps(v)))
                .collect(),
        );
        let params = Ps::map([("id", Ps::str(element_id)), ("props", props)]);
        self.start(
            self.update_query(kind).to_string(),
            params,
            GraphAccess::Write,
            GraphMode::Run,
            DEFAULT_FETCH_SIZE,
        )
        .await
    }
}

#[async_trait]
impl Session for Neo4jSession {
    /// Table-style execution (the SQL console path): one statement, records as values. `:use <db>`
    /// switches the session's database.
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = Instant::now();
        let text = req.sql.trim();
        if let Some(name) = cypher::use_command(text) {
            self.close_cursor().await;
            let previous = self.database.replace(name.clone());
            // prove the database exists and is online before the session depends on it
            if let Err(e) = self.probe_database(&name).await {
                self.database = previous;
                return Err(e);
            }
            let _ = sink
                .send(ResultEvent::Done {
                    result_id: self.next_cursor,
                    summary: summary_of(None, started, false),
                })
                .await;
            return Ok(summary_of(None, started, false));
        }
        let result = self
            .query(GraphRequest {
                cypher: text.to_string(),
                params: serde_json::Map::new(),
                access: GraphAccess::Write,
                mode: GraphMode::Run,
                fetch_size: req.page_size.clamp(1, u32::MAX as usize) as u32,
            })
            .await?;
        let result_id: ResultId = self
            .cursor
            .as_ref()
            .and_then(|c| c.id.trim_start_matches('c').parse().ok())
            .unwrap_or(self.next_cursor - 1);
        let columns: Vec<ColumnMeta> = result
            .columns
            .iter()
            .map(|name| ColumnMeta {
                name: name.clone(),
                type_name: "ANY".into(),
                kind: ValueKind::Other,
                nullable: None,
                source_table: None,
                source_column: None,
                source_schema: None,
                source_updatable: None,
            })
            .collect();
        let _ = sink
            .send(ResultEvent::Columns {
                result_id,
                statement: 0,
                columns,
            })
            .await;
        let rows = result.records;
        let rows_affected = (rows.is_empty() && result.columns.is_empty()).then_some(0);
        if !rows.is_empty() {
            let _ = sink.send(ResultEvent::Rows { result_id, rows }).await;
        }
        let summary = summary_of(rows_affected, started, result.has_more);
        let _ = sink
            .send(ResultEvent::Done {
                result_id,
                summary: summary.clone(),
            })
            .await;
        Ok(summary)
    }

    async fn fetch_more(
        &mut self,
        result_id: ResultId,
        n: usize,
        sink: ResultSink,
    ) -> DriverResult<bool> {
        let started = Instant::now();
        if let Some(c) = self.cursor.as_mut() {
            c.fetch_size = n.max(1);
        }
        let id = format!("c{result_id}");
        let result = GraphSession::fetch_more(self, &id).await?;
        if !result.records.is_empty() {
            let _ = sink
                .send(ResultEvent::Rows {
                    result_id,
                    rows: result.records,
                })
                .await;
        }
        let _ = sink
            .send(ResultEvent::Done {
                result_id,
                summary: summary_of(None, started, result.has_more),
            })
            .await;
        Ok(result.has_more)
    }

    async fn set_read_only(&mut self, read_only: bool) -> DriverResult<()> {
        self.read_only = read_only;
        Ok(())
    }

    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::new(Cancel(self.cancel.clone()))
    }

    fn server_info(&self) -> ServerInfo {
        self.info.clone()
    }

    fn as_graph(&mut self) -> Option<&mut dyn GraphSession> {
        Some(self)
    }

    fn is_alive(&self) -> bool {
        self.alive
    }

    async fn close(mut self: Box<Self>) -> DriverResult<()> {
        self.close_cursor().await;
        self.client.close().await;
        Ok(())
    }
}

fn summary_of(rows_affected: Option<u64>, started: Instant, has_more: bool) -> ExecSummary {
    ExecSummary {
        rows_affected,
        elapsed_ms: started.elapsed().as_millis() as u64,
        has_more,
    }
}
