//! SQLite conformance + driver-specific tests. Runs in plain `cargo test`: every test works on its
//! own temporary database file.

mod conformance;

use clew_lib::drivers::introspect::{NodeKind, NodePath, TreeNode};
use clew_lib::drivers::{
    ErrorCode, FullValueRequest, ResolvedConfig, Target, TlsConfig, Value, ValueKind,
};
use conformance::*;

fn cfg_at(path: &std::path::Path) -> ResolvedConfig {
    ResolvedConfig {
        driver: "sqlite".into(),
        target: Target::File {
            path: path.to_string_lossy().into_owned(),
            create_if_missing: true,
            read_only: false,
        },
        user: None,
        password: None,
        database: None,
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 5,
        query_timeout_secs: None,
        read_only: false,
        options: Default::default(),
    }
}

/// A temp directory and a config pointing at a fresh database file in it.
fn fresh() -> (tempfile::TempDir, ResolvedConfig) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = cfg_at(&dir.path().join("test.sqlite"));
    (dir, cfg)
}

fn suite_for(cfg: ResolvedConfig) -> Suite {
    Suite {
        cfg,
        dialect: Dialect {
            product: "SQLite",
            generate_rows: |n| {
                format!("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < {n}) SELECT n FROM seq")
            },
            sleep_long: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
            syntax_error: "SELEC 1",
            error_position: Some(1),
            backend_id_sql: None,
            kill_sql: None,
        },
    }
}

// ---- shared conformance ----------------------------------------------------------------------

macro_rules! conformance {
    ($($name:ident => $body:expr;)*) => {
        $( #[tokio::test] async fn $name() { let (_dir, cfg) = fresh(); let s = suite_for(cfg); ($body)(s).await } )*
    };
}

conformance! {
    test_connection => |s: Suite| async move { test_connection_reports_the_server(&s).await };
    session_server => |s: Suite| async move { session_reports_the_server(&s).await };
    paging => |s: Suite| async move { large_results_are_paged(&s).await };
    abandoning_a_result => |s: Suite| async move { a_new_statement_abandons_an_open_result(&s).await };
    columns => |s: Suite| async move { column_metadata(&s).await };
    rows_affected => |s: Suite| async move { rows_affected_without_a_result_set(&s, "conf_sq_affected").await };
    scripts => |s: Suite| async move { scripts_run_in_order_and_stop_on_error(&s).await };
    syntax_error_position => |s: Suite| async move { syntax_errors_carry_a_position(&s).await };
    transactions => |s: Suite| async move { transactions_span_statements(&s, "conf_sq_tx").await };
    temp_tables => |s: Suite| async move { temporary_tables_belong_to_the_session(&s, "conf_sq_temp").await };
    cancel => |s: Suite| async move { cancel_stops_a_long_query(&s).await };
    timeout => |s: Suite| async move { the_query_timeout_cancels_the_statement(&s).await };
    introspection_is_independent_of_the_session => |s: Suite| async move { introspection_works_while_a_query_runs(&s).await };
    unknown_driver => |s: Suite| async move { unknown_driver_is_unavailable(&s.cfg).await };
}

// ---- files -----------------------------------------------------------------------------------

#[tokio::test]
async fn a_missing_file_is_file_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = cfg_at(&dir.path().join("absent.sqlite"));
    cfg.target = Target::File {
        path: dir
            .path()
            .join("absent.sqlite")
            .to_string_lossy()
            .into_owned(),
        create_if_missing: false,
        read_only: false,
    };
    let err = manager()
        .test_connection(&cfg)
        .await
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::FileNotFound);
    assert!(err.message.contains("absent.sqlite"));
    let err = manager().connect("x", cfg).await.expect_err("must fail");
    assert_eq!(err.code, ErrorCode::FileNotFound);
    assert!(
        !dir.path().join("absent.sqlite").exists(),
        "nothing was created"
    );
}

#[tokio::test]
async fn create_if_missing_creates_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("new.sqlite");
    let c = connect(&cfg_at(&file)).await;
    c.must("CREATE TABLE t (id INTEGER)").await;
    assert!(file.exists());
}

#[tokio::test]
async fn data_persists_across_sessions_and_reconnects() {
    let (_dir, cfg) = fresh();
    {
        let c = connect(&cfg).await;
        c.must("CREATE TABLE t (id INTEGER)").await;
        c.must("INSERT INTO t VALUES (5)").await;
    }
    let again = connect(&cfg).await;
    assert_eq!(again.must("SELECT id FROM t").await.scalar_int(), 5);
}

#[tokio::test]
async fn read_only_files_refuse_writes() {
    let (dir, cfg) = fresh();
    {
        let c = connect(&cfg).await;
        c.must("CREATE TABLE t (id INTEGER)").await;
        c.must("INSERT INTO t VALUES (1)").await;
    }
    let mut ro = cfg_at(&dir.path().join("test.sqlite"));
    ro.target = Target::File {
        path: dir
            .path()
            .join("test.sqlite")
            .to_string_lossy()
            .into_owned(),
        create_if_missing: false,
        read_only: true,
    };
    let c = connect(&ro).await;
    assert_eq!(c.must("SELECT count(*) FROM t").await.scalar_int(), 1);
    let w = c.run("INSERT INTO t VALUES (2)").await;
    assert_eq!(w.err().code, ErrorCode::QueryFailed);
    assert!(
        w.err().message.to_lowercase().contains("readonly")
            || w.err().message.to_lowercase().contains("read-only"),
        "{}",
        w.err().message
    );
    // the connection-level read-only flag does the same
    let mut flagged = cfg_at(&dir.path().join("test.sqlite"));
    flagged.read_only = true;
    flagged.target = Target::File {
        path: dir
            .path()
            .join("test.sqlite")
            .to_string_lossy()
            .into_owned(),
        create_if_missing: false,
        read_only: false,
    };
    assert!(connect(&flagged)
        .await
        .run("DELETE FROM t")
        .await
        .result
        .is_err());
}

// ---- locking ---------------------------------------------------------------------------------

#[tokio::test]
async fn a_write_blocked_past_the_busy_timeout_is_database_locked() {
    let (_dir, mut cfg) = fresh();
    cfg.options.insert("busy_timeout_ms".into(), "300".into());
    let holder = connect(&cfg).await;
    holder.must("CREATE TABLE t (id INTEGER)").await;
    holder.must("BEGIN IMMEDIATE").await; // takes the write lock

    let other = holder.another_session().await;
    let started = std::time::Instant::now();
    let r = run(&holder.mgr, &other, "INSERT INTO t VALUES (1)").await;
    assert_eq!(r.err().code, ErrorCode::DatabaseLocked, "{:?}", r.err());
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(250),
        "waited for the busy timeout"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert!(r.err().message.contains("locked"));

    // once the holder lets go, the same write succeeds
    holder.must("COMMIT").await;
    assert!(run(&holder.mgr, &other, "INSERT INTO t VALUES (1)")
        .await
        .result
        .is_ok());
}

#[tokio::test]
async fn the_default_busy_timeout_is_five_seconds() {
    // config-level check; waiting five real seconds here would only slow the suite down
    let (_dir, cfg) = fresh();
    assert!(!cfg.options.contains_key("busy_timeout_ms"));
    assert_eq!(
        clew_lib::drivers::sqlite::config::DEFAULT_BUSY_TIMEOUT,
        std::time::Duration::from_secs(5)
    );
}

// ---- results ---------------------------------------------------------------------------------

#[tokio::test]
async fn values_keep_their_own_storage_class() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE v (i INTEGER, r REAL, t TEXT, b BLOB, flag BOOLEAN, big INTEGER, mixed INTEGER, n TEXT)").await;
    c.must("INSERT INTO v VALUES (42, 1.5, 'héllo', X'DEAD', 1, 9007199254740993, 'not a number', NULL)").await;
    let r = c.must("SELECT * FROM v").await;
    let row = &r.rows()[0];
    assert_eq!(row[0], Value::Int { value: 42 });
    assert_eq!(row[1], Value::Float { value: 1.5 });
    assert_eq!(row[2], Value::text("héllo"));
    assert_eq!(row[3], Value::bytes(&[0xde, 0xad]));
    assert_eq!(row[4], Value::Bool { value: true });
    assert_eq!(
        row[5],
        Value::Bigint {
            value: "9007199254740993".into()
        }
    );
    assert_eq!(
        row[6],
        Value::text("not a number"),
        "SQLite lets a column hold any type"
    );
    assert_eq!(row[7], Value::Null);
    let kinds: Vec<ValueKind> = r.columns().iter().map(|c| c.kind).collect();
    assert_eq!(kinds[0], ValueKind::Int);
    assert_eq!(kinds[3], ValueKind::Bytes);
    assert_eq!(kinds[4], ValueKind::Bool);
}

#[tokio::test]
async fn expressions_and_computed_columns_decode_too() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let r = c
        .must("SELECT 1 + 1, 2.5 * 2, 'a' || 'b', x'01', NULL, typeof(1)")
        .await;
    let row = &r.rows()[0];
    assert_eq!(row[0], Value::Int { value: 2 });
    assert_eq!(row[1], Value::Float { value: 5.0 });
    assert_eq!(row[2], Value::text("ab"));
    assert_eq!(row[3], Value::bytes(&[1]));
    assert_eq!(row[4], Value::Null);
    assert_eq!(row[5], Value::text("integer"));
}

#[tokio::test]
async fn source_table_and_column_are_reported_for_editing() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE src (id INTEGER PRIMARY KEY, label TEXT)")
        .await;
    c.must("INSERT INTO src VALUES (1, 'a')").await;
    let r = c
        .must("SELECT id AS pk, label, id + 1 AS computed FROM src")
        .await;
    let cols = r.columns();
    assert_eq!(cols[0].source_table.as_deref(), Some("src"));
    assert_eq!(
        cols[0].source_column.as_deref(),
        Some("id"),
        "the original name, not the alias"
    );
    assert_eq!(cols[1].source_column.as_deref(), Some("label"));
    assert_eq!(cols[2].source_table, None);
}

#[tokio::test]
async fn explain_query_plan_returns_rows() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE e (id INTEGER PRIMARY KEY, a INTEGER)")
        .await;
    c.must("CREATE INDEX e_a ON e (a)").await;
    let r = c
        .must("EXPLAIN QUERY PLAN SELECT * FROM e WHERE a = 1")
        .await;
    assert!(!r.rows().is_empty());
    let detail = r.rows()[0]
        .iter()
        .find_map(|v| match v {
            Value::Text { value, .. } => Some(value.clone()),
            _ => None,
        })
        .unwrap();
    assert!(detail.contains("e_a"), "{detail}");
}

#[tokio::test]
async fn foreign_keys_are_enforced() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE p (id INTEGER PRIMARY KEY)").await;
    c.must("CREATE TABLE ch (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id))")
        .await;
    let r = c.run("INSERT INTO ch VALUES (1, 99)").await;
    assert_eq!(r.err().code, ErrorCode::QueryFailed);
    assert!(
        r.err().message.to_lowercase().contains("foreign key"),
        "{}",
        r.err().message
    );
}

#[tokio::test]
async fn large_values_are_truncated_and_can_be_fetched_whole() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT, blob_ BLOB)")
        .await;
    c.must(
        "INSERT INTO big VALUES (1, replace(hex(zeroblob(750000)), '0', 'x'), zeroblob(1200000))",
    )
    .await;
    let r = c.must("SELECT body, blob_ FROM big").await;
    let row = &r.rows()[0];
    let Value::Text { value, truncated } = &row[0] else {
        panic!("{:?}", row[0])
    };
    assert!(truncated);
    assert_eq!(value.len(), 64 * 1024);
    let Value::Bytes { len, truncated, .. } = &row[1] else {
        panic!()
    };
    assert!(truncated);
    assert_eq!(*len, 1_200_000);

    let table = NodePath::root()
        .child(NodeKind::Database, "main")
        .child(NodeKind::Table, "big");
    let full = c
        .mgr
        .fetch_full_value(
            &c.session,
            FullValueRequest {
                table: table.clone(),
                column: "body".into(),
                key: vec![("id".into(), Value::Int { value: 1 })],
            },
        )
        .await
        .expect("full value");
    let Value::Text { value, truncated } = full else {
        panic!()
    };
    assert!(!truncated);
    assert_eq!(value.len(), 1_500_000);
    assert!(c
        .mgr
        .fetch_full_value(
            &c.session,
            FullValueRequest {
                table,
                column: "body".into(),
                key: vec![("id".into(), Value::Int { value: 99 })],
            }
        )
        .await
        .is_err());
}

// ---- introspection ---------------------------------------------------------------------------

async fn children(c: &Connected, path: &NodePath) -> Vec<TreeNode> {
    c.mgr.introspect("conf", path).await.expect("introspect")
}

fn find<'a>(nodes: &'a [TreeNode], name: &str) -> &'a TreeNode {
    nodes.iter().find(|n| n.name == name).unwrap_or_else(|| {
        panic!(
            "no node {name} in {:?}",
            nodes.iter().map(|n| &n.name).collect::<Vec<_>>()
        )
    })
}

#[tokio::test]
async fn the_tree_loads_lazily_down_to_columns() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'anon')")
        .await;
    c.must("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), total NUMERIC)").await;
    c.must("CREATE UNIQUE INDEX orders_user_idx ON orders (user_id, total)")
        .await;
    c.must("CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100")
        .await;
    c.must("CREATE TRIGGER orders_ai AFTER INSERT ON orders BEGIN UPDATE users SET name = name WHERE id = NEW.user_id; END").await;
    c.must("INSERT INTO users VALUES (1, 'a')").await;
    c.must("ANALYZE").await;

    // databases: just main for a plain file
    let dbs = children(&c, &NodePath::root()).await;
    assert_eq!(
        dbs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
        ["main"]
    );
    assert!(dbs[0].detail.as_deref().unwrap().ends_with("test.sqlite"));

    // groups with counts
    let groups = children(&c, &dbs[0].path).await;
    let names: Vec<_> = groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, ["tables", "views", "indexes", "triggers"]);
    assert_eq!(find(&groups, "tables").detail.as_deref(), Some("2"));
    assert_eq!(find(&groups, "views").detail.as_deref(), Some("1"));
    assert_eq!(find(&groups, "triggers").detail.as_deref(), Some("1"));

    let tables = children(&c, &find(&groups, "tables").path).await;
    assert_eq!(
        tables.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
        ["orders", "users"]
    );
    assert_eq!(
        find(&tables, "users").detail.as_deref(),
        Some("1"),
        "row estimate from ANALYZE"
    );
    assert_eq!(
        children(&c, &find(&groups, "views").path).await[0].name,
        "big_orders"
    );
    let idx = children(&c, &find(&groups, "indexes").path).await;
    assert_eq!(
        (idx[0].name.as_str(), idx[0].detail.as_deref()),
        ("orders_user_idx", Some("ON orders"))
    );
    let trg = children(&c, &find(&groups, "triggers").path).await;
    assert_eq!(
        (trg[0].name.as_str(), trg[0].detail.as_deref()),
        ("orders_ai", Some("ON orders"))
    );

    // columns of orders
    let cols = children(&c, &find(&tables, "orders").path).await;
    let id = find(&cols, "id").column.clone().unwrap();
    assert!(id.primary_key && !id.nullable);
    let uid = find(&cols, "user_id").column.clone().unwrap();
    assert_eq!(uid.foreign_key.as_deref(), Some("users.id"));
    assert!(!uid.nullable);
    assert!(find(&cols, "total").column.clone().unwrap().nullable);
    assert_eq!(
        find(&cols, "total").column.clone().unwrap().type_name,
        "NUMERIC"
    );
    assert_eq!(
        find(&cols, "user_id").detail.as_deref(),
        Some("INTEGER → users.id")
    );
    let users = children(&c, &find(&tables, "users").path).await;
    assert_eq!(
        find(&users, "name")
            .column
            .clone()
            .unwrap()
            .default
            .as_deref(),
        Some("'anon'")
    );
    assert!(cols
        .iter()
        .any(|n| n.kind == NodeKind::PrimaryKey && n.detail.as_deref() == Some("(id)")));
    assert!(cols
        .iter()
        .any(|n| n.kind == NodeKind::ForeignKey
            && n.detail.as_deref() == Some("(user_id) → users(id)")));
    assert!(cols.iter().any(
        |n| n.kind == NodeKind::Index && n.detail.as_deref() == Some("unique (user_id, total)")
    ));

    // views list their columns too
    let view_cols = children(
        &c,
        &find(
            &children(&c, &find(&groups, "views").path).await,
            "big_orders",
        )
        .path,
    )
    .await;
    assert!(view_cols.iter().any(|n| n.name == "total"));
}

#[tokio::test]
async fn attached_databases_appear_next_to_main() {
    let dir = tempfile::tempdir().unwrap();
    let extra = dir.path().join("logs.sqlite");
    // create the second database file with a table in it
    {
        let c = connect(&cfg_at(&extra)).await;
        c.must("CREATE TABLE entries (id INTEGER PRIMARY KEY, msg TEXT)")
            .await;
    }
    let mut cfg = cfg_at(&dir.path().join("main.sqlite"));
    cfg.options
        .insert("attach:logs".into(), extra.to_string_lossy().into_owned());
    let c = connect(&cfg).await;
    c.must("CREATE TABLE users (id INTEGER)").await;

    // the session sees the attached database
    c.must("INSERT INTO logs.entries (msg) VALUES ('hi')").await;
    assert_eq!(
        c.must("SELECT count(*) FROM logs.entries")
            .await
            .scalar_int(),
        1
    );

    let dbs = children(&c, &NodePath::root()).await;
    assert_eq!(
        dbs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
        ["main", "logs"]
    );
    let logs_groups = children(&c, &find(&dbs, "logs").path).await;
    let logs_tables = children(&c, &find(&logs_groups, "tables").path).await;
    assert_eq!(logs_tables[0].name, "entries");
    let cols = children(&c, &logs_tables[0].path).await;
    assert!(cols.iter().any(|n| n.name == "msg"));

    let snap = c.mgr.completion_snapshot("conf", "").await.unwrap();
    let names: Vec<_> = snap.schemas.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["main", "logs"]);
}

#[tokio::test]
async fn ddl_is_the_stored_create_statement() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY)").await;
    c.must("CREATE INDEX t_idx ON t (id)").await;
    c.must("CREATE VIEW v AS SELECT id FROM t").await;
    let db = NodePath::root().child(NodeKind::Database, "main");
    let ddl = |kind, name: &str| {
        let path = db.child(kind, name);
        let mgr = c.mgr.clone();
        async move { mgr.ddl("conf", &path).await.expect("ddl") }
    };
    assert!(ddl(NodeKind::Table, "t")
        .await
        .starts_with("CREATE TABLE t"));
    assert!(ddl(NodeKind::Index, "t_idx").await.contains("INDEX t_idx"));
    assert!(ddl(NodeKind::View, "v").await.contains("VIEW v"));
    assert_eq!(
        c.mgr
            .ddl("conf", &db.child(NodeKind::Table, "nope"))
            .await
            .unwrap_err()
            .code,
        ErrorCode::QueryFailed
    );
}

#[tokio::test]
async fn the_completion_snapshot_has_tables_columns_and_functions() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE items (id INTEGER, label TEXT)").await;
    c.must("CREATE VIEW v_items AS SELECT id FROM items").await;
    let snap = c
        .mgr
        .completion_snapshot("conf", "main")
        .await
        .expect("snapshot");
    assert_eq!(snap.schemas.len(), 1);
    let s = &snap.schemas[0];
    let items = s.tables.iter().find(|t| t.name == "items").unwrap();
    let cols: Vec<_> = items
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str()))
        .collect();
    assert_eq!(cols, [("id", "INTEGER"), ("label", "TEXT")]);
    assert_eq!(
        s.tables.iter().find(|t| t.name == "v_items").unwrap().kind,
        NodeKind::View
    );
    assert!(
        s.functions.iter().any(|f| f == "count"),
        "built-in functions are offered"
    );
}

#[tokio::test]
async fn an_empty_database_introspects_cleanly() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let dbs = children(&c, &NodePath::root()).await;
    let groups = children(&c, &dbs[0].path).await;
    assert!(groups.iter().all(|g| !g.has_children));
}
