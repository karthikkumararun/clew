//! Live connections: a metadata pool per connection plus one dedicated session per editor tab.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::drivers::registry::Registry;
use crate::drivers::split::split;
use crate::drivers::Dialect;
use crate::drivers::{
    CancelHandle, Driver, DriverError, DriverResult, ErrorCode, ExecRequest, ExecSummary,
    FullValueRequest, MetaPool, NodePath, ResolvedConfig, ResultEvent, ResultId, ResultSink,
    SchemaSnapshot, ServerInfo, Session, Target, TreeNode, Value,
};
use crate::history::{HistorySink, NewEntry, Outcome};
use crate::safety::classify::{classify, StatementClass, StatementInfo};
use crate::safety::guard::{bound_text, decide, Decision, Policy, Tokens, READ_ONLY_REASON};
use crate::transport::ssh::{SshEnv, SshTunnel};
use crate::transport::tls;

pub type SessionId = String;

/// Result of opening a session.
#[derive(Debug, Clone)]
pub struct SessionOpened {
    pub session_id: SessionId,
    pub server: ServerInfo,
    /// e.g. `via SSH bastion` when the connection is tunnelled.
    pub transport: Option<String>,
}
pub type ConnectionId = String;

/// Sessions idle for this long are closed.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Receives result events. Returns false when the receiver is gone (window closed).
pub type Emit = Arc<dyn Fn(ResultEvent) -> bool + Send + Sync>;

struct ConnectionEntry {
    driver: Arc<dyn Driver>,
    /// The config drivers connect with: when tunnelling, the target is the local forward.
    cfg: ResolvedConfig,
    pool: MetaPool,
    /// Lives as long as any session or pool of this connection (they hold this entry).
    tunnel: Option<Arc<SshTunnel>>,
}

struct SessionState {
    /// `None` after the connection was lost; the next execute reconnects.
    session: Option<Box<dyn Session>>,
    in_transaction: bool,
    /// Writes are refused. Starts as the connection's "read-only by default"; the user can switch
    /// it for this session only.
    read_only: bool,
}

struct SessionEntry {
    connection_id: ConnectionId,
    connection: Arc<ConnectionEntry>,
    state: Mutex<SessionState>,
    /// Lives outside `state` so cancelling never waits for a running execute.
    cancel: StdMutex<CancelHandle>,
    server: StdMutex<ServerInfo>,
    last_used: StdMutex<Instant>,
}

#[derive(Default)]
struct Inner {
    connections: HashMap<ConnectionId, Arc<ConnectionEntry>>,
    sessions: HashMap<SessionId, Arc<SessionEntry>>,
}

pub struct SessionManager {
    registry: Arc<Registry>,
    ssh_env: SshEnv,
    inner: StdMutex<Inner>,
    next_id: AtomicU64,
    /// Where finished console statements are reported (query history).
    history: StdMutex<Option<Arc<dyn HistorySink>>>,
    /// What each connection's safeguards ask of the guard.
    policies: StdMutex<HashMap<ConnectionId, Policy>>,
    /// One-time write confirmations.
    tokens: StdMutex<Tokens>,
}

impl std::fmt::Debug for SessionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionManager")
    }
}

fn not_found(what: &str, id: &str) -> DriverError {
    DriverError::new(ErrorCode::Internal, format!("Unknown {what} \"{id}\""))
}

/// Run `fut` with the connect timeout, turning an elapsed timer into a `timeout` error that names
/// the host and port.
async fn with_connect_timeout<T>(
    cfg: &ResolvedConfig,
    fut: impl std::future::Future<Output = DriverResult<T>>,
) -> DriverResult<T> {
    match tokio::time::timeout(Duration::from_secs(cfg.connect_timeout_secs.max(1)), fut).await {
        Ok(r) => r,
        Err(_) => Err(DriverError::new(
            ErrorCode::Timeout,
            format!(
                "Could not reach {} within {}s",
                cfg.describe_target(),
                cfg.connect_timeout_secs
            ),
        )),
    }
}

/// Does this statement start or end a transaction? Some(true) = opens, Some(false) = closes.
pub fn transaction_effect(sql: &str) -> Option<bool> {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, tail)| tail).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, tail)| tail).trim_start();
        } else {
            break;
        }
    }
    let mut words = rest
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_uppercase);
    match words.next().as_deref() {
        Some("BEGIN" | "START") => Some(true),
        Some("COMMIT" | "END") => Some(false),
        Some("ROLLBACK") => match words.next().as_deref() {
            Some("TO" | "SAVEPOINT") => None,
            _ => Some(false),
        },
        _ => None,
    }
}

fn quote_ident(dialect: Dialect, name: &str) -> String {
    match dialect {
        Dialect::Mysql | Dialect::Mariadb | Dialect::Clickhouse => {
            format!("`{}`", name.replace('`', "``"))
        }
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// The statement that makes `database` / `schema` the session's default, per dialect.
pub fn switch_statement(
    dialect: Dialect,
    database: Option<&str>,
    schema: Option<&str>,
) -> DriverResult<String> {
    match dialect {
        Dialect::Postgresql => match (database, schema) {
            (_, Some(schema)) => Ok(format!("SET search_path TO {}", quote_ident(dialect, schema))),
            (Some(_), None) => Err(DriverError::unsupported(
                "switching database in an open session (PostgreSQL needs a connection per database)",
            )),
            (None, None) => Err(DriverError::new(ErrorCode::Internal, "Nothing to switch to")),
        },
        Dialect::Mysql | Dialect::Mariadb | Dialect::Clickhouse => match database.or(schema) {
            Some(db) => Ok(format!("USE {}", quote_ident(dialect, db))),
            None => Err(DriverError::new(ErrorCode::Internal, "Nothing to switch to")),
        },
        Dialect::Duckdb => match (database, schema) {
            (Some(db), Some(schema)) => Ok(format!(
                "USE {}.{}",
                quote_ident(dialect, db),
                quote_ident(dialect, schema)
            )),
            (Some(only), None) | (None, Some(only)) => {
                Ok(format!("USE {}", quote_ident(dialect, only)))
            }
            (None, None) => Err(DriverError::new(ErrorCode::Internal, "Nothing to switch to")),
        },
        Dialect::Sqlite => Err(DriverError::unsupported("switching database or schema")),
    }
}

/// Run the connection's "run on connect" statements on a fresh session, discarding results.
async fn run_on_connect(session: &mut dyn Session, cfg: &ResolvedConfig) -> DriverResult<()> {
    for sql in cfg.on_connect.iter().filter(|s| !s.trim().is_empty()) {
        let (sink, mut rx) = ResultSink::channel(8);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let request = ExecRequest {
            sql: sql.clone(),
            page_size: 1,
            script: false,
            continue_on_error: false,
        };
        let result = session.execute(request, sink).await;
        let _ = drain.await;
        if let Err(e) = result {
            return Err(DriverError::new(
                e.code,
                format!("The statement run on connect failed: {}", e.message),
            )
            .with_detail(sql.clone()));
        }
    }
    Ok(())
}

impl SessionManager {
    pub fn new(registry: Arc<Registry>, ssh_env: SshEnv) -> Self {
        Self {
            registry,
            ssh_env,
            history: StdMutex::new(None),
            policies: StdMutex::new(HashMap::new()),
            tokens: StdMutex::new(Tokens::default()),
            inner: StdMutex::new(Inner::default()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Report every statement executed from a console to `sink` (query history).
    pub fn set_history_sink(&self, sink: Arc<dyn HistorySink>) {
        *self.history.lock().unwrap() = Some(sink);
    }

    fn new_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    fn connection(&self, id: &str) -> DriverResult<Arc<ConnectionEntry>> {
        self.inner
            .lock()
            .unwrap()
            .connections
            .get(id)
            .cloned()
            .ok_or_else(|| not_found("connection", id))
    }

    fn session(&self, id: &str) -> DriverResult<Arc<SessionEntry>> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| not_found("session", id))
    }

    /// Validate the transport options and, when configured, open the SSH tunnel. Returns the
    /// config drivers should connect with (pointing at the local forward) and the tunnel.
    async fn prepare(
        &self,
        cfg: &ResolvedConfig,
    ) -> DriverResult<(ResolvedConfig, Option<Arc<SshTunnel>>)> {
        tls::validate(&cfg.tls)?;
        let Some(ssh) = &cfg.ssh else {
            return Ok((cfg.clone(), None));
        };
        let Target::Network { host, port } = &cfg.target else {
            return Err(DriverError::new(
                ErrorCode::Unsupported,
                "An SSH tunnel needs a host and port to forward to",
            ));
        };
        let tunnel = SshTunnel::open(
            ssh,
            host,
            *port,
            self.ssh_env.clone(),
            Duration::from_secs(cfg.connect_timeout_secs.max(1)),
        )
        .await?;
        let mut effective = cfg.clone();
        effective.target = Target::Network {
            host: "127.0.0.1".to_string(),
            port: tunnel.local_port(),
        };
        effective.ssh = None;
        Ok((effective, Some(Arc::new(tunnel))))
    }

    /// Connect without saving anything: round-trip, server version, timing.
    pub async fn test_connection(&self, cfg: &ResolvedConfig) -> DriverResult<ServerInfo> {
        let driver = self.registry.get(&cfg.driver)?;
        let (effective, _tunnel) = self.prepare(cfg).await?;
        with_connect_timeout(&effective, driver.test(&effective)).await
    }

    /// Register a connection and open its metadata pool.
    pub async fn connect(&self, connection_id: &str, cfg: ResolvedConfig) -> DriverResult<()> {
        let driver = self.registry.get(&cfg.driver)?;
        let (cfg, tunnel) = self.prepare(&cfg).await?;
        let pool = with_connect_timeout(&cfg, driver.open_meta_pool(&cfg)).await?;
        let entry = Arc::new(ConnectionEntry {
            driver,
            cfg,
            pool,
            tunnel,
        });
        let previous = self
            .inner
            .lock()
            .unwrap()
            .connections
            .insert(connection_id.to_string(), entry);
        if previous.is_some() {
            self.close_sessions_of(connection_id).await;
        }
        Ok(())
    }

    /// `via SSH <host>` for a tunnelled connection.
    pub fn connection_transport(&self, connection_id: &str) -> Option<String> {
        let entry = self.connection(connection_id).ok()?;
        entry.tunnel.as_ref().map(|t| t.via().to_string())
    }

    /// Server product and version of a connected connection.
    pub async fn connection_server(&self, connection_id: &str) -> DriverResult<ServerInfo> {
        let entry = self.connection(connection_id)?;
        with_connect_timeout(&entry.cfg, entry.driver.test(&entry.cfg)).await
    }

    pub fn is_connected(&self, connection_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .connections
            .contains_key(connection_id)
    }

    /// Is any session of any connection inside an uncommitted transaction? Quitting asks first.
    pub fn any_in_transaction(&self) -> bool {
        let ids: Vec<ConnectionId> = self
            .inner
            .lock()
            .unwrap()
            .connections
            .keys()
            .cloned()
            .collect();
        ids.iter()
            .any(|id| !self.sessions_in_transaction(id).is_empty())
    }

    /// Sessions of the connection with an uncommitted transaction (a busy session counts).
    pub fn sessions_in_transaction(&self, connection_id: &str) -> Vec<SessionId> {
        let entries: Vec<(SessionId, Arc<SessionEntry>)> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .iter()
            .filter(|(_, s)| s.connection_id == connection_id)
            .map(|(id, s)| (id.clone(), s.clone()))
            .collect();
        entries
            .into_iter()
            .filter(|(_, s)| {
                s.state
                    .try_lock()
                    .map(|st| st.in_transaction)
                    .unwrap_or(true)
            })
            .map(|(id, _)| id)
            .collect()
    }

    /// Make `database` / `schema` the session's default. Returns the statement that was run.
    pub async fn switch_namespace(
        &self,
        session_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> DriverResult<String> {
        let entry = self.session(session_id)?;
        let dialect = entry
            .connection
            .driver
            .meta()
            .dialect
            .ok_or_else(|| DriverError::unsupported("switching database or schema"))?;
        let sql = switch_statement(dialect, database, schema)?;
        let emit: Emit = Arc::new(|_| true);
        self.execute_inner(
            session_id,
            ExecRequest {
                sql: sql.clone(),
                page_size: 1,
                script: false,
                continue_on_error: false,
            },
            None,
            emit,
            false,
        )
        .await?;
        Ok(sql)
    }

    /// COMMIT or ROLLBACK every open transaction of the connection.
    pub async fn end_transactions(&self, connection_id: &str, commit: bool) -> DriverResult<()> {
        let sql = if commit { "COMMIT" } else { "ROLLBACK" };
        for id in self.sessions_in_transaction(connection_id) {
            let emit: Emit = Arc::new(|_| true);
            self.execute_inner(
                &id,
                ExecRequest {
                    sql: sql.to_string(),
                    page_size: 1,
                    script: false,
                    continue_on_error: false,
                },
                None,
                emit,
                false,
            )
            .await?;
        }
        Ok(())
    }

    /// Close every session of the connection and drop its pool.
    pub async fn disconnect(&self, connection_id: &str) {
        self.close_sessions_of(connection_id).await;
        self.inner.lock().unwrap().connections.remove(connection_id);
    }

    async fn close_sessions_of(&self, connection_id: &str) {
        let ids: Vec<SessionId> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .iter()
            .filter(|(_, s)| s.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let _ = self.close_session(&id).await;
        }
    }

    /// Open a dedicated session (one physical connection) for an editor tab.
    pub async fn open_session(&self, connection_id: &str) -> DriverResult<SessionOpened> {
        let connection = self.connection(connection_id)?;
        let mut session =
            with_connect_timeout(&connection.cfg, connection.driver.open(&connection.cfg)).await?;
        if let Err(e) = run_on_connect(session.as_mut(), &connection.cfg).await {
            let _ = session.close().await;
            return Err(e);
        }
        let server = session.server_info();
        let id = self.new_id("session");
        let entry = Arc::new(SessionEntry {
            connection_id: connection_id.to_string(),
            cancel: StdMutex::new(session.cancel_handle()),
            server: StdMutex::new(server.clone()),
            state: Mutex::new(SessionState {
                session: Some(session),
                in_transaction: false,
                read_only: connection.cfg.read_only,
            }),
            last_used: StdMutex::new(Instant::now()),
            connection,
        });
        let transport = entry
            .connection
            .tunnel
            .as_ref()
            .map(|t| t.via().to_string());
        self.inner
            .lock()
            .unwrap()
            .sessions
            .insert(id.clone(), entry);
        Ok(SessionOpened {
            session_id: id,
            server,
            transport,
        })
    }

    pub async fn close_session(&self, session_id: &str) -> DriverResult<()> {
        let entry = self.inner.lock().unwrap().sessions.remove(session_id);
        let Some(entry) = entry else { return Ok(()) };
        // Cancel anything running so we can take the lock promptly.
        let handle = entry.cancel.lock().unwrap().clone();
        let _ = handle.cancel().await;
        let mut st = entry.state.lock().await;
        match st.session.take() {
            Some(s) => s.close().await,
            None => Ok(()),
        }
    }

    pub fn session_count(&self) -> usize {
        self.inner.lock().unwrap().sessions.len()
    }

    /// Close sessions idle for longer than `max_idle` (skipping any that are executing).
    pub async fn sweep_idle(&self, max_idle: Duration) -> usize {
        let now = Instant::now();
        let stale: Vec<SessionId> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .iter()
            .filter(|(_, s)| {
                now.duration_since(*s.last_used.lock().unwrap()) >= max_idle
                    && s.state.try_lock().is_ok()
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &stale {
            let _ = self.close_session(id).await;
        }
        stale.len()
    }

    fn touch(entry: &SessionEntry) {
        *entry.last_used.lock().unwrap() = Instant::now();
    }

    /// Re-open a lost session. Reports a rolled-back transaction.
    async fn reconnect(
        entry: &SessionEntry,
        st: &mut SessionState,
        emit: &Emit,
    ) -> DriverResult<()> {
        let conn = &entry.connection;
        let mut session = with_connect_timeout(&conn.cfg, conn.driver.open(&conn.cfg)).await?;
        if let Err(e) = run_on_connect(session.as_mut(), &conn.cfg).await {
            let _ = session.close().await;
            return Err(e);
        }
        // A session the user switched to read-write stays that way across a reconnect.
        if st.read_only != conn.cfg.read_only {
            if let Err(e) = session.set_read_only(st.read_only).await {
                let _ = session.close().await;
                return Err(e);
            }
        }
        *entry.cancel.lock().unwrap() = session.cancel_handle();
        *entry.server.lock().unwrap() = session.server_info();
        st.session = Some(session);
        let message = if st.in_transaction {
            "The connection was lost and has been re-established. The open transaction was rolled back."
        } else {
            "The connection was lost and has been re-established."
        };
        st.in_transaction = false;
        emit(ResultEvent::Notice {
            message: message.to_string(),
        });
        Ok(())
    }

    /// Execute a statement or script on the session, streaming events through `emit`.
    ///
    /// Returns the summary of the last statement that completed, or the error that stopped the
    /// run (the error is also emitted as an event).
    /// Run a statement or script from a console; each statement lands in the query history.
    pub async fn execute(
        &self,
        session_id: &str,
        req: ExecRequest,
        emit: Emit,
    ) -> DriverResult<Option<ExecSummary>> {
        self.execute_inner(session_id, req, None, emit, true).await
    }

    /// Like [`Self::execute`], presenting the token a confirmation dialog was answered with.
    pub async fn execute_confirmed(
        &self,
        session_id: &str,
        req: ExecRequest,
        token: Option<String>,
        emit: Emit,
    ) -> DriverResult<Option<ExecSummary>> {
        self.execute_inner(session_id, req, token, emit, true).await
    }

    /// Like [`Self::execute`] but not recorded in the query history (exports re-run queries).
    pub async fn execute_unrecorded(
        &self,
        session_id: &str,
        req: ExecRequest,
        emit: Emit,
    ) -> DriverResult<Option<ExecSummary>> {
        self.execute_inner(session_id, req, None, emit, false).await
    }

    async fn execute_inner(
        &self,
        session_id: &str,
        req: ExecRequest,
        token: Option<String>,
        emit: Emit,
        record: bool,
    ) -> DriverResult<Option<ExecSummary>> {
        let sink = if record {
            self.history.lock().unwrap().clone()
        } else {
            None
        };
        let entry = self.session(session_id)?;
        let mut st = entry.state.lock().await;
        Self::touch(&entry);

        let dialect = entry.connection.driver.meta().dialect;
        // The guard has the last word, whatever the UI did before calling.
        if let Err(e) = self.enforce(
            session_id,
            &entry,
            st.read_only,
            &req.sql,
            req.script,
            token.as_deref(),
        ) {
            emit(ResultEvent::Error {
                result_id: None,
                statement: 0,
                error: e.clone(),
            });
            return Err(e);
        }
        let statements: Vec<String> = if req.script {
            split(&req.sql, dialect)
                .into_iter()
                .map(|s| s.text)
                .collect()
        } else if req.sql.trim().is_empty() {
            Vec::new()
        } else {
            vec![req.sql.clone()]
        };

        let timeout = entry
            .connection
            .cfg
            .query_timeout_secs
            .map(Duration::from_secs);
        let mut last = None;
        let mut first_error: Option<DriverError> = None;

        for (index, sql) in statements.into_iter().enumerate() {
            if st.session.is_none() {
                if let Err(e) = Self::reconnect(&entry, &mut st, &emit).await {
                    emit(ResultEvent::Error {
                        result_id: None,
                        statement: index,
                        error: e.clone(),
                    });
                    first_error.get_or_insert(e);
                    break;
                }
            }

            let cancel = entry.cancel.lock().unwrap().clone();
            let (result_sink, rx) = ResultSink::channel(32);
            // Count the rows a statement streams, for its history entry.
            let streamed = Arc::new(AtomicU64::new(0));
            let counting: Emit = {
                let emit = emit.clone();
                let streamed = streamed.clone();
                Arc::new(move |event| {
                    if let ResultEvent::Rows { rows, .. } = &event {
                        streamed.fetch_add(rows.len() as u64, Ordering::Relaxed);
                    }
                    emit(event)
                })
            };
            let pump = tokio::spawn(pump(rx, counting, index));
            let started_at = now_ms();
            let timer = Instant::now();
            let single = ExecRequest {
                sql: sql.clone(),
                page_size: req.page_size,
                script: false,
                continue_on_error: false,
            };
            let session = st.session.as_mut().expect("session present");
            let result =
                run_with_timeout(session.as_mut(), single, result_sink, &cancel, timeout).await;
            let _ = pump.await;
            if let Some(history) = &sink {
                // Transaction control is the console's own plumbing, not something to look up later.
                if transaction_effect(&sql).is_none() {
                    let (outcome, rows) = match &result {
                        Ok(s) => (
                            Outcome::Ok,
                            Some(match s.rows_affected {
                                Some(n) => n as i64,
                                None => streamed.load(Ordering::Relaxed) as i64,
                            }),
                        ),
                        Err(e) if e.code == ErrorCode::Cancelled => (Outcome::Cancelled, None),
                        Err(_) => (Outcome::Error, None),
                    };
                    history.record(NewEntry {
                        connection_id: entry.connection_id.clone(),
                        database: entry.connection.cfg.database.clone().unwrap_or_default(),
                        sql: sql.clone(),
                        started_at,
                        duration_ms: match &result {
                            Ok(s) => s.elapsed_ms as i64,
                            Err(_) => timer.elapsed().as_millis() as i64,
                        },
                        rows,
                        outcome,
                    });
                }
            }

            match result {
                Ok(summary) => {
                    if let Some(open) = transaction_effect(&sql) {
                        st.in_transaction = open;
                    }
                    last = Some(summary);
                }
                Err(error) => {
                    match error.code {
                        ErrorCode::Cancelled => {
                            emit(ResultEvent::Cancelled { result_id: None });
                        }
                        _ => {
                            emit(ResultEvent::Error {
                                result_id: None,
                                statement: index,
                                error: error.clone(),
                            });
                        }
                    }
                    let stop = match error.code {
                        ErrorCode::ConnectionLost => {
                            st.session = None;
                            true
                        }
                        ErrorCode::Cancelled | ErrorCode::Timeout => true,
                        _ => !req.continue_on_error,
                    };
                    first_error.get_or_insert(error);
                    if stop {
                        break;
                    }
                }
            }
        }

        match (last, first_error) {
            (_, Some(e)) if !req.continue_on_error || last_is_fatal(&e) => Err(e),
            (last, _) => Ok(last),
        }
    }

    pub async fn fetch_more(
        &self,
        session_id: &str,
        result_id: ResultId,
        n: usize,
        emit: Emit,
    ) -> DriverResult<bool> {
        let entry = self.session(session_id)?;
        let mut st = entry.state.lock().await;
        Self::touch(&entry);
        let session = st.session.as_mut().ok_or_else(|| {
            DriverError::new(ErrorCode::ConnectionLost, "The session is disconnected")
        })?;
        let (sink, rx) = ResultSink::channel(32);
        let pump = tokio::spawn(pump(rx, emit, 0));
        let r = session.fetch_more(result_id, n, sink).await;
        let _ = pump.await;
        r
    }

    /// Cancel the statement running on the session. Never waits for the session lock.
    pub async fn cancel(&self, session_id: &str) -> DriverResult<()> {
        let entry = self.session(session_id)?;
        let handle = entry.cancel.lock().unwrap().clone();
        handle.cancel().await
    }

    pub async fn fetch_full_value(
        &self,
        session_id: &str,
        req: FullValueRequest,
    ) -> DriverResult<Value> {
        let entry = self.session(session_id)?;
        let mut st = entry.state.lock().await;
        Self::touch(&entry);
        let session = st.session.as_mut().ok_or_else(|| {
            DriverError::new(ErrorCode::ConnectionLost, "The session is disconnected")
        })?;
        session.fetch_full_value(req).await
    }

    pub fn server_info(&self, session_id: &str) -> DriverResult<ServerInfo> {
        Ok(self.session(session_id)?.server.lock().unwrap().clone())
    }

    /// Children of `path`, loaded through the metadata pool (never the tab's session).
    pub async fn introspect(
        &self,
        connection_id: &str,
        path: &NodePath,
    ) -> DriverResult<Vec<TreeNode>> {
        let c = self.connection(connection_id)?;
        c.driver.introspect(&c.pool, path).await
    }

    /// The `CREATE` statement for an object, loaded through the metadata pool.
    pub async fn ddl(&self, connection_id: &str, path: &NodePath) -> DriverResult<String> {
        let c = self.connection(connection_id)?;
        c.driver.ddl(&c.pool, path).await
    }

    /// The driver id (`postgres`, …) of a connected connection.
    /// Run staged table edits on the tab's session as one unit (see [`crate::changes::apply`]).
    pub async fn apply_changes(
        &self,
        session_id: &str,
        statements: &[crate::changes::Statement],
    ) -> DriverResult<crate::changes::ApplyOutcome> {
        self.apply_changes_confirmed(session_id, statements, None)
            .await
    }

    /// The text a confirmation of these statements is bound to.
    pub fn changes_text(statements: &[crate::changes::Statement]) -> String {
        statements
            .iter()
            .map(|s| format!("{};", s.display))
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub async fn apply_changes_confirmed(
        &self,
        session_id: &str,
        statements: &[crate::changes::Statement],
        token: Option<String>,
    ) -> DriverResult<crate::changes::ApplyOutcome> {
        let entry = self.session(session_id)?;
        let mut st = entry.state.lock().await;
        Self::touch(&entry);
        self.enforce(
            session_id,
            &entry,
            st.read_only,
            &Self::changes_text(statements),
            true,
            token.as_deref(),
        )?;
        let in_txn = st.in_transaction;
        let driver = entry.connection.driver.meta().id.to_string();
        let session = st.session.as_mut().ok_or_else(|| {
            DriverError::new(
                ErrorCode::ConnectionLost,
                "The connection was lost. Run the query again to reconnect, then retry.",
            )
        })?;
        crate::changes::apply(session.as_mut(), &driver, in_txn, statements).await
    }

    pub fn driver_id(&self, connection_id: &str) -> DriverResult<String> {
        Ok(self.connection(connection_id)?.driver.meta().id.to_string())
    }

    /// Columns, indexes, foreign keys and statistics of a table, through the metadata pool.
    pub async fn table_meta(
        &self,
        connection_id: &str,
        path: &NodePath,
    ) -> DriverResult<crate::drivers::table_meta::TableMeta> {
        let c = self.connection(connection_id)?;
        c.driver.table_meta(&c.pool, path).await
    }

    /// Exact row count of a table or view, through the metadata pool.
    pub async fn count_rows(&self, connection_id: &str, path: &NodePath) -> DriverResult<i64> {
        let c = self.connection(connection_id)?;
        c.driver.count_rows(&c.pool, path).await
    }

    pub async fn completion_snapshot(
        &self,
        connection_id: &str,
        db: &str,
    ) -> DriverResult<SchemaSnapshot> {
        let c = self.connection(connection_id)?;
        c.driver.completion_snapshot(&c.pool, db).await
    }
}

/// Milliseconds since the epoch.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A statement that errored is only fatal to the whole run when it stopped it.
fn last_is_fatal(e: &DriverError) -> bool {
    matches!(
        e.code,
        ErrorCode::ConnectionLost | ErrorCode::Cancelled | ErrorCode::Timeout
    )
}

/// Forward driver events to the frontend, tagging them with the statement index. Stops when the
/// receiver on the other side is gone, which drops the channel and makes the driver stop too.
async fn pump(mut rx: tokio::sync::mpsc::Receiver<ResultEvent>, emit: Emit, statement: usize) {
    while let Some(event) = rx.recv().await {
        let event = match event {
            ResultEvent::Columns {
                result_id, columns, ..
            } => ResultEvent::Columns {
                result_id,
                statement,
                columns,
            },
            other => other,
        };
        if !emit(event) {
            break;
        }
    }
}

/// Run one statement, cancelling it through the session's cancel handle when `timeout` elapses.
async fn run_with_timeout(
    session: &mut dyn Session,
    req: ExecRequest,
    sink: ResultSink,
    cancel: &CancelHandle,
    timeout: Option<Duration>,
) -> DriverResult<ExecSummary> {
    let Some(limit) = timeout else {
        return session.execute(req, sink).await;
    };
    let exec = session.execute(req, sink);
    tokio::pin!(exec);
    tokio::select! {
        r = &mut exec => r,
        _ = tokio::time::sleep(limit) => {
            let _ = cancel.cancel().await;
            match exec.await {
                Err(e) if e.code == ErrorCode::Cancelled => Err(DriverError::new(
                    ErrorCode::Timeout,
                    format!("The statement was cancelled after exceeding the {}s query timeout", limit.as_secs()),
                )),
                other => other,
            }
        }
    }
}

#[cfg(test)]
mod tests;

// ---- production safeguards --------------------------------------------------------------------

/// One statement in a [`GuardReport`].
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct GuardStatement {
    pub text: String,
    pub class: StatementClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub danger: Option<String>,
    /// Rows an UPDATE / DELETE is estimated to touch, when the database answered quickly.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub estimate: Option<i64>,
}

/// What the guard decided about some SQL, with what a confirmation dialog needs to show.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct GuardReport {
    pub decision: Decision,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
    pub connection: String,
    pub environment: String,
    pub statements: Vec<GuardStatement>,
    /// Present when the decision asks for a confirmation: send it back with the statements.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub token: Option<String>,
    /// The text to type (the connection's name) for a typed confirmation.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub typed: Option<String>,
}

/// An EXPLAIN that takes longer than this is abandoned: the estimate is a courtesy.
const ESTIMATE_BUDGET: Duration = Duration::from_millis(300);

impl SessionManager {
    /// Tell the guard what a connection's safeguards are (set when it connects).
    pub fn set_policy(&self, connection_id: &str, policy: Policy) {
        self.policies
            .lock()
            .unwrap()
            .insert(connection_id.to_string(), policy);
    }

    fn policy_of(&self, connection_id: &str) -> Policy {
        self.policies
            .lock()
            .unwrap()
            .get(connection_id)
            .cloned()
            .unwrap_or_default()
    }

    fn classify_for(&self, entry: &SessionEntry, sql: &str, script: bool) -> Vec<StatementInfo> {
        let driver = entry.connection.driver.meta();
        classify(sql, driver.id, driver.dialect, script)
    }

    /// Refuse what the session's state and the connection's safeguards don't allow.
    fn enforce(
        &self,
        session_id: &str,
        entry: &SessionEntry,
        read_only: bool,
        sql: &str,
        script: bool,
        token: Option<&str>,
    ) -> DriverResult<()> {
        let statements = self.classify_for(entry, sql, script);
        let policy = self.policy_of(&entry.connection_id);
        match decide(&statements, read_only, &policy) {
            Decision::Allow => Ok(()),
            Decision::Block => Err(DriverError::new(ErrorCode::ReadOnly, READ_ONLY_REASON)),
            Decision::Confirm | Decision::TypedConfirm => {
                let confirmed = token.is_some_and(|t| {
                    self.tokens
                        .lock()
                        .unwrap()
                        .consume(t, session_id, &bound_text(&statements))
                });
                if confirmed {
                    Ok(())
                } else {
                    Err(DriverError::new(
                        ErrorCode::ConfirmationRequired,
                        "This statement needs your confirmation first",
                    ))
                }
            }
        }
    }

    /// Whether the session refuses writes right now.
    pub async fn session_read_only(&self, session_id: &str) -> DriverResult<bool> {
        let entry = self.session(session_id)?;
        let st = entry.state.lock().await;
        Ok(st.read_only)
    }

    /// Switch one session between read-only and read-write. Other sessions are untouched, and a
    /// closed session forgets the choice.
    pub async fn set_session_read_only(
        &self,
        session_id: &str,
        read_only: bool,
    ) -> DriverResult<()> {
        let entry = self.session(session_id)?;
        let mut st = entry.state.lock().await;
        Self::touch(&entry);
        if let Some(session) = st.session.as_mut() {
            session.set_read_only(read_only).await?;
        }
        // With no live session the next reconnect applies the new state (see `reconnect`).
        st.read_only = read_only;
        Ok(())
    }

    /// Decide about `sql` before it is sent: allow, block, or ask. For a question, the report
    /// carries what to show and a token that answers it once.
    pub async fn safety_check(
        &self,
        session_id: &str,
        sql: &str,
        script: bool,
    ) -> DriverResult<GuardReport> {
        let entry = self.session(session_id)?;
        let read_only = entry.state.lock().await.read_only;
        let statements = self.classify_for(&entry, sql, script);
        let policy = self.policy_of(&entry.connection_id);
        let decision = decide(&statements, read_only, &policy);

        let mut shown = Vec::new();
        for s in &statements {
            let estimate = if decision == Decision::Confirm || decision == Decision::TypedConfirm {
                self.estimate_rows(session_id, &entry, s).await
            } else {
                None
            };
            shown.push(GuardStatement {
                text: s.text.clone(),
                class: s.class,
                danger: s.danger.clone(),
                estimate,
            });
        }
        let ask = matches!(decision, Decision::Confirm | Decision::TypedConfirm);
        let token = ask.then(|| {
            self.tokens
                .lock()
                .unwrap()
                .mint(session_id, bound_text(&statements))
        });
        Ok(GuardReport {
            decision,
            reason: (decision == Decision::Block).then(|| READ_ONLY_REASON.to_string()),
            connection: policy.name.clone(),
            environment: policy.environment.clone(),
            statements: shown,
            token,
            typed: (decision == Decision::TypedConfirm).then(|| policy.name.clone()),
        })
    }

    /// `EXPLAIN` an UPDATE / DELETE and read the row estimate, within [`ESTIMATE_BUDGET`].
    async fn estimate_rows(
        &self,
        session_id: &str,
        entry: &Arc<SessionEntry>,
        s: &StatementInfo,
    ) -> Option<i64> {
        let head = s.text.trim_start().to_ascii_uppercase();
        if !(head.starts_with("UPDATE") || head.starts_with("DELETE")) {
            return None;
        }
        let driver = entry.connection.driver.meta().id;
        // EXPLAIN the SELECT that finds the same rows: MySQL can't prepare EXPLAIN UPDATE, and
        // the scan's estimate is the number that matters either way.
        let probe = crate::safety::classify::estimate_probe(&s.text, driver)?;
        let sql = match driver {
            "postgres" => format!("EXPLAIN (FORMAT JSON) {probe}"),
            // MySQL only returns EXPLAIN's rows over the text protocol as JSON.
            "mysql" => format!("EXPLAIN FORMAT=JSON {probe}"),
            "mariadb" => format!("EXPLAIN {probe}"),
            _ => return None,
        };
        let seen: Arc<StdMutex<Vec<Vec<Value>>>> = Arc::default();
        let columns: Arc<StdMutex<Vec<String>>> = Arc::default();
        let emit: Emit = {
            let seen = seen.clone();
            let columns = columns.clone();
            Arc::new(move |event| {
                match event {
                    ResultEvent::Columns { columns: c, .. } => {
                        *columns.lock().unwrap() = c.into_iter().map(|c| c.name).collect();
                    }
                    ResultEvent::Rows { rows, .. } => seen.lock().unwrap().extend(rows),
                    _ => {}
                }
                true
            })
        };
        let req = ExecRequest {
            sql,
            page_size: 20,
            script: false,
            continue_on_error: false,
        };
        let run = self.execute_inner(session_id, req, None, emit, false);
        tokio::pin!(run);
        let finished = tokio::select! {
            r = &mut run => r.is_ok(),
            _ = tokio::time::sleep(ESTIMATE_BUDGET) => {
                let cancel = entry.cancel.lock().unwrap().clone();
                let _ = cancel.cancel().await;
                let _ = run.await;
                false
            }
        };
        if !finished {
            return None;
        }
        let rows = seen.lock().unwrap().clone();
        let first = rows.first()?;
        if driver == "mysql" {
            let text = match first.first()? {
                Value::Json { value } => value.to_string(),
                Value::Text { value, .. } => value.clone(),
                _ => return None,
            };
            let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
            first_number(&parsed, "rows_examined_per_scan")
        } else if driver == "postgres" {
            let text = match first.first()? {
                Value::Json { value } => value.to_string(),
                Value::Text { value, .. } => value.clone(),
                _ => return None,
            };
            let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
            let mut plan = parsed.get(0)?.get("Plan")?;
            // The top node of an UPDATE / DELETE is ModifyTable; the rows live in the scan below.
            if plan.get("Node Type")?.as_str() == Some("ModifyTable") {
                plan = plan.get("Plans")?.get(0)?;
            }
            plan.get("Plan Rows")?.as_f64().map(|n| n.round() as i64)
        } else {
            let names = columns.lock().unwrap().clone();
            let at = names.iter().position(|n| n.eq_ignore_ascii_case("rows"))?;
            match first.get(at)? {
                Value::Int { value } => Some(*value),
                Value::Text { value, .. } => value.parse().ok(),
                _ => None,
            }
        }
    }
}

/// The first number stored under `key` anywhere in a JSON tree.
fn first_number(v: &serde_json::Value, key: &str) -> Option<i64> {
    match v {
        serde_json::Value::Object(map) => map
            .get(key)
            .and_then(|n| n.as_f64())
            .map(|n| n.round() as i64)
            .or_else(|| map.values().find_map(|c| first_number(c, key))),
        serde_json::Value::Array(items) => items.iter().find_map(|c| first_number(c, key)),
        _ => None,
    }
}
