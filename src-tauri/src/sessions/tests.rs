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
