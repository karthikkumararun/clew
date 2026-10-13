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
        on_connect: vec![],
        isolation: None,
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

/// (spec: driver-framework › Missing file)
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

/// (spec: driver-framework › Locked database)
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

/// (spec: driver-framework › Result column provenance); (spec: driver-framework › Aliases keep
/// provenance); (spec: driver-framework › Expressions have no source)
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
    assert_eq!(cols[0].name, "pk");
    assert_eq!(cols[0].source_schema.as_deref(), Some("main"));
    assert_eq!(cols[0].source_updatable, Some(true));
    assert_eq!(cols[1].source_updatable, Some(true));
    assert_eq!(cols[2].source_schema, None);
    assert_eq!(
        cols[2].source_updatable,
        Some(false),
        "an expression is not updatable"
    );
}

/// (spec: driver-framework › Result column provenance)
#[tokio::test]
async fn an_attached_database_is_the_source_schema() {
    let (dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let other = dir.path().join("other.db");
    c.must(&format!("ATTACH DATABASE '{}' AS extra", other.display()))
        .await;
    c.must("CREATE TABLE extra.t2 (id INTEGER PRIMARY KEY, v TEXT)")
        .await;
    c.must("INSERT INTO extra.t2 VALUES (1, 'x')").await;
    let r = c.must("SELECT id, v FROM extra.t2").await;
    let cols = r.columns();
    assert_eq!(cols[0].source_schema.as_deref(), Some("extra"));
    assert_eq!(cols[0].source_table.as_deref(), Some("extra.t2"));
    assert_eq!(cols[1].source_column.as_deref(), Some("v"));
}

/// Table structure for result editing: generated columns and views are told apart.
#[tokio::test]
async fn table_meta_reports_generated_columns_and_views() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must(
        "CREATE TABLE g (id INTEGER PRIMARY KEY, a INT, b INT GENERATED ALWAYS AS (a * 2) STORED)",
    )
    .await;
    c.must("CREATE VIEW gv AS SELECT id, a FROM g").await;
    let path = |name: &str| {
        NodePath::root()
            .child(NodeKind::Database, "main")
            .child(NodeKind::Table, name)
    };
    let table = c.mgr.table_meta("conf", &path("g")).await.unwrap();
    assert_eq!(table.is_view, Some(false));
    let generated: Vec<_> = table
        .columns
        .iter()
        .map(|c| c.generated.is_some())
        .collect();
    assert_eq!(generated, [false, false, true]);
    let view = c.mgr.table_meta("conf", &path("gv")).await.unwrap();
    assert_eq!(view.is_view, Some(true));
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

/// (spec: driver-framework › Large values)
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

/// (spec: driver-framework › Completion snapshot)
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

#[tokio::test]
async fn ddl_of_a_table_includes_its_indexes_and_matches_the_golden_output() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE users (id INTEGER PRIMARY KEY)").await;
    c.must(
        "CREATE TABLE orders (\n    id INTEGER PRIMARY KEY,\n    user_id INTEGER NOT NULL REFERENCES users (id),\n    total NUMERIC DEFAULT 0 CHECK (total >= 0)\n)",
    )
    .await;
    c.must("CREATE INDEX orders_user_id_idx ON orders (user_id)")
        .await;
    c.must("CREATE TRIGGER orders_audit AFTER INSERT ON orders BEGIN SELECT 1; END")
        .await;
    let path = NodePath::root()
        .child(NodeKind::Database, "main")
        .child(NodeKind::Table, "orders");
    let ddl = c.mgr.ddl("conf", &path).await.expect("ddl");
    let golden = include_str!("fixtures/sqlite_ddl_orders.golden.sql").trim_end();
    assert_eq!(ddl, golden);
}

#[tokio::test]
async fn count_rows_is_exact_for_tables_and_views() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE \"we\"\"ird\" (id INTEGER)").await;
    c.must("INSERT INTO \"we\"\"ird\" VALUES (1), (2), (3)")
        .await;
    c.must("CREATE VIEW v AS SELECT id FROM \"we\"\"ird\" WHERE id > 1")
        .await;
    let db = NodePath::root().child(NodeKind::Database, "main");
    assert_eq!(
        c.mgr
            .count_rows("conf", &db.child(NodeKind::Table, "we\"ird"))
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        c.mgr
            .count_rows("conf", &db.child(NodeKind::View, "v"))
            .await
            .unwrap(),
        2
    );
    assert!(c
        .mgr
        .count_rows("conf", &db.child(NodeKind::Table, "nope"))
        .await
        .is_err());
}

#[tokio::test]
async fn manual_mode_commit_keeps_the_transaction_open_until_commit() {
    // The console's Manual mode is `BEGIN` on first run, then plain statements, then COMMIT.
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY)").await;

    c.must("BEGIN").await;
    c.must("INSERT INTO t (id) VALUES (1)").await;
    c.must("INSERT INTO t (id) VALUES (2)").await;
    assert_eq!(
        c.mgr.sessions_in_transaction("conf"),
        vec![c.session.clone()],
        "the session reports its open transaction (the close prompt relies on it)"
    );

    let other = c.another_session().await;
    let count = |sid| {
        let mgr = c.mgr.clone();
        async move { run(&mgr, &sid, "SELECT count(*) FROM t").await.scalar_int() }
    };
    assert_eq!(
        count(other.clone()).await,
        0,
        "uncommitted rows stay invisible"
    );

    c.must("COMMIT").await;
    assert!(c.mgr.sessions_in_transaction("conf").is_empty());
    assert_eq!(count(other).await, 2, "committed rows become visible");
    assert_eq!(count(c.session.clone()).await, 2);
}

// ---- table editor changes ---------------------------------------------------------------------

fn change_request(edit_old: &str) -> clew_lib::changes::ChangeRequest {
    let path = NodePath::root()
        .child(NodeKind::Database, "main")
        .child(NodeKind::Table, "t");
    let mut req: clew_lib::changes::ChangeRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "columns": [
            {"name": "id", "type_name": "INTEGER"},
            {"name": "name", "type_name": "TEXT"},
        ],
        "keyColumns": ["id"],
        "edits": [{
            "key": [{"kind": "int", "value": 1}],
            "changes": [{
                "column": "name",
                "old": {"kind": "text", "value": edit_old, "truncated": false},
                "new": {"kind": "value", "value": {"kind": "text", "value": "it's new", "truncated": false}},
            }],
        }],
        "inserts": [{"values": [
            {"column": "id", "value": {"kind": "value", "value": {"kind": "int", "value": 3}}},
            {"column": "name", "value": {"kind": "value", "value": {"kind": "null"}}},
        ]}],
        "deletes": [{"key": [{"kind": "int", "value": 2}]}],
    }))
    .unwrap();
    req.key_columns = vec!["id".into()];
    req
}

#[tokio::test]
async fn staged_changes_apply_in_one_transaction() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old'), (2, 'gone')").await;

    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &statements).await.unwrap();
    assert_eq!(out.applied, 3);
    assert!(out.failure.is_none());

    let rows = run(&c.mgr, &c.session, "SELECT id, name FROM t ORDER BY id")
        .await
        .rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0][1],
        Value::Text {
            value: "it's new".into(),
            truncated: false
        }
    );
    assert_eq!(rows[1][0], Value::Int { value: 3 });
    assert_eq!(rows[1][1], Value::Null);
}

#[tokio::test]
async fn a_changed_row_rolls_the_whole_batch_back() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'changed by someone'), (2, 'keep')")
        .await;

    // The edit expects 'old', so its optimistic check matches nothing.
    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &statements).await.unwrap();
    let failure = out.failure.expect("conflict reported");
    assert!(failure.conflict);
    assert_eq!(failure.target.index, 0);
    assert_eq!(out.applied, 0);

    let n = run(&c.mgr, &c.session, "SELECT count(*) FROM t")
        .await
        .scalar_int();
    assert_eq!(n, 2, "the delete and insert were rolled back too");
    let name = run(&c.mgr, &c.session, "SELECT name FROM t WHERE id = 1")
        .await
        .rows();
    assert_eq!(
        name[0][0],
        Value::Text {
            value: "changed by someone".into(),
            truncated: false
        }
    );
}

#[tokio::test]
async fn a_database_error_rolls_back_and_names_the_statement() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old'), (2, 'gone'), (3, 'dup')")
        .await;

    // Inserting id 3 violates the primary key.
    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &statements).await.unwrap();
    let failure = out.failure.expect("insert fails");
    assert!(!failure.conflict);
    assert_eq!(failure.target.index, 0);
    assert!(failure.message.to_lowercase().contains("unique"));
    let name = run(&c.mgr, &c.session, "SELECT name FROM t WHERE id = 1")
        .await
        .rows();
    assert_eq!(
        name[0][0],
        Value::Text {
            value: "old".into(),
            truncated: false
        },
        "the earlier update was undone"
    );
    // The session is usable afterwards.
    c.must("SELECT 1").await;
}

#[tokio::test]
async fn changes_inside_a_user_transaction_use_a_savepoint() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old'), (2, 'gone')").await;
    c.must("BEGIN").await;

    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &statements).await.unwrap();
    assert!(out.failure.is_none());
    assert_eq!(
        c.mgr.sessions_in_transaction("conf"),
        vec![c.session.clone()],
        "still the user's transaction"
    );
    c.must("ROLLBACK").await;
    let n = run(&c.mgr, &c.session, "SELECT name FROM t WHERE id = 1")
        .await
        .rows();
    assert_eq!(
        n[0][0],
        Value::Text {
            value: "old".into(),
            truncated: false
        },
        "the user can still roll the edits back"
    );
}

/// (spec: result-editing › Manual mode submit)
#[tokio::test]
async fn a_manual_submit_begins_a_transaction_and_stays_in_it_until_rolled_back() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old'), (2, 'gone')").await;
    assert!(c.mgr.sessions_in_transaction("conf").is_empty());

    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let options = clew_lib::changes::ApplyOptions {
        manual: true,
        commit_after: false,
    };
    let out = c
        .mgr
        .apply_changes_with(&c.session, &statements, None, options)
        .await
        .unwrap();
    assert_eq!(
        out.applied, 3,
        "the counter grows by the statements submitted"
    );
    assert!(out.transaction_open);
    assert_eq!(
        c.mgr.sessions_in_transaction("conf"),
        vec![c.session.clone()],
        "the submit began the transaction"
    );
    c.must("ROLLBACK").await;
    let rows = rows_of(&c, &c.session, "SELECT id, name FROM t ORDER BY id").await;
    assert_eq!(rows.len(), 2, "nothing was saved");
    assert_eq!(rows[0][1], Value::text("old"));
}

/// (spec: result-editing › Failure keeps the transaction)
#[tokio::test]
async fn a_failed_manual_submit_leaves_earlier_statements_of_the_transaction_intact() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old'), (2, 'gone')").await;
    c.must("BEGIN").await;
    c.must("INSERT INTO t VALUES (10, 'earlier')").await;

    // The submit's INSERT puts NULL into a NOT NULL column.
    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let options = clew_lib::changes::ApplyOptions {
        manual: true,
        commit_after: false,
    };
    let out = c
        .mgr
        .apply_changes_with(&c.session, &statements, None, options)
        .await
        .unwrap();
    let failure = out.failure.expect("the NOT NULL violation is reported");
    assert!(!failure.conflict);
    assert_eq!(
        failure.target.kind,
        clew_lib::changes::StatementKind::Insert
    );
    assert_eq!(out.applied, 0);
    assert!(out.transaction_open, "the user's transaction is still open");

    let rows = rows_of(&c, &c.session, "SELECT id, name FROM t ORDER BY id").await;
    let ids: Vec<_> = rows.iter().map(|r| r[0].clone()).collect();
    assert_eq!(
        ids,
        [1, 2, 10].map(|n| Value::Int { value: n }),
        "the earlier statement stays, nothing of the submit remains"
    );
    assert_eq!(
        rows[0][1],
        Value::text("old"),
        "the submit's UPDATE was undone"
    );
    c.must("COMMIT").await;
}

/// (spec: result-editing › Failure keeps the transaction)
#[tokio::test]
async fn a_failed_manual_submit_that_began_the_transaction_leaves_none_open() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old'), (2, 'gone')").await;
    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let options = clew_lib::changes::ApplyOptions {
        manual: true,
        commit_after: false,
    };
    let out = c
        .mgr
        .apply_changes_with(&c.session, &statements, None, options)
        .await
        .unwrap();
    assert!(out.failure.is_some());
    assert!(!out.transaction_open);
    assert!(c.mgr.sessions_in_transaction("conf").is_empty());
}

/// (spec: result-editing › Submit and commit)
#[tokio::test]
async fn submit_and_commit_commits_the_open_transaction() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old'), (2, 'gone')").await;
    c.must("BEGIN").await;
    c.must("INSERT INTO t VALUES (10, 'earlier')").await;

    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let options = clew_lib::changes::ApplyOptions {
        manual: true,
        commit_after: true,
    };
    let out = c
        .mgr
        .apply_changes_with(&c.session, &statements, None, options)
        .await
        .unwrap();
    assert_eq!(out.applied, 3);
    assert!(!out.transaction_open);
    assert!(c.mgr.sessions_in_transaction("conf").is_empty());
    // A second connection sees everything: the whole transaction was committed.
    let other = connect(&cfg).await;
    let ids = rows_of(&other, &other.session, "SELECT id FROM t ORDER BY id").await;
    assert_eq!(ids.len(), 3, "1, 3 (inserted) and 10 (earlier)");
}

/// (spec: result-editing › Generated key appears)
#[tokio::test]
async fn rows_are_read_back_by_key_in_the_order_asked_for() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'one', 10), (2, 'it''s two', 20), (3, NULL, 30)")
        .await;
    let target = clew_lib::editability::TableRef {
        schema: Some("main".into()),
        table: "t".into(),
    };
    let key = |n: i64| vec![Value::Int { value: n }];
    let rows = clew_lib::changes::refetch(
        &c.mgr,
        "sqlite",
        &c.session,
        &target,
        &["name".into(), "n".into()],
        &["id".into()],
        &[key(3), key(99), key(2), key(1)],
    )
    .await
    .unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0], vec![Value::Null, Value::Int { value: 30 }]);
    assert!(rows[1].is_empty(), "a row that no longer exists");
    assert_eq!(rows[2][0], Value::text("it's two"));
    assert_eq!(rows[3][0], Value::text("one"));
}

/// (spec: result-editing › Generated key appears)
#[tokio::test]
async fn read_back_sees_uncommitted_changes_of_the_session_and_composite_keys() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE k (a INT, b TEXT, v TEXT, PRIMARY KEY (a, b))")
        .await;
    c.must("BEGIN").await;
    c.must("INSERT INTO k VALUES (1, 'x', 'new'), (2, 'y', 'other')")
        .await;
    let target = clew_lib::editability::TableRef {
        schema: None,
        table: "k".into(),
    };
    let rows = clew_lib::changes::refetch(
        &c.mgr,
        "sqlite",
        &c.session,
        &target,
        &["v".into()],
        &["a".into(), "b".into()],
        &[
            vec![Value::Int { value: 2 }, Value::text("y")],
            vec![Value::Int { value: 1 }, Value::text("x")],
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![vec![Value::text("other")], vec![Value::text("new")]]
    );
    c.must("ROLLBACK").await;
}

// ---- production safeguards --------------------------------------------------------------------

use clew_lib::safety::guard::{Decision, Policy};

fn read_only_cfg(cfg: &ResolvedConfig) -> ResolvedConfig {
    let mut c = cfg.clone();
    c.read_only = true;
    c
}

async fn rows_of(c: &Connected, sid: &str, sql: &str) -> Vec<Vec<Value>> {
    run(&c.mgr, &sid.to_string(), sql).await.rows()
}

#[tokio::test]
async fn a_blocked_write_never_reaches_the_database() {
    let (_dir, cfg) = fresh();
    let seed = connect(&cfg).await;
    seed.must("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        .await;
    seed.must("INSERT INTO t VALUES (1, 'a')").await;
    drop(seed);

    let c = connect(&read_only_cfg(&cfg)).await;
    c.mgr
        .set_policy("conf", Policy::managed("prod", "production", true));
    assert!(c.mgr.session_read_only(&c.session).await.unwrap());
    for sql in [
        "UPDATE t SET v = 'b' WHERE id = 1",
        "DELETE FROM t WHERE id = 1",
        "CREATE TABLE x (a)",
        "DROP TABLE t",
        "PRAGMA query_only = OFF",
        "SELEC 1",
    ] {
        let r = c.run(sql).await;
        assert_eq!(r.err().code, ErrorCode::ReadOnly, "{sql}");
    }
    // Reads and transaction control still work, and nothing changed.
    c.must("BEGIN").await;
    c.must("COMMIT").await;
    assert_eq!(
        rows_of(&c, &c.session, "SELECT v FROM t").await,
        vec![vec![Value::Text {
            value: "a".into(),
            truncated: false
        }]]
    );
}

#[tokio::test]
async fn the_database_refuses_writes_the_classifier_missed() {
    // Straight to the driver session: no guard in the way, only `query_only`.
    let (_dir, cfg) = fresh();
    connect(&cfg)
        .await
        .must("CREATE TABLE t (id INTEGER)")
        .await;
    let driver = clew_lib::drivers::registry::Registry::with_defaults();
    let driver = driver.get("sqlite").unwrap();
    let mut session = driver.open(&read_only_cfg(&cfg)).await.unwrap();
    let (sink, _rx) = clew_lib::drivers::ResultSink::channel(8);
    let err = session
        .execute(
            clew_lib::drivers::ExecRequest {
                sql: "INSERT INTO t VALUES (1)".into(),
                page_size: 10,
                script: false,
                continue_on_error: false,
            },
            sink,
        )
        .await
        .unwrap_err();
    assert!(
        err.message.to_lowercase().contains("readonly")
            || err.message.to_lowercase().contains("read-only"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn switching_one_session_to_read_write_leaves_the_others_read_only() {
    let (_dir, cfg) = fresh();
    let seed = connect(&cfg).await;
    seed.must("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        .await;
    seed.must("INSERT INTO t VALUES (1, 'a')").await;
    drop(seed);

    let c = connect(&read_only_cfg(&cfg)).await;
    c.mgr
        .set_policy("conf", Policy::managed("prod", "production", false));
    let other = c.another_session().await;

    c.mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap();
    assert!(!c.mgr.session_read_only(&c.session).await.unwrap());
    assert!(c.mgr.session_read_only(&other).await.unwrap());
    c.must("UPDATE t SET v = 'b' WHERE id = 1").await;
    let blocked = run(&c.mgr, &other, "UPDATE t SET v = 'c' WHERE id = 1").await;
    assert_eq!(blocked.err().code, ErrorCode::ReadOnly);

    // And back: the database itself is read-only again.
    c.mgr.set_session_read_only(&c.session, true).await.unwrap();
    assert_eq!(
        c.run("UPDATE t SET v = 'd' WHERE id = 1").await.err().code,
        ErrorCode::ReadOnly
    );
    assert_eq!(
        rows_of(&c, &other, "SELECT v FROM t").await,
        vec![vec![Value::Text {
            value: "b".into(),
            truncated: false
        }]]
    );
}

#[tokio::test]
async fn confirm_writes_needs_a_token_that_works_once_for_that_statement() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'a'), (2, 'b')").await;
    c.mgr
        .set_policy("conf", Policy::managed("prod", "production", true));

    let sql = "UPDATE t SET v = 'x' WHERE id = 1";
    let request = |sql: &str| clew_lib::drivers::ExecRequest {
        sql: sql.into(),
        page_size: 10,
        script: false,
        continue_on_error: false,
    };
    let silent: clew_lib::sessions::Emit = std::sync::Arc::new(|_| true);

    // Without a token, nothing runs.
    assert_eq!(c.run(sql).await.err().code, ErrorCode::ConfirmationRequired);
    let report = c.mgr.safety_check(&c.session, sql, false).await.unwrap();
    assert_eq!(report.decision, Decision::Confirm);
    assert_eq!(report.connection, "prod");
    assert_eq!(report.statements.len(), 1);
    let token = report.token.clone().expect("a token");

    // A token for another statement is rejected (and spent).
    let wrong = c
        .mgr
        .execute_confirmed(
            &c.session,
            request("UPDATE t SET v = 'y' WHERE id = 2"),
            Some(token),
            silent.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(wrong.code, ErrorCode::ConfirmationRequired);

    // The right token runs the statement once.
    let token = c
        .mgr
        .safety_check(&c.session, sql, false)
        .await
        .unwrap()
        .token
        .unwrap();
    c.mgr
        .execute_confirmed(
            &c.session,
            request(sql),
            Some(token.clone()),
            silent.clone(),
        )
        .await
        .unwrap();
    let again = c
        .mgr
        .execute_confirmed(&c.session, request(sql), Some(token), silent)
        .await
        .unwrap_err();
    assert_eq!(
        again.code,
        ErrorCode::ConfirmationRequired,
        "a token is single use"
    );
    assert_eq!(
        rows_of(&c, &c.session, "SELECT v FROM t ORDER BY id").await,
        vec![
            vec![Value::Text {
                value: "x".into(),
                truncated: false
            }],
            vec![Value::Text {
                value: "b".into(),
                truncated: false
            }],
        ]
    );
}

#[tokio::test]
async fn dangerous_statements_ask_for_the_name_on_production_only() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE orders (id INTEGER)").await;

    c.mgr.set_policy(
        "conf",
        Policy::managed("prod-postgres", "production", false),
    );
    let prod = c
        .mgr
        .safety_check(&c.session, "DELETE FROM orders", false)
        .await
        .unwrap();
    assert_eq!(prod.decision, Decision::TypedConfirm);
    assert_eq!(prod.typed.as_deref(), Some("prod-postgres"));
    assert_eq!(
        prod.statements[0].danger.as_deref(),
        Some("Delete every row in orders?")
    );
    assert_eq!(
        c.run("DELETE FROM orders").await.err().code,
        ErrorCode::ConfirmationRequired
    );

    c.mgr
        .set_policy("conf", Policy::managed("local-db", "local", false));
    let local = c
        .mgr
        .safety_check(&c.session, "DELETE FROM orders", false)
        .await
        .unwrap();
    assert_eq!(local.decision, Decision::Confirm);
    assert_eq!(local.typed, None);

    // A safe statement on the same connection needs nothing.
    let safe = c
        .mgr
        .safety_check(&c.session, "DELETE FROM orders WHERE id = 1", false)
        .await
        .unwrap();
    assert_eq!(safe.decision, Decision::Allow);
    assert!(safe.token.is_none());
}

#[tokio::test]
async fn table_edits_go_through_the_guard_too() {
    let (_dir, cfg) = fresh();
    let c = connect(&read_only_cfg(&cfg)).await;
    c.mgr
        .set_policy("conf", Policy::managed("prod", "production", true));
    let statements = clew_lib::changes::build("sqlite", &change_request("old")).unwrap();
    let err = c
        .mgr
        .apply_changes(&c.session, &statements)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ReadOnly);

    c.mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap();
    let err = c
        .mgr
        .apply_changes(&c.session, &statements)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ConfirmationRequired);
}

#[tokio::test]
async fn quitting_waits_while_any_session_has_an_open_transaction() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    assert!(!c.mgr.any_in_transaction());
    c.must("BEGIN").await;
    assert!(c.mgr.any_in_transaction());
    c.must("ROLLBACK").await;
    assert!(!c.mgr.any_in_transaction());
}

// ---- query history ----------------------------------------------------------------------------

use clew_lib::history::{self, Outcome};
use clew_lib::store::Store;

/// Wait until `n` entries have been written (recording is fire-and-forget).
async fn history_of(store: &Store, n: usize) -> Vec<clew_lib::history::HistoryEntry> {
    for _ in 0..100 {
        let page = store.history_list("conf", None, None, 100).await.unwrap();
        if page.entries.len() >= n {
            return page.entries;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("expected {n} history entries");
}

#[tokio::test]
async fn every_console_statement_is_recorded_with_its_outcome() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let store = Store::open_in_memory().await.unwrap();
    c.mgr.set_history_sink(history::sink(store.clone()));

    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY)").await;
    c.must("INSERT INTO t (id) VALUES (1), (2), (3)").await;
    c.must("SELECT id FROM t").await;
    assert!(c.run("SELEC 1").await.result.is_err());
    // Transaction control is the console's plumbing and isn't kept.
    c.must("BEGIN").await;
    c.must("COMMIT").await;
    // A script records each of its statements.
    run_script(&c.mgr, &c.session, "SELECT 10; SELECT 20", false).await;

    let entries = history_of(&store, 6).await;
    assert_eq!(entries.len(), 6, "{entries:#?}");
    let newest_first: Vec<_> = entries.iter().rev().collect();
    let sqls: Vec<_> = newest_first.iter().map(|e| e.sql.as_str()).collect();
    assert_eq!(
        sqls,
        [
            "CREATE TABLE t (id INTEGER PRIMARY KEY)",
            "INSERT INTO t (id) VALUES (1), (2), (3)",
            "SELECT id FROM t",
            "SELEC 1",
            "SELECT 10",
            "SELECT 20",
        ]
    );
    assert_eq!(newest_first[1].rows, Some(3), "rows affected by the INSERT");
    assert_eq!(newest_first[2].rows, Some(3), "rows returned by the SELECT");
    assert_eq!(newest_first[3].outcome, Outcome::Error);
    assert_eq!(newest_first[3].rows, None);
    assert!(newest_first.iter().all(|e| e.connection_id == "conf"));
    assert!(newest_first
        .iter()
        .all(|e| e.started_at > 1_700_000_000_000));
    assert_eq!(newest_first[0].outcome, Outcome::Ok);
}

#[tokio::test]
async fn a_cancelled_statement_is_recorded_as_cancelled() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let store = Store::open_in_memory().await.unwrap();
    c.mgr.set_history_sink(history::sink(store.clone()));

    let mgr = c.mgr.clone();
    let sid = c.session.clone();
    let task = tokio::spawn(async move {
        run(
            &mgr,
            &sid,
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    c.mgr.cancel(&c.session).await.expect("cancel");
    let r = task.await.unwrap();
    assert_eq!(r.err().code, ErrorCode::Cancelled);

    let entries = history_of(&store, 1).await;
    assert_eq!(entries[0].outcome, Outcome::Cancelled);
    assert!(entries[0].sql.contains("count(*)"));
}

#[tokio::test]
async fn statements_the_app_runs_itself_are_not_recorded() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let store = Store::open_in_memory().await.unwrap();
    c.mgr.set_history_sink(history::sink(store.clone()));
    c.must("BEGIN").await;
    c.must("CREATE TABLE t (id INTEGER)").await;
    // Closing a connection's transactions (disconnect prompt) runs COMMIT/ROLLBACK internally.
    c.mgr.end_transactions("conf", false).await.unwrap();
    let entries = history_of(&store, 1).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].sql, "CREATE TABLE t (id INTEGER)");
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(store.history_count("conf").await.unwrap(), 1);
}

// ---- export -----------------------------------------------------------------------------------

use clew_lib::exporter::{self, FileExportOptions, FileFormat, QueryExport};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

fn series(n: u64) -> String {
    format!(
        "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < {n}) \
         SELECT n AS id, 'row ' || n AS label, n * 1.5 AS ratio FROM s"
    )
}

#[tokio::test]
async fn exporting_100k_rows_streams_to_disk_page_by_page() {
    let (dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let out = dir.path().join("big.csv");
    let seen: Arc<Mutex<Vec<(u64, u64)>>> = Arc::default();
    let log = seen.clone();
    let on_disk = out.clone();
    let summary = exporter::export_query(
        &c.mgr,
        QueryExport {
            connection_id: "conf".into(),
            sql: series(100_000),
            format: FileFormat::Csv,
            options: FileExportOptions::default(),
            path: out.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(move |rows, bytes| {
                // Rows reach the file while the query is still producing them.
                let flushed = std::fs::metadata(&on_disk).map(|m| m.len()).unwrap_or(0);
                log.lock().unwrap().push((rows, bytes.max(flushed)));
            }),
        },
    )
    .await
    .expect("export");

    assert_eq!(summary.rows, 100_000);
    assert!(!summary.cancelled);
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().count(), 100_001, "header + rows");
    assert!(text.starts_with("id,label,ratio\r\n1,row 1,1.5\r\n"));
    assert!(
        text.ends_with("100000,row 100000,150000\r\n")
            || text.ends_with("100000,row 100000,150000.0\r\n")
    );
    assert_eq!(summary.bytes, text.len() as u64);

    let seen = seen.lock().unwrap();
    // 100k rows arrive in pages of 5,000, and the file grows with them.
    assert!(seen.len() >= 20, "{} progress calls", seen.len());
    assert!(
        seen.windows(2).all(|w| w[0].0 < w[1].0),
        "progress only moves forward"
    );
    let first_half = seen[seen.len() / 2];
    assert!(
        first_half.0 < 100_000 && first_half.1 > 0,
        "bytes exist before the end: {first_half:?}"
    );
}

/// (spec: data-grid › Cancelled export)
#[tokio::test]
async fn cancelling_an_export_deletes_the_partial_file() {
    let (dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let out = dir.path().join("cancelled.csv");
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let rows_seen = Arc::new(AtomicU64::new(0));
    let seen = rows_seen.clone();
    let started = std::time::Instant::now();
    let summary = exporter::export_query(
        &c.mgr,
        QueryExport {
            connection_id: "conf".into(),
            sql: series(5_000_000),
            format: FileFormat::Jsonl,
            options: FileExportOptions::default(),
            path: out.clone(),
            cancel,
            progress: Arc::new(move |rows, _| {
                seen.store(rows, Ordering::Relaxed);
                if rows >= 10_000 {
                    flag.store(true, Ordering::Relaxed);
                }
            }),
        },
    )
    .await
    .expect("a cancelled export is not an error");
    assert!(summary.cancelled);
    assert!(!out.exists(), "the partial file is gone");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "stopped promptly"
    );
    assert!(rows_seen.load(Ordering::Relaxed) < 5_000_000);
}

#[tokio::test]
async fn an_export_that_returns_no_rows_is_an_error_and_leaves_no_file() {
    let (dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER)").await;
    let out = dir.path().join("none.csv");
    let err = exporter::export_query(
        &c.mgr,
        QueryExport {
            connection_id: "conf".into(),
            sql: "INSERT INTO t VALUES (1)".into(),
            format: FileFormat::Csv,
            options: FileExportOptions::default(),
            path: out.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(|_, _| {}),
        },
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("didn't return any rows"), "{err:?}");
    assert!(!out.exists());
}

#[tokio::test]
async fn export_does_not_pollute_the_query_history() {
    let (dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let store = Store::open_in_memory().await.unwrap();
    c.mgr.set_history_sink(history::sink(store.clone()));
    exporter::export_query(
        &c.mgr,
        QueryExport {
            connection_id: "conf".into(),
            sql: series(10),
            format: FileFormat::Json,
            options: FileExportOptions::default(),
            path: dir.path().join("x.json"),
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(|_, _| {}),
        },
    )
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(store.history_count("conf").await.unwrap(), 0);
}

// ---- table metadata ---------------------------------------------------------------------------

#[tokio::test]
async fn table_meta_reports_columns_keys_indexes_and_relations() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)")
        .await;
    c.must(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
         status TEXT DEFAULT 'new', note TEXT)",
    )
    .await;
    c.must("CREATE INDEX orders_status_idx ON orders (status, note)")
        .await;
    c.must("CREATE TABLE order_items (order_id INTEGER REFERENCES orders (id), n INTEGER)")
        .await;

    let db = NodePath::root().child(NodeKind::Database, "main");
    let orders = c
        .mgr
        .table_meta("conf", &db.child(NodeKind::Table, "orders"))
        .await
        .unwrap();

    let col = |n: &str| orders.columns.iter().find(|c| c.name == n).unwrap();
    assert_eq!(
        orders
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["id", "user_id", "status", "note"]
    );
    assert!(col("id").primary_key);
    assert!(!col("user_id").nullable && !col("user_id").primary_key);
    assert!(col("note").nullable);
    assert_eq!(col("status").default.as_deref(), Some("'new'"));
    assert_eq!(col("status").type_name, "TEXT");

    let idx = orders
        .indexes
        .iter()
        .find(|i| i.name == "orders_status_idx")
        .unwrap();
    assert_eq!(idx.columns, ["status", "note"]);
    assert!(!idx.unique && !idx.primary);

    assert_eq!(orders.foreign_keys.len(), 1);
    let fk = &orders.foreign_keys[0];
    assert_eq!(
        (
            fk.ref_table.as_str(),
            fk.columns.as_slice(),
            fk.ref_columns.as_slice()
        ),
        (
            "users",
            &["user_id".to_string()][..],
            &["id".to_string()][..]
        )
    );
    assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));

    assert_eq!(orders.referenced_by.len(), 1);
    assert_eq!(orders.referenced_by[0].table, "order_items");
    assert_eq!(orders.referenced_by[0].columns, ["order_id"]);
    assert_eq!(orders.referenced_by[0].ref_columns, ["id"]);

    let users = c
        .mgr
        .table_meta("conf", &db.child(NodeKind::Table, "users"))
        .await
        .unwrap();
    assert!(
        users
            .indexes
            .iter()
            .any(|i| i.unique && i.columns == ["email"]),
        "{:?}",
        users.indexes
    );
    assert_eq!(
        users
            .referenced_by
            .iter()
            .map(|r| r.table.as_str())
            .collect::<Vec<_>>(),
        ["orders"]
    );
    assert!(users.foreign_keys.is_empty());
}

// ---- session manager -------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_reports_idle_and_in_transaction() {
    let (_dir, cfg) = fresh();
    the_driver_reports_the_transaction_state(&suite_for(cfg), "sqlite", "sm_sq_state", false).await;
}

/// (spec: driver-framework › Unsupported level)
#[tokio::test]
async fn sqlite_reports_its_fixed_isolation_and_offers_no_choice() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let m = c
        .mgr
        .sessions_list()
        .into_iter()
        .find(|m| m.id == c.session)
        .unwrap();
    assert_eq!(m.isolation.as_deref(), Some("SERIALIZABLE"));
    assert!(m.supported_isolation.is_empty());
    assert!(m.isolation_note.is_some());
    assert_eq!(m.backend_id, None);
    let err = c
        .mgr
        .set_session_isolation(&c.session, "SERIALIZABLE")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported);
}
