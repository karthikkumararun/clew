use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Notify;

use super::*;
use crate::drivers::{
    CancelFn, Capabilities, ColumnMeta, Dialect, DriverFamily, DriverMeta, FormKind, Target,
    ValueKind,
};

// A scripted driver. Statement text selects the behaviour:
//   "SELECT n"  columns + 1 row + done        "SLEEP"  blocks until cancelled
//   "DIE"       connection_lost               "FAIL"   query_failed
//   anything else (BEGIN, COMMIT, ...)        done with rows_affected = 0

const META: DriverMeta = DriverMeta {
    id: "fake",
    name: "Fake",
    badge: "FK",
    color_token: "--drv-sqlite",
    family: DriverFamily::Sql,
    default_port: None,
    form: FormKind::Network,
    dialect: Some(Dialect::Postgresql),
    capabilities: Capabilities {
        transactions: true,
        cancel: true,
        explain: false,
        editable_results: false,
        schemas: true,
        multiple_databases: false,
    },
};

type Statements = Arc<StdMutex<Vec<String>>>;

struct FakeDriver {
    opens: Arc<AtomicUsize>,
    open_delay: Duration,
    record: Statements,
}

struct FakeSession {
    record: Statements,
    next_result: ResultId,
    cancel: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

struct FakeCancel {
    notify: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

#[async_trait]
impl CancelFn for FakeCancel {
    async fn cancel(&self) -> DriverResult<()> {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
        Ok(())
    }
}

#[async_trait]
impl Driver for FakeDriver {
    fn meta(&self) -> &DriverMeta {
        &META
    }
    async fn test(&self, _: &ResolvedConfig) -> DriverResult<ServerInfo> {
        tokio::time::sleep(self.open_delay).await;
        Ok(ServerInfo {
            product: "Fake".into(),
            version: "1.0".into(),
            round_trip_ms: 1,
        })
    }
    async fn open(&self, _: &ResolvedConfig) -> DriverResult<Box<dyn Session>> {
        tokio::time::sleep(self.open_delay).await;
        self.opens.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakeSession {
            record: self.record.clone(),
            next_result: 1,
            cancel: Arc::new(Notify::new()),
            cancelled: Arc::new(AtomicBool::new(false)),
        }))
    }
    async fn open_meta_pool(&self, _: &ResolvedConfig) -> DriverResult<MetaPool> {
        Ok(MetaPool::new(()))
    }
    async fn introspect(&self, _: &MetaPool, path: &NodePath) -> DriverResult<Vec<TreeNode>> {
        Ok(vec![TreeNode::new(
            path,
            crate::drivers::introspect::NodeKind::Database,
            "db",
            true,
        )])
    }
    async fn completion_snapshot(&self, _: &MetaPool, _: &str) -> DriverResult<SchemaSnapshot> {
        Ok(SchemaSnapshot::default())
    }
}

#[async_trait]
impl Session for FakeSession {
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        self.record.lock().unwrap().push(req.sql.clone());
        self.cancelled.store(false, Ordering::SeqCst);
        let id = self.next_result;
        self.next_result += 1;
        match req.sql.as_str() {
            "SLEEP" => {
                let waiting = self.cancel.notified();
                tokio::pin!(waiting);
                waiting.as_mut().enable();
                if !self.cancelled.load(Ordering::SeqCst) {
                    tokio::select! {
                        _ = &mut waiting => {}
                        _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                    }
                }
                Err(DriverError::new(ErrorCode::Cancelled, "cancelled"))
            }
            "PAUSE" => {
                tokio::time::sleep(Duration::from_millis(150)).await;
                Ok(ExecSummary {
                    rows_affected: Some(0),
                    elapsed_ms: 150,
                    has_more: false,
                })
            }
            "DIE" => Err(DriverError::new(
                ErrorCode::ConnectionLost,
                "server closed the connection",
            )),
            "FAIL" => Err(DriverError::new(ErrorCode::QueryFailed, "boom").with_position(7)),
            sql if sql.starts_with("SELECT") => {
                sink.send(ResultEvent::Columns {
                    result_id: id,
                    statement: 0,
                    columns: vec![ColumnMeta {
                        name: "n".into(),
                        type_name: "int8".into(),
                        kind: ValueKind::Int,
                        nullable: Some(false),
                        source_table: None,
                        source_column: None,
                        source_schema: None,
                        source_updatable: None,
                    }],
                })
                .await;
                sink.send(ResultEvent::Rows {
                    result_id: id,
                    rows: vec![vec![Value::from_i64(1)]],
                })
                .await;
                let summary = ExecSummary {
                    rows_affected: None,
                    elapsed_ms: 1,
                    has_more: false,
                };
                sink.send(ResultEvent::Done {
                    result_id: id,
                    summary: summary.clone(),
                })
                .await;
                Ok(summary)
            }
            _ => {
                let summary = ExecSummary {
                    rows_affected: Some(0),
                    elapsed_ms: 1,
                    has_more: false,
                };
                sink.send(ResultEvent::Done {
                    result_id: id,
                    summary: summary.clone(),
                })
                .await;
                Ok(summary)
            }
        }
    }
    async fn fetch_more(&mut self, _: ResultId, _: usize, _: ResultSink) -> DriverResult<bool> {
        Ok(false)
    }
    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::new(FakeCancel {
            notify: self.cancel.clone(),
            cancelled: self.cancelled.clone(),
        })
    }
    fn server_info(&self) -> ServerInfo {
        ServerInfo {
            product: "Fake".into(),
            version: "1.0".into(),
            round_trip_ms: 0,
        }
    }
    fn backend_id(&self) -> Option<String> {
        Some("4242".into())
    }
    fn supported_isolation_levels(&self) -> &'static [&'static str] {
        &["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]
    }
    async fn isolation_level(&mut self) -> DriverResult<Option<String>> {
        Ok(Some("READ COMMITTED".into()))
    }
    async fn set_isolation(&mut self, level: &str) -> DriverResult<()> {
        self.record
            .lock()
            .unwrap()
            .push(format!("SET ISOLATION {level}"));
        Ok(())
    }
    async fn close(self: Box<Self>) -> DriverResult<()> {
        Ok(())
    }
}

fn ssh_env() -> SshEnv {
    SshEnv {
        known_hosts: crate::transport::hostkey::KnownHosts {
            user_file: None,
            app_file: std::env::temp_dir().join("clew-test-known-hosts"),
        },
        prompter: Arc::new(crate::transport::hostkey::RejectUnknown),
    }
}

fn cfg(query_timeout_secs: Option<u64>) -> ResolvedConfig {
    ResolvedConfig {
        driver: "fake".into(),
        target: Target::Network {
            host: "db.internal".into(),
            port: 5432,
        },
        user: None,
        password: None,
        database: None,
        ssh: None,
        tls: Default::default(),
        connect_timeout_secs: 10,
        query_timeout_secs,
        read_only: false,
        options: Default::default(),
        on_connect: vec![],
        isolation: None,
    }
}

struct Harness {
    mgr: Arc<SessionManager>,
    opens: Arc<AtomicUsize>,
    session: SessionId,
}

async fn harness(query_timeout_secs: Option<u64>) -> Harness {
    harness_with_delay(query_timeout_secs, Duration::ZERO).await
}

async fn harness_with_delay(query_timeout_secs: Option<u64>, open_delay: Duration) -> Harness {
    let opens = Arc::new(AtomicUsize::new(0));
    let mut registry = Registry::new();
    registry.register(Arc::new(FakeDriver {
        opens: opens.clone(),
        open_delay,
        record: Default::default(),
    }));
    let mgr = Arc::new(SessionManager::new(Arc::new(registry), ssh_env()));
    mgr.connect("c1", cfg(query_timeout_secs)).await.unwrap();
    let session = mgr.open_session("c1").await.unwrap().session_id;
    Harness {
        mgr,
        opens,
        session,
    }
}

fn manager_recording() -> (Arc<SessionManager>, Statements) {
    let record: Statements = Default::default();
    let mut registry = Registry::new();
    registry.register(Arc::new(FakeDriver {
        opens: Arc::new(AtomicUsize::new(0)),
        open_delay: Duration::ZERO,
        record: record.clone(),
    }));
    (
        Arc::new(SessionManager::new(Arc::new(registry), ssh_env())),
        record,
    )
}

type Log = Arc<StdMutex<Vec<ResultEvent>>>;

fn collector() -> (Emit, Log) {
    let log: Log = Arc::new(StdMutex::new(Vec::new()));
    let sink = log.clone();
    (
        Arc::new(move |e| {
            sink.lock().unwrap().push(e);
            true
        }),
        log,
    )
}

fn req(sql: &str) -> ExecRequest {
    ExecRequest {
        sql: sql.into(),
        page_size: 500,
        script: false,
        continue_on_error: false,
    }
}

fn script(sql: &str, continue_on_error: bool) -> ExecRequest {
    ExecRequest {
        sql: sql.into(),
        page_size: 500,
        script: true,
        continue_on_error,
    }
}

fn kinds(log: &Log) -> Vec<String> {
    log.lock()
        .unwrap()
        .iter()
        .map(|e| match e {
            ResultEvent::Columns { statement, .. } => format!("columns#{statement}"),
            ResultEvent::Rows { .. } => "rows".into(),
            ResultEvent::Done { .. } => "done".into(),
            ResultEvent::Error {
                statement, error, ..
            } => {
                format!("error#{statement}:{}", error.code.as_str())
            }
            ResultEvent::Cancelled { .. } => "cancelled".into(),
            ResultEvent::Notice { .. } => "notice".into(),
            ResultEvent::Documents { .. } => "documents".into(),
        })
        .collect()
}

// ---- execute + streaming ---------------------------------------------------------------------

#[tokio::test]
async fn streams_columns_rows_done() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let summary = h
        .mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.rows_affected, None);
    assert_eq!(kinds(&log), ["columns#0", "rows", "done"]);
}

/// (spec: driver-framework › Statement without a result set)
#[tokio::test]
async fn statement_without_result_set_reports_rows_affected() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let summary = h
        .mgr
        .execute(
            &h.session,
            req("UPDATE t SET x = 1 WHERE x IS NOT NULL"),
            emit,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.rows_affected, Some(0));
    assert_eq!(kinds(&log), ["done"]);
}

/// (spec: driver-framework › SQL error with position)
#[tokio::test]
async fn query_error_is_returned_and_emitted_with_position() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let err = h
        .mgr
        .execute(&h.session, req("FAIL"), emit)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::QueryFailed);
    assert_eq!(err.position, Some(7));
    assert_eq!(kinds(&log), ["error#0:query_failed"]);
}

#[tokio::test]
async fn empty_sql_does_nothing() {
    let h = harness(None).await;
    let (emit, log) = collector();
    assert!(h
        .mgr
        .execute(&h.session, req("   "), emit)
        .await
        .unwrap()
        .is_none());
    assert!(kinds(&log).is_empty());
}

#[tokio::test]
async fn unknown_session_is_an_error() {
    let h = harness(None).await;
    let (emit, _) = collector();
    assert!(h
        .mgr
        .execute("session-999", req("SELECT 1"), emit)
        .await
        .is_err());
}

// ---- script mode -----------------------------------------------------------------------------

/// (spec: driver-framework › Multiple statements)
#[tokio::test]
async fn script_runs_statements_in_order_with_their_own_results() {
    let h = harness(None).await;
    let (emit, log) = collector();
    h.mgr
        .execute(
            &h.session,
            script(
                "SELECT 1; UPDATE t SET x = 1 WHERE x IS NOT NULL; SELECT 2;",
                false,
            ),
            emit,
        )
        .await
        .unwrap();
    assert_eq!(
        kinds(&log),
        [
            "columns#0",
            "rows",
            "done",
            "done",
            "columns#2",
            "rows",
            "done"
        ]
    );
    // result ids stay unique across statements
    let ids: Vec<ResultId> = log
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            ResultEvent::Done { result_id, .. } => Some(*result_id),
            _ => None,
        })
        .collect();
    assert_eq!(ids, [1, 2, 3]);
}

/// (spec: driver-framework › Multiple statements)
#[tokio::test]
async fn script_stops_at_the_first_error() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let err = h
        .mgr
        .execute(&h.session, script("SELECT 1; FAIL; SELECT 2;", false), emit)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::QueryFailed);
    assert_eq!(
        kinds(&log),
        ["columns#0", "rows", "done", "error#1:query_failed"]
    );
}

/// (spec: driver-framework › Multiple statements)
#[tokio::test]
async fn script_can_continue_on_error() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let last = h
        .mgr
        .execute(&h.session, script("SELECT 1; FAIL; SELECT 2;", true), emit)
        .await
        .unwrap();
    assert!(last.is_some());
    assert_eq!(
        kinds(&log),
        [
            "columns#0",
            "rows",
            "done",
            "error#1:query_failed",
            "columns#2",
            "rows",
            "done"
        ]
    );
}

#[tokio::test]
async fn continue_on_error_still_stops_when_the_connection_is_lost() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let err = h
        .mgr
        .execute(&h.session, script("DIE; SELECT 2;", true), emit)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ConnectionLost);
    assert_eq!(kinds(&log), ["error#0:connection_lost"]);
}

// ---- transactions share one session ----------------------------------------------------------

/// (spec: driver-framework › Transaction spans statements)
#[tokio::test]
async fn statements_in_one_tab_run_on_one_physical_connection() {
    let h = harness(None).await;
    for sql in ["BEGIN", "INSERT INTO t VALUES (1)", "SELECT 1"] {
        let (emit, _) = collector();
        h.mgr.execute(&h.session, req(sql), emit).await.unwrap();
    }
    // one session open call for the tab: BEGIN / INSERT / SELECT reused the same connection
    assert_eq!(h.opens.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn each_tab_gets_its_own_session() {
    let h = harness(None).await;
    h.mgr.open_session("c1").await.unwrap();
    assert_eq!(h.opens.load(Ordering::SeqCst), 2);
    assert_eq!(h.mgr.session_count(), 2);
}

// ---- cancel ----------------------------------------------------------------------------------

/// (spec: driver-framework › User cancels)
#[tokio::test]
async fn cancel_stops_a_running_statement_and_leaves_the_session_usable() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let mgr = h.mgr.clone();
    let sid = h.session.clone();
    let run = tokio::spawn(async move { mgr.execute(&sid, req("SLEEP"), emit).await });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let started = Instant::now();
    h.mgr.cancel(&h.session).await.unwrap();
    let err = run.await.unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "cancel must be prompt"
    );
    assert_eq!(kinds(&log), ["cancelled"]);

    let (emit, _) = collector();
    assert!(h
        .mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .is_ok());
}

#[tokio::test]
async fn cancelling_an_idle_session_is_harmless() {
    let h = harness(None).await;
    h.mgr.cancel(&h.session).await.unwrap();
}

#[tokio::test]
async fn cancelling_a_script_stops_the_remaining_statements() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let mgr = h.mgr.clone();
    let sid = h.session.clone();
    let run = tokio::spawn(async move {
        mgr.execute(&sid, script("SELECT 1; SLEEP; SELECT 2;", false), emit)
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.mgr.cancel(&h.session).await.unwrap();
    assert_eq!(run.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(kinds(&log), ["columns#0", "rows", "done", "cancelled"]);
}

// ---- timeout ---------------------------------------------------------------------------------

/// (spec: driver-framework › Timeout)
#[tokio::test]
async fn a_statement_over_the_query_timeout_is_cancelled_with_a_timeout_error() {
    let h = harness(Some(1)).await;
    let (emit, log) = collector();
    let started = Instant::now();
    let err = h
        .mgr
        .execute(&h.session, req("SLEEP"), emit)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(kinds(&log), ["error#0:timeout"]);
    // and the session survives
    let (emit, _) = collector();
    assert!(h
        .mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .is_ok());
}

#[tokio::test]
async fn fast_statements_are_unaffected_by_the_timeout() {
    let h = harness(Some(1)).await;
    let (emit, _) = collector();
    assert!(h
        .mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .is_ok());
}

// ---- lost connection -------------------------------------------------------------------------

/// (spec: driver-framework › Lost connection)
#[tokio::test]
async fn lost_connection_fails_once_then_reconnects_on_the_next_execute() {
    let h = harness(None).await;
    let (emit, log) = collector();
    let err = h
        .mgr
        .execute(&h.session, req("DIE"), emit)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ConnectionLost);
    assert_eq!(kinds(&log), ["error#0:connection_lost"]);
    assert_eq!(h.opens.load(Ordering::SeqCst), 1);

    let (emit, log) = collector();
    h.mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .unwrap();
    assert_eq!(
        h.opens.load(Ordering::SeqCst),
        2,
        "reconnected automatically"
    );
    assert_eq!(kinds(&log), ["notice", "columns#0", "rows", "done"]);
}

/// (spec: driver-framework › Lost connection)
#[tokio::test]
async fn reconnect_reports_a_rolled_back_transaction() {
    let h = harness(None).await;
    let (emit, _) = collector();
    h.mgr.execute(&h.session, req("BEGIN"), emit).await.unwrap();
    let (emit, _) = collector();
    let _ = h.mgr.execute(&h.session, req("DIE"), emit).await;

    let (emit, log) = collector();
    h.mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .unwrap();
    let notice = log.lock().unwrap().iter().find_map(|e| match e {
        ResultEvent::Notice { message } => Some(message.clone()),
        _ => None,
    });
    assert!(notice.unwrap().contains("rolled back"));

    // the transaction is gone: a second reconnect would not mention it
    let (emit, _) = collector();
    let _ = h.mgr.execute(&h.session, req("DIE"), emit).await;
    let (emit, log) = collector();
    h.mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .unwrap();
    let notice = log.lock().unwrap().iter().find_map(|e| match e {
        ResultEvent::Notice { message } => Some(message.clone()),
        _ => None,
    });
    assert!(!notice.unwrap().contains("rolled back"));
}

#[tokio::test]
async fn committed_transactions_are_not_reported_as_rolled_back() {
    let h = harness(None).await;
    for sql in ["BEGIN", "COMMIT"] {
        let (emit, _) = collector();
        h.mgr.execute(&h.session, req(sql), emit).await.unwrap();
    }
    let (emit, _) = collector();
    let _ = h.mgr.execute(&h.session, req("DIE"), emit).await;
    let (emit, log) = collector();
    h.mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .unwrap();
    let rolled =
        log.lock().unwrap().iter().any(
            |e| matches!(e, ResultEvent::Notice { message } if message.contains("rolled back")),
        );
    assert!(!rolled);
}

// ---- metadata pool ---------------------------------------------------------------------------

/// (spec: driver-framework › Introspection does not block a running query)
#[tokio::test]
async fn introspection_does_not_wait_for_a_running_query() {
    let h = harness(None).await;
    let (emit, _) = collector();
    let mgr = h.mgr.clone();
    let sid = h.session.clone();
    let run = tokio::spawn(async move { mgr.execute(&sid, req("SLEEP"), emit).await });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let started = Instant::now();
    let nodes = h.mgr.introspect("c1", &NodePath::root()).await.unwrap();
    assert_eq!(nodes.len(), 1);
    assert!(started.elapsed() < Duration::from_millis(500));

    h.mgr.cancel(&h.session).await.unwrap();
    let _ = run.await;
}

// ---- registry / lifecycle --------------------------------------------------------------------

/// (spec: driver-framework › Unknown driver in a saved connection)
#[tokio::test]
async fn connecting_with_an_unknown_driver_is_driver_unavailable() {
    let mgr = SessionManager::new(Arc::new(Registry::new()), ssh_env());
    let err = mgr.connect("c", cfg(None)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DriverUnavailable);
    let err = mgr.test_connection(&cfg(None)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DriverUnavailable);
}

#[tokio::test]
async fn opening_a_session_for_an_unconnected_connection_fails() {
    let mgr = SessionManager::new(Arc::new(Registry::new()), ssh_env());
    assert!(mgr.open_session("nope").await.is_err());
}

/// (spec: driver-framework › Host unreachable)
#[tokio::test]
async fn a_slow_host_times_out_naming_host_and_port() {
    let mut config = cfg(None);
    config.connect_timeout_secs = 1;
    let mut registry = Registry::new();
    registry.register(Arc::new(FakeDriver {
        opens: Arc::new(AtomicUsize::new(0)),
        open_delay: Duration::from_secs(5),
        record: Default::default(),
    }));
    let mgr = SessionManager::new(Arc::new(registry), ssh_env());
    let err = mgr.test_connection(&config).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
    assert!(err.message.contains("db.internal:5432"));
}

#[tokio::test]
async fn closing_a_session_removes_it() {
    let h = harness(None).await;
    h.mgr.close_session(&h.session).await.unwrap();
    assert_eq!(h.mgr.session_count(), 0);
    let (emit, _) = collector();
    assert!(h
        .mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .is_err());
}

#[tokio::test]
async fn disconnect_closes_the_connections_sessions() {
    let h = harness(None).await;
    h.mgr.open_session("c1").await.unwrap();
    h.mgr.disconnect("c1").await;
    assert_eq!(h.mgr.session_count(), 0);
    assert!(h.mgr.introspect("c1", &NodePath::root()).await.is_err());
}

#[tokio::test]
async fn idle_sessions_are_swept_but_busy_ones_are_not() {
    let h = harness(None).await;
    assert_eq!(h.mgr.sweep_idle(Duration::from_secs(3600)).await, 0);
    assert_eq!(h.mgr.session_count(), 1);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(h.mgr.sweep_idle(Duration::from_millis(10)).await, 1);
    assert_eq!(h.mgr.session_count(), 0);
}

#[tokio::test]
async fn a_closed_window_stops_the_stream_without_failing_the_statement() {
    let h = harness(None).await;
    let emit: Emit = Arc::new(|_| false);
    assert!(h
        .mgr
        .execute(&h.session, req("SELECT 1"), emit)
        .await
        .is_ok());
}

#[test]
fn transaction_effect_classifies_statements() {
    assert_eq!(transaction_effect("BEGIN"), Some(true));
    assert_eq!(
        transaction_effect("  start transaction read only"),
        Some(true)
    );
    assert_eq!(transaction_effect("-- note\nCOMMIT"), Some(false));
    assert_eq!(transaction_effect("/* x */ rollback"), Some(false));
    assert_eq!(transaction_effect("ROLLBACK TO SAVEPOINT a"), None);
    assert_eq!(transaction_effect("SELECT 1"), None);
    assert_eq!(transaction_effect(""), None);
}

#[tokio::test]
async fn on_connect_statements_run_on_every_new_session_and_a_failure_blocks_it() {
    let (mgr, record) = manager_recording();
    let mut c = cfg(None);
    c.on_connect = vec!["SELECT 1".into(), "  ".into(), "SELECT 2".into()];
    mgr.connect("c1", c.clone()).await.unwrap();
    let opened = mgr.open_session("c1").await.unwrap();
    assert_eq!(record.lock().unwrap().as_slice(), ["SELECT 1", "SELECT 2"]);
    mgr.close_session(&opened.session_id).await.unwrap();

    c.on_connect = vec!["FAIL".into()];
    mgr.connect("c2", c).await.unwrap();
    let err = mgr.open_session("c2").await.unwrap_err();
    assert!(
        err.message
            .starts_with("The statement run on connect failed"),
        "{}",
        err.message
    );
    assert_eq!(mgr.session_count(), 0);
}

#[tokio::test]
async fn open_transactions_are_reported_and_ended() {
    let (mgr, record) = manager_recording();
    mgr.connect("c1", cfg(None)).await.unwrap();
    let s = mgr.open_session("c1").await.unwrap();
    assert!(mgr.sessions_in_transaction("c1").is_empty());
    mgr.execute(
        &s.session_id,
        ExecRequest {
            sql: "BEGIN".into(),
            page_size: 10,
            script: false,
            continue_on_error: false,
        },
        Arc::new(|_| true),
    )
    .await
    .unwrap();
    assert_eq!(
        mgr.sessions_in_transaction("c1"),
        vec![s.session_id.clone()]
    );
    mgr.end_transactions("c1", false).await.unwrap();
    assert!(mgr.sessions_in_transaction("c1").is_empty());
    assert_eq!(
        record.lock().unwrap().last().map(String::as_str),
        Some("ROLLBACK")
    );
    assert!(mgr.is_connected("c1"));
    mgr.disconnect("c1").await;
    assert!(!mgr.is_connected("c1"));
}

#[test]
fn switch_statements_follow_the_dialect() {
    assert_eq!(
        switch_statement(Dialect::Postgresql, None, Some("billing")).unwrap(),
        "SET search_path TO \"billing\""
    );
    assert_eq!(
        switch_statement(Dialect::Postgresql, Some("x"), Some("we\"ird")).unwrap(),
        "SET search_path TO \"we\"\"ird\""
    );
    assert_eq!(
        switch_statement(Dialect::Mysql, Some("shop"), None).unwrap(),
        "USE `shop`"
    );
    assert_eq!(
        switch_statement(Dialect::Mariadb, Some("a`b"), None).unwrap(),
        "USE `a``b`"
    );
    assert_eq!(
        switch_statement(Dialect::Postgresql, Some("other"), None)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        switch_statement(Dialect::Sqlite, Some("x"), None)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
}

#[tokio::test]
async fn switching_schema_runs_the_statement_on_the_session() {
    let (mgr, record) = manager_recording();
    mgr.connect("c1", cfg(None)).await.unwrap();
    let s = mgr.open_session("c1").await.unwrap();
    let sql = mgr
        .switch_namespace(&s.session_id, None, Some("billing"))
        .await
        .unwrap();
    assert_eq!(sql, "SET search_path TO \"billing\"");
    assert_eq!(record.lock().unwrap().last().unwrap(), &sql);
}

// ---- session meta, states and actions ----------------------------------------------------------

async fn run(mgr: &SessionManager, id: &str, sql: &str) -> DriverResult<Option<ExecSummary>> {
    mgr.execute(id, req(sql), Arc::new(|_| true)).await
}

fn meta_of(mgr: &SessionManager, id: &str) -> SessionMeta {
    mgr.sessions_list()
        .into_iter()
        .find(|m| m.id == id)
        .expect("session listed")
}

#[tokio::test]
async fn state_goes_idle_in_transaction_aborted_and_back_to_idle() {
    let h = harness(None).await;
    let (mgr, id) = (&h.mgr, &h.session);
    let m = meta_of(mgr, id);
    assert_eq!(m.state, SessionStatus::Idle);
    assert_eq!(m.backend_id.as_deref(), Some("4242"));
    assert_eq!(m.isolation.as_deref(), Some("READ COMMITTED"));
    assert_eq!(m.supported_isolation.len(), 3);

    run(mgr, id, "BEGIN").await.unwrap();
    let m = meta_of(mgr, id);
    assert_eq!(m.state, SessionStatus::InTransaction);
    assert!(m.tx_started_at.is_some());
    assert_eq!(m.tx_statement_count, 0);

    run(mgr, id, "UPDATE t SET a = 1").await.unwrap();
    run(mgr, id, "SELECT 1").await.unwrap();
    let m = meta_of(mgr, id);
    assert_eq!(m.tx_statement_count, 2);
    assert_eq!(m.tx_breakdown.update, 1);
    assert_eq!(m.tx_breakdown.select, 1);
    assert_eq!(m.tx_statements[0].kind, "update");
    assert_eq!(m.tx_statements[0].text, "UPDATE t SET a = 1");

    run(mgr, id, "FAIL").await.unwrap_err();
    assert_eq!(meta_of(mgr, id).state, SessionStatus::Aborted);
    // the aborted transaction is still open: quitting must ask about it
    assert_eq!(mgr.sessions_open_transactions().len(), 1);

    mgr.session_rollback(id).await.unwrap();
    let m = meta_of(mgr, id);
    assert_eq!(m.state, SessionStatus::Idle);
    assert_eq!(m.tx_started_at, None);
    assert_eq!(m.tx_statement_count, 0);
    assert!(
        m.tx_statements.is_empty(),
        "statement text outlives the transaction"
    );
    assert_eq!(m.tx_breakdown, TxBreakdown::default());
    assert!(mgr.sessions_open_transactions().is_empty());
}

#[tokio::test]
async fn an_error_outside_a_transaction_leaves_the_session_idle() {
    let h = harness(None).await;
    run(&h.mgr, &h.session, "FAIL").await.unwrap_err();
    assert_eq!(meta_of(&h.mgr, &h.session).state, SessionStatus::Idle);
}

#[tokio::test]
async fn an_error_after_a_savepoint_does_not_flag_the_transaction() {
    let h = harness(None).await;
    let (mgr, id) = (&h.mgr, &h.session);
    run(mgr, id, "BEGIN").await.unwrap();
    run(mgr, id, "SAVEPOINT a").await.unwrap();
    run(mgr, id, "FAIL").await.unwrap_err();
    assert_eq!(meta_of(mgr, id).state, SessionStatus::InTransaction);
    // the server's own refusal of everything after the failure still means aborted
    let err = DriverError::new(
        ErrorCode::QueryFailed,
        "current transaction is aborted, commands ignored until end of transaction block",
    );
    let entry = mgr.session(id).unwrap();
    let mut st = entry.state.lock().await;
    SessionManager::statement_failed(&entry, &mut st, Some(Dialect::Postgresql), &err).await;
    drop(st);
    assert_eq!(meta_of(mgr, id).state, SessionStatus::Aborted);
    // ROLLBACK TO SAVEPOINT recovers without ending the transaction
    run(mgr, id, "ROLLBACK TO SAVEPOINT a").await.unwrap();
    assert_eq!(meta_of(mgr, id).state, SessionStatus::InTransaction);
}

#[tokio::test]
async fn commit_and_rollback_run_as_statements_and_reset_the_transaction() {
    let (mgr, record) = manager_recording();
    mgr.connect("c1", cfg(None)).await.unwrap();
    let id = mgr.open_session("c1").await.unwrap().session_id;
    run(&mgr, &id, "BEGIN").await.unwrap();
    run(&mgr, &id, "DELETE FROM t").await.unwrap();
    mgr.session_commit(&id).await.unwrap();
    assert_eq!(meta_of(&mgr, &id).state, SessionStatus::Idle);
    assert_eq!(meta_of(&mgr, &id).tx_statement_count, 0);
    run(&mgr, &id, "BEGIN").await.unwrap();
    mgr.session_rollback(&id).await.unwrap();
    let seen = record.lock().unwrap().clone();
    assert_eq!(
        seen,
        ["BEGIN", "DELETE FROM t", "COMMIT", "BEGIN", "ROLLBACK"]
    );
}

#[tokio::test]
async fn the_transaction_keeps_the_last_twenty_statements_truncated() {
    let h = harness(None).await;
    let (mgr, id) = (&h.mgr, &h.session);
    run(mgr, id, "BEGIN").await.unwrap();
    for n in 0..25 {
        run(mgr, id, &format!("INSERT INTO t VALUES ({n})"))
            .await
            .unwrap();
    }
    let long = format!("UPDATE t SET a = '{}'", "x".repeat(5000));
    run(mgr, id, &long).await.unwrap();
    let m = meta_of(mgr, id);
    assert_eq!(m.tx_statement_count, 26);
    assert_eq!(m.tx_statements.len(), 20);
    assert_eq!(m.tx_statements[0].text, "INSERT INTO t VALUES (6)");
    assert_eq!(m.tx_statements.last().unwrap().text.chars().count(), 2000);
}

#[tokio::test]
async fn a_running_statement_shows_its_start_and_returns_to_idle_when_cancelled() {
    let h = harness(None).await;
    let mgr = h.mgr.clone();
    let id = h.session.clone();
    let task = {
        let (mgr, id) = (mgr.clone(), id.clone());
        tokio::spawn(async move { run(&mgr, &id, "SLEEP").await })
    };
    let running = loop {
        let m = meta_of(&mgr, &id);
        if m.state == SessionStatus::Running {
            break m;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert!(running.running_since.is_some());
    assert_eq!(running.running_statement.as_deref(), Some("SLEEP"));
    mgr.cancel(&id).await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);
    let m = meta_of(&mgr, &id);
    assert_eq!(m.state, SessionStatus::Idle);
    assert_eq!(m.running_since, None);
    assert_eq!(m.running_statement, None);
}

#[tokio::test]
async fn a_lost_connection_shows_disconnected_and_the_next_use_reconnects() {
    let h = harness(None).await;
    run(&h.mgr, &h.session, "DIE").await.unwrap_err();
    assert_eq!(
        meta_of(&h.mgr, &h.session).state,
        SessionStatus::Disconnected
    );
    run(&h.mgr, &h.session, "SELECT 1").await.unwrap();
    assert_eq!(meta_of(&h.mgr, &h.session).state, SessionStatus::Idle);
    assert_eq!(h.opens.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn subscribers_get_a_snapshot_then_upserts_and_removals() {
    let h = harness(None).await;
    let (snapshot, mut rx) = h.mgr.subscribe();
    assert_eq!(snapshot.len(), 1);
    run(&h.mgr, &h.session, "BEGIN").await.unwrap();
    let mut states = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let SessionEvent::Upsert { session } = event {
            states.push(session.state);
        }
    }
    assert_eq!(
        states,
        [SessionStatus::Running, SessionStatus::InTransaction]
    );
    h.mgr.close_session(&h.session).await.unwrap();
    match rx.try_recv().unwrap() {
        SessionEvent::Removed { id } => assert_eq!(id, h.session),
        other => panic!("{other:?}"),
    }
    let json = serde_json::to_value(SessionEvent::Removed { id: "x".into() }).unwrap();
    assert_eq!(json["kind"], "removed");
    let json = serde_json::to_value(SessionEvent::Snapshot { sessions: vec![] }).unwrap();
    assert_eq!(json["kind"], "snapshot");
}

#[tokio::test]
async fn meta_serializes_with_the_names_the_panel_reads() {
    let h = harness(None).await;
    run(&h.mgr, &h.session, "BEGIN").await.unwrap();
    let json = serde_json::to_value(meta_of(&h.mgr, &h.session)).unwrap();
    assert_eq!(json["state"], "in_transaction");
    for key in [
        "connectionId",
        "tabId",
        "startedAt",
        "lastActivityAt",
        "runningSince",
        "runningStatement",
        "txStartedAt",
        "txStatementCount",
        "txBreakdown",
        "txStatements",
        "supportedIsolation",
        "isolationNote",
        "backendId",
        "readOnly",
        "sharedWith",
        "waitingFor",
    ] {
        assert!(json.get(key).is_some(), "missing {key}");
    }
    assert_eq!(
        serde_json::to_value(SessionStatus::Disconnected).unwrap(),
        "disconnected"
    );
}

#[tokio::test]
async fn statements_from_tabs_sharing_a_session_queue_and_the_waiting_one_says_for_whom() {
    let (mgr, record) = manager_recording();
    mgr.connect("c1", cfg(None)).await.unwrap();
    let id = mgr.open_session("c1").await.unwrap().session_id;
    mgr.set_session_meta(&id, Some("console".into()), Some("tab-1".into()))
        .unwrap();
    mgr.attach_tab(&id, "tab-2").unwrap();
    assert_eq!(meta_of(&mgr, &id).shared_with, ["tab-2"]);

    let first = {
        let (mgr, id) = (mgr.clone(), id.clone());
        tokio::spawn(async move { run(&mgr, &id, "PAUSE").await })
    };
    while record.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let second = {
        let (mgr, id) = (mgr.clone(), id.clone());
        tokio::spawn(async move { run(&mgr, &id, "SELECT 2").await })
    };
    let waiting = loop {
        let m = meta_of(&mgr, &id);
        if m.waiting_for.is_some() {
            break m;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert_eq!(waiting.waiting_for.as_deref(), Some("console"));
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(meta_of(&mgr, &id).waiting_for, None);
    assert_eq!(record.lock().unwrap().as_slice(), ["PAUSE", "SELECT 2"]);
}

#[tokio::test]
async fn the_last_tab_leaving_closes_the_shared_session() {
    let h = harness(None).await;
    let (mgr, id) = (&h.mgr, &h.session);
    mgr.set_session_meta(id, None, Some("tab-1".into()))
        .unwrap();
    mgr.attach_tab(id, "tab-2").unwrap();
    assert!(!mgr.detach_tab(id, "tab-1").await.unwrap());
    let m = meta_of(mgr, id);
    assert_eq!(m.tab_id.as_deref(), Some("tab-2"));
    assert!(m.shared_with.is_empty());
    assert!(mgr.detach_tab(id, "tab-2").await.unwrap());
    assert_eq!(mgr.session_count(), 0);
}

#[tokio::test]
async fn closing_all_sessions_settles_transactions_and_keeps_sessions_for_their_tabs() {
    let (mgr, record) = manager_recording();
    mgr.connect("c1", cfg(None)).await.unwrap();
    let a = mgr.open_session("c1").await.unwrap().session_id;
    let b = mgr.open_session("c1").await.unwrap().session_id;
    run(&mgr, &a, "BEGIN").await.unwrap();
    mgr.disconnect_sessions_of("c1", Some(TxAction::Rollback))
        .await
        .unwrap();
    assert_eq!(record.lock().unwrap().last().unwrap(), "ROLLBACK");
    for id in [&a, &b] {
        assert_eq!(meta_of(&mgr, id).state, SessionStatus::Disconnected);
    }
    assert!(mgr.sessions_open_transactions().is_empty());
    // a deliberate close reconnects quietly on next use
    let (emit, log) = collector();
    mgr.execute(&a, req("SELECT 1"), emit).await.unwrap();
    assert!(!kinds(&log).contains(&"notice".to_string()));
    assert_eq!(meta_of(&mgr, &a).state, SessionStatus::Idle);
}

#[tokio::test]
async fn deactivating_a_connection_removes_its_sessions() {
    let (mgr, record) = manager_recording();
    mgr.connect("c1", cfg(None)).await.unwrap();
    let a = mgr.open_session("c1").await.unwrap().session_id;
    run(&mgr, &a, "BEGIN").await.unwrap();
    let (_, mut rx) = mgr.subscribe();
    mgr.end_transactions("c1", true).await.unwrap();
    mgr.disconnect("c1").await;
    assert_eq!(record.lock().unwrap().last().unwrap(), "COMMIT");
    assert_eq!(mgr.session_count(), 0);
    let mut removed = false;
    while let Ok(event) = rx.try_recv() {
        removed |= matches!(event, SessionEvent::Removed { .. });
    }
    assert!(removed);
}

#[tokio::test]
async fn isolation_applies_when_idle_and_is_refused_inside_a_transaction() {
    let (mgr, record) = manager_recording();
    mgr.connect("c1", cfg(None)).await.unwrap();
    let id = mgr.open_session("c1").await.unwrap().session_id;
    mgr.set_session_isolation(&id, "serializable")
        .await
        .unwrap();
    assert_eq!(
        record.lock().unwrap().last().unwrap(),
        "SET ISOLATION SERIALIZABLE"
    );
    assert_eq!(
        meta_of(&mgr, &id).isolation.as_deref(),
        Some("SERIALIZABLE")
    );

    let err = mgr
        .set_session_isolation(&id, "READ UNCOMMITTED")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported);

    run(&mgr, &id, "BEGIN").await.unwrap();
    mgr.set_session_isolation(&id, "REPEATABLE READ")
        .await
        .unwrap_err();
    assert_eq!(
        meta_of(&mgr, &id).isolation.as_deref(),
        Some("SERIALIZABLE")
    );
    mgr.session_rollback(&id).await.unwrap();
    mgr.set_session_isolation(&id, "REPEATABLE READ")
        .await
        .unwrap();
    assert_eq!(
        meta_of(&mgr, &id).isolation.as_deref(),
        Some("REPEATABLE READ")
    );
}

#[tokio::test]
async fn the_connection_default_isolation_applies_to_new_sessions_and_survives_a_reconnect() {
    let (mgr, record) = manager_recording();
    let mut c = cfg(None);
    c.isolation = Some("repeatable read".into());
    mgr.connect("c1", c).await.unwrap();
    let id = mgr.open_session("c1").await.unwrap().session_id;
    assert_eq!(
        record.lock().unwrap().as_slice(),
        ["SET ISOLATION REPEATABLE READ"]
    );
    assert_eq!(
        meta_of(&mgr, &id).isolation.as_deref(),
        Some("REPEATABLE READ")
    );

    // an explicit level wins over the default; an unknown one is ignored
    let other = mgr
        .open_session_with("c1", Some("SERIALIZABLE".into()))
        .await
        .unwrap()
        .session_id;
    assert_eq!(
        meta_of(&mgr, &other).isolation.as_deref(),
        Some("SERIALIZABLE")
    );

    run(&mgr, &id, "DIE").await.unwrap_err();
    run(&mgr, &id, "SELECT 1").await.unwrap();
    let seen = record.lock().unwrap().clone();
    assert_eq!(seen.last().map(String::as_str), Some("SELECT 1"));
    assert!(
        seen.iter()
            .filter(|s| *s == "SET ISOLATION REPEATABLE READ")
            .count()
            >= 2
    );
}

#[tokio::test]
async fn a_driver_without_isolation_levels_reports_none() {
    // the trait defaults: no id, no state, nothing selectable
    struct Bare;
    #[async_trait]
    impl Session for Bare {
        async fn execute(&mut self, _: ExecRequest, _: ResultSink) -> DriverResult<ExecSummary> {
            unreachable!()
        }
        async fn fetch_more(&mut self, _: ResultId, _: usize, _: ResultSink) -> DriverResult<bool> {
            unreachable!()
        }
        fn cancel_handle(&self) -> CancelHandle {
            unreachable!()
        }
        fn server_info(&self) -> ServerInfo {
            unreachable!()
        }
        async fn close(self: Box<Self>) -> DriverResult<()> {
            Ok(())
        }
    }
    let mut bare = Bare;
    assert!(bare.backend_id().is_none());
    assert!(bare.transaction_state().await.unwrap().is_none());
    assert!(bare.supported_isolation_levels().is_empty());
    assert_eq!(
        bare.set_isolation("SERIALIZABLE").await.unwrap_err().code,
        ErrorCode::Unsupported
    );
}

#[test]
fn each_driver_declares_its_isolation_levels() {
    use crate::drivers::{mysql, postgres};
    assert_eq!(
        postgres::session::ISOLATION_LEVELS,
        ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]
    );
    assert_eq!(
        mysql::session::ISOLATION_LEVELS,
        [
            "READ UNCOMMITTED",
            "READ COMMITTED",
            "REPEATABLE READ",
            "SERIALIZABLE"
        ]
    );
    assert_eq!(
        postgres::session::set_isolation_sql("SERIALIZABLE"),
        "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"
    );
    assert_eq!(
        mysql::session::set_isolation_sql("READ COMMITTED"),
        "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    assert_eq!(
        crate::drivers::sqlite::session::FIXED_ISOLATION,
        "SERIALIZABLE"
    );
}

#[test]
fn isolation_text_is_matched_against_the_supported_list_and_never_spliced() {
    use crate::drivers::canonical_isolation as canon;
    let levels = crate::drivers::postgres::session::ISOLATION_LEVELS;
    assert_eq!(
        canon(levels, " repeatable   read ").unwrap(),
        "REPEATABLE READ"
    );
    assert_eq!(
        canon(levels, "SERIALIZABLE; DROP TABLE t")
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert!(canon(levels, "READ UNCOMMITTED").is_err());
}

#[test]
fn statements_are_classified_for_the_breakdown() {
    assert_eq!(statement_kind("  select 1"), "select");
    assert_eq!(
        statement_kind("/* x */ WITH a AS (SELECT 1) SELECT * FROM a"),
        "select"
    );
    assert_eq!(statement_kind("-- c\nINSERT INTO t VALUES (1)"), "insert");
    assert_eq!(statement_kind("update t set a=1"), "update");
    assert_eq!(statement_kind("DELETE FROM t"), "delete");
    assert_eq!(statement_kind("CREATE TABLE t (a int)"), "other");
}

#[test]
fn the_server_can_correct_the_transaction_state() {
    let mut cell = MetaCell::new(SessionMeta {
        id: "s".into(),
        connection_id: "c".into(),
        tab_id: None,
        name: "n".into(),
        state: SessionStatus::Idle,
        started_at: 0,
        last_activity_at: 0,
        running_since: None,
        running_statement: None,
        tx_started_at: None,
        tx_statement_count: 0,
        tx_breakdown: TxBreakdown::default(),
        tx_statements: vec![],
        isolation: None,
        supported_isolation: vec![],
        isolation_note: None,
        backend_id: None,
        read_only: false,
        shared_with: vec![],
        waiting_for: None,
    });
    cell.statement_started("BEGIN", false, 1);
    cell.statement_ok("BEGIN", false, true, Some(true), 2);
    cell.statement_started("UPDATE t SET a = 1", false, 3);
    cell.statement_ok("UPDATE t SET a = 1", false, true, None, 4);
    assert_eq!(cell.meta.state, SessionStatus::InTransaction);
    assert_eq!(cell.meta.tx_statement_count, 1);
    // deadlock victim: the server rolled the transaction back by itself
    cell.server_says(TxState::Idle, 5);
    assert_eq!(cell.meta.state, SessionStatus::Idle);
    assert!(cell.meta.tx_statements.is_empty());
    // statements Clew runs by itself are not part of the user's transaction
    cell.statement_ok("BEGIN", false, true, Some(true), 6);
    cell.statement_ok("EXPLAIN SELECT 1", false, false, None, 7);
    assert_eq!(cell.meta.tx_statement_count, 0);
    // sensitive text never reaches the statement list
    cell.statement_ok("AUTH hunter2", true, true, None, 8);
    assert_eq!(cell.meta.tx_statements[0].text, "(hidden)");
}
