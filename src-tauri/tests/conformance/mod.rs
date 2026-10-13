//! Scenarios every driver must pass, run through the real `SessionManager` so they cover the
//! whole path a console tab uses. Each driver's test file supplies a [`Suite`] (connection config
//! plus the few SQL snippets that differ between databases).
#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clew_lib::drivers::registry::Registry;
use clew_lib::drivers::{
    ColumnMeta, DriverError, DriverResult, ErrorCode, ExecRequest, ExecSummary, ResolvedConfig,
    ResultEvent, ResultId, ServerInfo, Value,
};
use clew_lib::sessions::{Emit, SessionId, SessionManager, SessionMeta, SessionStatus};
use clew_lib::transport::hostkey::{KnownHosts, RejectUnknown};
use clew_lib::transport::ssh::SshEnv;

/// The SQL that differs between databases.
pub struct Dialect {
    /// Expected `ServerInfo.product`.
    pub product: &'static str,
    /// A query returning one column `n` with the integers 1..=count, in order.
    pub generate_rows: fn(u32) -> String,
    /// A statement that runs far longer than any test waits.
    pub sleep_long: &'static str,
    pub syntax_error: &'static str,
    /// 1-based position the server reports for `syntax_error`, when it reports one.
    pub error_position: Option<u32>,
    /// A query returning the session's backend id, and the statement that kills one.
    pub backend_id_sql: Option<&'static str>,
    pub kill_sql: Option<fn(&str) -> String>,
}

pub struct Suite {
    pub dialect: Dialect,
    pub cfg: ResolvedConfig,
}

pub fn manager() -> Arc<SessionManager> {
    let env = SshEnv {
        known_hosts: KnownHosts {
            user_file: None,
            app_file: std::env::temp_dir().join("clew-conformance-known-hosts"),
        },
        prompter: Arc::new(RejectUnknown),
    };
    Arc::new(SessionManager::new(
        Arc::new(Registry::with_defaults()),
        env,
    ))
}

pub struct Run {
    pub events: Vec<ResultEvent>,
    pub result: DriverResult<Option<ExecSummary>>,
}

impl Run {
    pub fn ok(&self) -> &ExecSummary {
        self.result
            .as_ref()
            .unwrap_or_else(|e| panic!("statement failed: {e:?}"))
            .as_ref()
            .expect("a summary")
    }

    pub fn err(&self) -> &DriverError {
        self.result
            .as_ref()
            .expect_err("the statement should have failed")
    }

    pub fn columns(&self) -> Vec<&ColumnMeta> {
        self.events
            .iter()
            .filter_map(|e| match e {
                ResultEvent::Columns { columns, .. } => Some(columns.iter()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    pub fn rows(&self) -> Vec<Vec<Value>> {
        self.events
            .iter()
            .filter_map(|e| match e {
                ResultEvent::Rows { rows, .. } => Some(rows.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    pub fn row_batches(&self) -> Vec<usize> {
        self.events
            .iter()
            .filter_map(|e| match e {
                ResultEvent::Rows { rows, .. } => Some(rows.len()),
                _ => None,
            })
            .collect()
    }

    pub fn result_id(&self) -> ResultId {
        self.events
            .iter()
            .find_map(|e| match e {
                ResultEvent::Columns { result_id, .. } => Some(*result_id),
                _ => None,
            })
            .expect("a result with columns")
    }

    pub fn notices(&self) -> Vec<String> {
        self.events
            .iter()
            .filter_map(|e| match e {
                ResultEvent::Notice { message } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    /// First column of the first row as an integer.
    pub fn scalar_int(&self) -> i64 {
        int(&self.rows()[0][0])
    }
}

pub fn int(v: &Value) -> i64 {
    match v {
        Value::Int { value } => *value,
        Value::Bigint { value } => value.parse().expect("integer text"),
        Value::Decimal { value } => value.parse().expect("integer text"),
        Value::Text { value, .. } => value.parse().expect("integer text"),
        other => panic!("not an integer: {other:?}"),
    }
}

pub fn text(v: &Value) -> String {
    match v {
        Value::Text { value, .. } => value.clone(),
        other => panic!("not text: {other:?}"),
    }
}

pub fn collector() -> (Emit, Arc<Mutex<Vec<ResultEvent>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink = log.clone();
    (
        Arc::new(move |e| {
            sink.lock().unwrap().push(e);
            true
        }),
        log,
    )
}

pub async fn exec(mgr: &SessionManager, sid: &SessionId, req: ExecRequest) -> Run {
    let (emit, log) = collector();
    let result = mgr.execute(sid, req, emit).await;
    let events = log.lock().unwrap().clone();
    Run { events, result }
}

pub async fn run(mgr: &SessionManager, sid: &SessionId, sql: &str) -> Run {
    run_page(mgr, sid, sql, 500).await
}

pub async fn run_page(mgr: &SessionManager, sid: &SessionId, sql: &str, page: usize) -> Run {
    exec(
        mgr,
        sid,
        ExecRequest {
            sql: sql.into(),
            page_size: page,
            script: false,
            continue_on_error: false,
        },
    )
    .await
}

pub async fn run_script(
    mgr: &SessionManager,
    sid: &SessionId,
    sql: &str,
    continue_on_error: bool,
) -> Run {
    exec(
        mgr,
        sid,
        ExecRequest {
            sql: sql.into(),
            page_size: 500,
            script: true,
            continue_on_error,
        },
    )
    .await
}

pub struct Connected {
    pub mgr: Arc<SessionManager>,
    pub session: SessionId,
}

/// Register the connection and open one session.
pub async fn connect(cfg: &ResolvedConfig) -> Connected {
    let mgr = manager();
    mgr.connect("conf", cfg.clone()).await.expect("connect");
    let session = mgr
        .open_session("conf")
        .await
        .expect("open session")
        .session_id;
    Connected { mgr, session }
}

impl Connected {
    pub async fn run(&self, sql: &str) -> Run {
        run(&self.mgr, &self.session, sql).await
    }

    /// Run and require success.
    pub async fn must(&self, sql: &str) -> Run {
        let r = self.run(sql).await;
        r.ok();
        r
    }

    pub async fn another_session(&self) -> SessionId {
        self.mgr
            .open_session("conf")
            .await
            .expect("open session")
            .session_id
    }
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

/// (spec: driver-framework › Successful test)
pub async fn test_connection_reports_the_server(s: &Suite) {
    let mgr = manager();
    let info: ServerInfo = mgr.test_connection(&s.cfg).await.expect("test connection");
    assert_eq!(info.product, s.dialect.product);
    assert!(
        info.version
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit()),
        "version: {}",
        info.version
    );
}

pub async fn session_reports_the_server(s: &Suite) {
    let c = connect(&s.cfg).await;
    let info = c.mgr.server_info(&c.session).unwrap();
    assert_eq!(info.product, s.dialect.product);
}

/// (spec: driver-framework › Large result is paged)
pub async fn large_results_are_paged(s: &Suite) {
    let c = connect(&s.cfg).await;
    let sql = (s.dialect.generate_rows)(1200);
    let first = run_page(&c.mgr, &c.session, &sql, 500).await;
    let summary = first.ok();
    assert!(
        summary.has_more,
        "1200 rows with a page size of 500 must report has_more"
    );
    assert_eq!(first.rows().len(), 500);
    assert_eq!(int(&first.rows()[0][0]), 1);
    assert_eq!(int(&first.rows()[499][0]), 500);
    let id = first.result_id();

    let mut seen = 500;
    let mut next = 501;
    loop {
        let (emit, log) = collector();
        let more = c
            .mgr
            .fetch_more(&c.session, id, 500, emit)
            .await
            .expect("fetch more");
        let rows: Vec<Vec<Value>> = log
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                ResultEvent::Rows { rows, .. } => Some(rows.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        for row in &rows {
            assert_eq!(int(&row[0]), next, "rows arrive in order");
            next += 1;
        }
        seen += rows.len();
        if !more {
            break;
        }
        assert_eq!(rows.len(), 500);
    }
    assert_eq!(seen, 1200);
    // the session is usable again afterwards
    assert_eq!(c.must("SELECT 1 AS one").await.scalar_int(), 1);
}

pub async fn a_new_statement_abandons_an_open_result(s: &Suite) {
    let c = connect(&s.cfg).await;
    let first = run_page(&c.mgr, &c.session, &(s.dialect.generate_rows)(5000), 100).await;
    assert!(first.ok().has_more);
    // Running something else closes the stream and keeps the session healthy.
    assert_eq!(c.must("SELECT 42 AS answer").await.scalar_int(), 42);
    let (emit, _) = collector();
    assert!(c
        .mgr
        .fetch_more(&c.session, first.result_id(), 10, emit)
        .await
        .is_err());
}

pub async fn column_metadata(s: &Suite) {
    let c = connect(&s.cfg).await;
    let r = c.must("SELECT 1 AS one, 'x' AS two").await;
    let cols = r.columns();
    assert_eq!(cols.len(), 2);
    assert_eq!(cols[0].name, "one");
    assert_eq!(cols[1].name, "two");
    assert!(!cols[0].type_name.is_empty());
}

/// (spec: driver-framework › Statement without a result set)
pub async fn rows_affected_without_a_result_set(s: &Suite, table: &str) {
    let c = connect(&s.cfg).await;
    c.must(&format!("DROP TABLE IF EXISTS {table}")).await;
    c.must(&format!(
        "CREATE TABLE {table} (id INTEGER PRIMARY KEY, name VARCHAR(50))"
    ))
    .await;
    let values: Vec<String> = (1..=12).map(|i| format!("({i}, 'n{i}')")).collect();
    let insert = c
        .must(&format!(
            "INSERT INTO {table} (id, name) VALUES {}",
            values.join(",")
        ))
        .await;
    assert_eq!(insert.ok().rows_affected, Some(12));
    let update = c
        .must(&format!("UPDATE {table} SET name = 'changed'"))
        .await;
    assert_eq!(update.ok().rows_affected, Some(12));
    assert!(
        update.columns().is_empty(),
        "no result set means no columns"
    );
    assert!(update.ok().elapsed_ms < 10_000);
    c.must(&format!("DROP TABLE {table}")).await;
}

/// (spec: driver-framework › Multiple statements)
pub async fn scripts_run_in_order_and_stop_on_error(s: &Suite) {
    let c = connect(&s.cfg).await;
    let ok = run_script(
        &c.mgr,
        &c.session,
        "SELECT 1 AS a; SELECT 2 AS b; SELECT 3 AS c;",
        false,
    )
    .await;
    ok.ok();
    let firsts: Vec<i64> = ok.rows().iter().map(|r| int(&r[0])).collect();
    assert_eq!(firsts, [1, 2, 3]);

    let sql = format!("SELECT 1 AS a; {}; SELECT 3 AS c;", s.dialect.syntax_error);
    let stopped = run_script(&c.mgr, &c.session, &sql, false).await;
    assert_eq!(stopped.err().code, ErrorCode::QueryFailed);
    assert_eq!(
        stopped.rows().len(),
        1,
        "nothing runs after the failing statement"
    );

    let carried = run_script(&c.mgr, &c.session, &sql, true).await;
    assert_eq!(carried.rows().len(), 2, "continue-on-error runs the rest");
}

/// (spec: driver-framework › SQL error with position)
pub async fn syntax_errors_carry_a_position(s: &Suite) {
    let c = connect(&s.cfg).await;
    let r = c.run(s.dialect.syntax_error).await;
    let err = r.err();
    assert_eq!(err.code, ErrorCode::QueryFailed);
    assert!(!err.message.is_empty());
    if let Some(pos) = s.dialect.error_position {
        assert_eq!(err.position, Some(pos));
    }
    // the session survives a failed statement
    assert_eq!(c.must("SELECT 1").await.scalar_int(), 1);
}

/// (spec: driver-framework › Transaction spans statements)
pub async fn transactions_span_statements(s: &Suite, table: &str) {
    let c = connect(&s.cfg).await;
    c.must(&format!("DROP TABLE IF EXISTS {table}")).await;
    c.must(&format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
        .await;

    c.must("BEGIN").await;
    c.must(&format!("INSERT INTO {table} (id) VALUES (1)"))
        .await;
    let inside = c.must(&format!("SELECT count(*) FROM {table}")).await;
    assert_eq!(
        inside.scalar_int(),
        1,
        "the SELECT sees the uncommitted insert"
    );

    let other = c.another_session().await;
    let outside = run(&c.mgr, &other, &format!("SELECT count(*) FROM {table}")).await;
    assert_eq!(outside.scalar_int(), 0, "another session does not");

    c.must("ROLLBACK").await;
    assert_eq!(
        c.must(&format!("SELECT count(*) FROM {table}"))
            .await
            .scalar_int(),
        0
    );
    c.must(&format!("DROP TABLE {table}")).await;
}

pub async fn temporary_tables_belong_to_the_session(s: &Suite, table: &str) {
    let c = connect(&s.cfg).await;
    c.must(&format!("CREATE TEMPORARY TABLE {table} (id INTEGER)"))
        .await;
    c.must(&format!("INSERT INTO {table} (id) VALUES (7)"))
        .await;
    assert_eq!(
        c.must(&format!("SELECT id FROM {table}"))
            .await
            .scalar_int(),
        7
    );
    let other = c.another_session().await;
    let r = run(&c.mgr, &other, &format!("SELECT id FROM {table}")).await;
    assert!(r.result.is_err(), "a temp table is private to its session");
}

/// (spec: driver-framework › User cancels)
pub async fn cancel_stops_a_long_query(s: &Suite) {
    let c = connect(&s.cfg).await;
    let mgr = c.mgr.clone();
    let sid = c.session.clone();
    let sleep = s.dialect.sleep_long.to_string();
    let task = tokio::spawn(async move { run(&mgr, &sid, &sleep).await });
    tokio::time::sleep(Duration::from_millis(600)).await;

    let started = Instant::now();
    c.mgr.cancel(&c.session).await.expect("cancel");
    let r = task.await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "stopped in {:?}",
        started.elapsed()
    );
    assert_eq!(r.err().code, ErrorCode::Cancelled);
    assert!(r
        .events
        .iter()
        .any(|e| matches!(e, ResultEvent::Cancelled { .. })));
    assert_eq!(
        c.must("SELECT 1").await.scalar_int(),
        1,
        "the session stays usable"
    );
}

/// (spec: driver-framework › Timeout)
pub async fn the_query_timeout_cancels_the_statement(s: &Suite) {
    let mut cfg = s.cfg.clone();
    cfg.query_timeout_secs = Some(1);
    let c = connect(&cfg).await;
    let started = Instant::now();
    let r = c.run(s.dialect.sleep_long).await;
    assert_eq!(r.err().code, ErrorCode::Timeout);
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(c.must("SELECT 1").await.scalar_int(), 1);
}

/// (spec: driver-framework › Lost connection)
pub async fn a_killed_connection_is_reported_then_reconnected(s: &Suite) {
    let (Some(id_sql), Some(kill)) = (s.dialect.backend_id_sql, s.dialect.kill_sql) else {
        return;
    };
    let c = connect(&s.cfg).await;
    let id = c.must(id_sql).await.scalar_int().to_string();

    let other = c.another_session().await;
    let k = run(&c.mgr, &other, &kill(&id)).await;
    let _ = k; // the kill statement itself may or may not return a result

    // wait for the server to drop the connection
    tokio::time::sleep(Duration::from_millis(300)).await;
    let lost = c.run("SELECT 1").await;
    assert_eq!(
        lost.err().code,
        ErrorCode::ConnectionLost,
        "{:?}",
        lost.result
    );

    let back = c.run("SELECT 2").await;
    assert_eq!(back.scalar_int(), 2, "the next execute reconnects");
    assert!(back.notices().iter().any(|n| n.contains("re-established")));
    // The notice proves a new connection was made. Its id may even equal the old one: SQL Server
    // hands out session ids from a small pool and reuses them at once.
    c.must(id_sql).await;
}

/// (spec: driver-framework › Lost connection)
pub async fn an_open_transaction_is_reported_rolled_back_after_a_kill(s: &Suite) {
    let (Some(id_sql), Some(kill)) = (s.dialect.backend_id_sql, s.dialect.kill_sql) else {
        return;
    };
    let c = connect(&s.cfg).await;
    c.must("BEGIN").await;
    let id = c.must(id_sql).await.scalar_int().to_string();
    let other = c.another_session().await;
    let _ = run(&c.mgr, &other, &kill(&id)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = c.run("SELECT 1").await;
    let back = c.run("SELECT 2").await;
    assert!(
        back.notices().iter().any(|n| n.contains("rolled back")),
        "{:?}",
        back.notices()
    );
}

/// (spec: driver-framework › Introspection does not block a running query)
pub async fn introspection_works_while_a_query_runs(s: &Suite) {
    let c = connect(&s.cfg).await;
    let mgr = c.mgr.clone();
    let sid = c.session.clone();
    let sleep = s.dialect.sleep_long.to_string();
    let task = tokio::spawn(async move { run(&mgr, &sid, &sleep).await });
    tokio::time::sleep(Duration::from_millis(500)).await;

    let started = Instant::now();
    let nodes = c
        .mgr
        .introspect("conf", &clew_lib::drivers::NodePath::root())
        .await
        .expect("introspect");
    assert!(!nodes.is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );

    c.mgr.cancel(&c.session).await.unwrap();
    let _ = task.await;
}

/// (spec: driver-framework › Wrong password)
pub async fn wrong_credentials_are_auth_failed(cfg: &ResolvedConfig, secret: &str) {
    let mgr = manager();
    let err = mgr
        .test_connection(cfg)
        .await
        .expect_err("must be rejected");
    assert_eq!(err.code, ErrorCode::AuthFailed, "{err:?}");
    assert!(
        !format!("{err:?}").contains(secret),
        "the password must not be echoed"
    );
}

/// (spec: driver-framework › Host unreachable)
pub async fn an_unreachable_host_times_out(cfg: &ResolvedConfig, host: &str) {
    let mgr = manager();
    let started = Instant::now();
    let err = mgr.test_connection(cfg).await.expect_err("must fail");
    assert!(
        matches!(err.code, ErrorCode::Timeout | ErrorCode::ConnectionLost),
        "{err:?}"
    );
    assert!(
        err.message.contains(host),
        "the message names the host: {}",
        err.message
    );
    assert!(started.elapsed() < Duration::from_secs(8));
}

/// (spec: driver-framework › Unknown driver in a saved connection)
pub async fn unknown_driver_is_unavailable(cfg: &ResolvedConfig) {
    let mut cfg = cfg.clone();
    cfg.driver = "no-such-driver".into();
    let err = manager().connect("x", cfg).await.expect_err("must fail");
    assert_eq!(err.code, ErrorCode::DriverUnavailable);
    assert!(err.message.contains("no-such-driver"));
}

// ---- session manager: states and isolation -------------------------------------------------------

fn meta(mgr: &SessionManager, sid: &SessionId) -> SessionMeta {
    mgr.sessions_list()
        .into_iter()
        .find(|m| &m.id == sid)
        .expect("session listed")
}

/// Statements run straight on a driver session (no manager), results discarded.
async fn raw(session: &mut dyn clew_lib::drivers::Session, sql: &str) -> DriverResult<()> {
    let (sink, mut rx) = clew_lib::drivers::ResultSink::channel(8);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let r = session
        .execute(
            ExecRequest {
                sql: sql.into(),
                page_size: 10,
                script: false,
                continue_on_error: false,
            },
            sink,
        )
        .await;
    let _ = drain.await;
    r.map(|_| ())
}

/// The driver reports idle, in transaction and (where the server has it) aborted.
/// (spec: driver-framework › Session state and isolation level)
pub async fn the_driver_reports_the_transaction_state(
    s: &Suite,
    driver: &str,
    table: &str,
    aborts: bool,
) {
    use clew_lib::drivers::TxState;
    let registry = Registry::with_defaults();
    let d = registry.get(driver).expect("driver");
    let mut session = d.open(&s.cfg).await.expect("open");
    raw(session.as_mut(), &format!("DROP TABLE IF EXISTS {table}"))
        .await
        .unwrap();
    raw(
        session.as_mut(),
        &format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY)"),
    )
    .await
    .unwrap();
    assert_eq!(
        session.transaction_state().await.unwrap(),
        Some(TxState::Idle)
    );
    raw(session.as_mut(), "BEGIN").await.unwrap();
    assert_eq!(
        session.transaction_state().await.unwrap(),
        Some(TxState::InTransaction)
    );
    raw(session.as_mut(), &format!("INSERT INTO {table} VALUES (1)"))
        .await
        .unwrap();
    raw(session.as_mut(), &format!("INSERT INTO {table} VALUES (1)"))
        .await
        .unwrap_err();
    let after_error = session.transaction_state().await.unwrap();
    assert_eq!(
        after_error,
        Some(if aborts {
            TxState::Aborted
        } else {
            TxState::InTransaction
        })
    );
    raw(session.as_mut(), "ROLLBACK").await.unwrap();
    assert_eq!(
        session.transaction_state().await.unwrap(),
        Some(TxState::Idle)
    );
    raw(session.as_mut(), &format!("DROP TABLE {table}"))
        .await
        .unwrap();
    session.close().await.unwrap();
}

/// idle -> in transaction -> (aborted) -> idle through the session manager, with the statement
/// text gone once the transaction ends. (spec: session-manager › Session states);
/// (spec: driver-framework › Aborted transaction)
pub async fn the_session_state_follows_the_transaction(s: &Suite, table: &str, aborts: bool) {
    let c = connect(&s.cfg).await;
    c.must(&format!("DROP TABLE IF EXISTS {table}")).await;
    c.must(&format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
        .await;

    let m = meta(&c.mgr, &c.session);
    assert_eq!(m.state, SessionStatus::Idle);
    let server_id = c
        .must(s.dialect.backend_id_sql.expect("backend id sql"))
        .await
        .scalar_int();
    assert_eq!(
        m.backend_id,
        Some(server_id.to_string()),
        "server identifier"
    );

    c.must("BEGIN").await;
    let m = meta(&c.mgr, &c.session);
    assert_eq!(m.state, SessionStatus::InTransaction);
    assert!(m.tx_started_at.is_some());

    c.must(&format!("INSERT INTO {table} VALUES (1)")).await;
    let m = meta(&c.mgr, &c.session);
    assert_eq!(m.tx_statement_count, 1);
    assert_eq!(m.tx_breakdown.insert, 1);
    assert!(m.tx_statements[0].text.contains(table));

    c.run(&format!("INSERT INTO {table} VALUES (1)"))
        .await
        .err();
    let m = meta(&c.mgr, &c.session);
    assert_eq!(
        m.state,
        if aborts {
            SessionStatus::Aborted
        } else {
            SessionStatus::InTransaction
        }
    );
    assert_eq!(c.mgr.sessions_open_transactions().len(), 1);

    c.mgr.session_rollback(&c.session).await.unwrap();
    let m = meta(&c.mgr, &c.session);
    assert_eq!(m.state, SessionStatus::Idle);
    assert!(
        m.tx_statements.is_empty(),
        "statement text outlives the transaction"
    );
    assert_eq!(m.tx_statement_count, 0);
    assert_eq!(
        c.must(&format!("SELECT count(*) FROM {table}"))
            .await
            .scalar_int(),
        0
    );
    c.must(&format!("DROP TABLE {table}")).await;
}

/// Setting a level applies to the next transaction; the connection default applies to new sessions.
/// (spec: driver-framework › Set isolation); (spec: sql-console › Connection default)
pub async fn isolation_applies_to_the_next_transaction(
    s: &Suite,
    levels: &[&str],
    effective_sql: &str,
) {
    let c = connect(&s.cfg).await;
    let m = meta(&c.mgr, &c.session);
    assert_eq!(m.supported_isolation, levels);
    let effective = |r: &Run| match &r.rows()[0][0] {
        Value::Text { value, .. } => value.replace('-', " ").to_ascii_uppercase(),
        other => panic!("not text: {other:?}"),
    };

    c.mgr
        .set_session_isolation(&c.session, "serializable")
        .await
        .unwrap();
    assert_eq!(
        meta(&c.mgr, &c.session).isolation.as_deref(),
        Some("SERIALIZABLE")
    );
    c.must("BEGIN").await;
    assert_eq!(effective(&c.must(effective_sql).await), "SERIALIZABLE");
    assert!(
        c.mgr
            .set_session_isolation(&c.session, "READ COMMITTED")
            .await
            .is_err(),
        "no change inside a transaction"
    );
    c.must("ROLLBACK").await;

    let mut with_default = s.cfg.clone();
    with_default.isolation = Some("REPEATABLE READ".into());
    let d = connect(&with_default).await;
    assert_eq!(
        meta(&d.mgr, &d.session).isolation.as_deref(),
        Some("REPEATABLE READ")
    );
    d.must("BEGIN").await;
    assert_eq!(effective(&d.must(effective_sql).await), "REPEATABLE READ");
    d.must("ROLLBACK").await;
}
