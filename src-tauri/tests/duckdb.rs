//! DuckDB conformance + driver-specific tests. Runs in plain `cargo test` (the library is
//! bundled): every test works on its own temporary database file.

mod conformance;

use clew_lib::drivers::introspect::{NodeKind, NodePath, TreeNode};
use clew_lib::drivers::{ErrorCode, ResolvedConfig, Target, TlsConfig, Value, ValueKind};
use conformance::*;

fn cfg_at(path: &str, create: bool, read_only: bool) -> ResolvedConfig {
    ResolvedConfig {
        driver: "duckdb".into(),
        target: Target::File {
            path: path.to_string(),
            create_if_missing: create,
            read_only,
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
    }
}

fn fresh() -> (tempfile::TempDir, ResolvedConfig) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = cfg_at(
        &dir.path().join("test.duckdb").to_string_lossy(),
        true,
        false,
    );
    (dir, cfg)
}

fn suite_for(cfg: ResolvedConfig) -> Suite {
    Suite {
        cfg,
        dialect: Dialect {
            product: "DuckDB",
            generate_rows: |n| format!("SELECT * FROM range(1, {} + 1) t(n)", n),
            sleep_long: "SELECT sum(hash(i)) FROM range(100000000000) t(i)",
            syntax_error: "SELEC 1",
            error_position: Some(1),
            backend_id_sql: None,
            kill_sql: None,
        },
    }
}

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
    rows_affected => |s: Suite| async move { rows_affected_without_a_result_set(&s, "conf_dk_affected").await };
    scripts => |s: Suite| async move { scripts_run_in_order_and_stop_on_error(&s).await };
    syntax_error_position => |s: Suite| async move { syntax_errors_carry_a_position(&s).await };
    transactions => |s: Suite| async move { transactions_span_statements(&s, "conf_dk_tx").await };
    temp_tables => |s: Suite| async move { temporary_tables_belong_to_the_session(&s, "conf_dk_temp").await };
    cancel => |s: Suite| async move { cancel_stops_a_long_query(&s).await };
    timeout => |s: Suite| async move { the_query_timeout_cancels_the_statement(&s).await };
    introspection_is_independent_of_the_session => |s: Suite| async move { introspection_works_while_a_query_runs(&s).await };
    unknown_driver => |s: Suite| async move { unknown_driver_is_unavailable(&s.cfg).await };
}

// ---- files and modes -------------------------------------------------------------------------

#[tokio::test]
async fn a_missing_file_is_file_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("absent.duckdb");
    let cfg = cfg_at(&file.to_string_lossy(), false, false);
    let err = manager()
        .test_connection(&cfg)
        .await
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::FileNotFound);
    assert!(!file.exists(), "nothing was created");
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
async fn an_in_memory_database_is_shared_by_the_sessions_and_the_tree() {
    let cfg = cfg_at(":memory:", false, false);
    let c = connect(&cfg).await;
    c.must("CREATE TABLE mem_t (a INTEGER)").await;
    let other = c.another_session().await;
    assert_eq!(
        run(&c.mgr, &other, "SELECT count(*) FROM mem_t")
            .await
            .scalar_int(),
        0
    );
    let dbs = c.mgr.introspect("conf", &NodePath::root()).await.unwrap();
    assert!(dbs.iter().any(|d| d.name == "memory"), "{dbs:?}");
}

#[tokio::test]
async fn read_only_files_refuse_writes_at_the_database() {
    let (_dir, cfg) = fresh();
    {
        let c = connect(&cfg).await;
        c.must("CREATE TABLE t (id INTEGER)").await;
    }
    let mut ro = cfg.clone();
    ro.read_only = true;
    let c = connect(&ro).await;
    assert_eq!(c.must("SELECT count(*) FROM t").await.scalar_int(), 0);
    // The guard stops it first; the database is read-only underneath as well.
    let r = c.run("INSERT INTO t VALUES (1)").await;
    assert_eq!(r.err().code, ErrorCode::ReadOnly);
    let registry = clew_lib::drivers::registry::Registry::with_defaults();
    let mut raw = registry.get("duckdb").unwrap().open(&ro).await.unwrap();
    let (sink, _rx) = clew_lib::drivers::ResultSink::channel(8);
    let err = raw
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
        err.message.to_lowercase().contains("read-only")
            || err.message.to_lowercase().contains("read only"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn switching_a_session_to_read_write_is_not_possible() {
    let (_dir, cfg) = fresh();
    let mut ro = cfg.clone();
    ro.read_only = true;
    {
        connect(&cfg)
            .await
            .must("CREATE TABLE t (id INTEGER)")
            .await;
    }
    let c = connect(&ro).await;
    let err = c
        .mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported);
    assert!(
        c.mgr.session_read_only(&c.session).await.unwrap(),
        "still read-only"
    );
}

// ---- querying files and values ---------------------------------------------------------------

#[tokio::test]
async fn parquet_files_can_be_queried_directly() {
    let (dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let file = dir.path().join("events.parquet");
    let file = file.to_string_lossy().replace('\\', "/");
    c.must(&format!(
        "COPY (SELECT i AS id, 'e' || i AS name FROM range(1, 4) t(i)) TO '{file}' (FORMAT PARQUET)"
    ))
    .await;
    let r = c
        .must(&format!("SELECT * FROM '{file}' ORDER BY id LIMIT 100"))
        .await;
    assert_eq!(r.rows().len(), 3);
    assert_eq!(text(&r.rows()[2][1]), "e3");
}

#[tokio::test]
async fn values_keep_their_types() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let r = c
        .must(
            "SELECT 170141183460469231731687303715884105727::HUGEINT AS h, [1, 2] AS l, {'a': 1, 'b': 'x'} AS s, \
             MAP {'k': 1} AS m, INTERVAL 3 DAY AS i, '123e4567-e89b-12d3-a456-426614174000'::UUID AS u, \
             12.50::DECIMAL(10,2) AS d, TIMESTAMPTZ '2026-01-02 03:04:05+00' AS tz, DATE '2026-01-02' AS dt, \
             TIME '03:04:05' AS tm, 'abc'::BLOB AS b, true AS e, NULL AS n",
        )
        .await;
    let row = &r.rows()[0];
    let kinds: Vec<_> = r.columns().iter().map(|c| c.kind).take(12).collect();
    assert_eq!(
        kinds,
        [
            ValueKind::Bigint,
            ValueKind::Array,
            ValueKind::Json,
            ValueKind::Json,
            ValueKind::Interval,
            ValueKind::Uuid,
            ValueKind::Decimal,
            ValueKind::Timestamptz,
            ValueKind::Date,
            ValueKind::Time,
            ValueKind::Bytes,
            ValueKind::Bool,
        ]
    );
    assert_eq!(
        row[0],
        Value::Bigint {
            value: "170141183460469231731687303715884105727".into()
        }
    );
    assert_eq!(
        row[1],
        Value::Array {
            value: vec![Value::Int { value: 1 }, Value::Int { value: 2 }]
        }
    );
    assert_eq!(row[2], Value::json(serde_json::json!({"a": 1, "b": "x"})));
    assert_eq!(row[3], Value::json(serde_json::json!({"k": 1})));
    assert_eq!(
        row[4],
        Value::Interval {
            value: "3 days".into()
        }
    );
    assert_eq!(
        row[5],
        Value::Uuid {
            value: "123e4567-e89b-12d3-a456-426614174000".into()
        }
    );
    assert_eq!(
        row[6],
        Value::Decimal {
            value: "12.50".into()
        }
    );
    assert_eq!(
        row[7],
        Value::Timestamptz {
            value: "2026-01-02T03:04:05Z".into()
        }
    );
    assert_eq!(
        row[8],
        Value::Date {
            value: "2026-01-02".into()
        }
    );
    assert_eq!(
        row[9],
        Value::Time {
            value: "03:04:05".into()
        }
    );
    assert_eq!(
        row[10],
        Value::Bytes {
            value: "616263".into(),
            len: 3,
            truncated: false
        }
    );
    assert_eq!(row[11], Value::Bool { value: true });
    assert_eq!(row[12], Value::Null);
}

#[tokio::test]
async fn type_names_are_duckdbs_own() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let r = c
        .must("SELECT 1::BIGINT AS a, 1.5::DECIMAL(10,2) AS b, now() AS c, 'x' AS d, [1] AS e")
        .await;
    let names: Vec<_> = r.columns().iter().map(|c| c.type_name.clone()).collect();
    assert_eq!(
        names,
        [
            "BIGINT",
            "DECIMAL(10,2)",
            "TIMESTAMP WITH TIME ZONE",
            "VARCHAR",
            "LIST"
        ]
    );
}

#[tokio::test]
async fn statements_that_change_nothing_report_zero_rows_affected() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    assert_eq!(
        c.must("CREATE TABLE t (id INTEGER)")
            .await
            .ok()
            .rows_affected,
        Some(0)
    );
    assert_eq!(
        c.must("INSERT INTO t VALUES (1), (2)")
            .await
            .ok()
            .rows_affected,
        Some(2)
    );
    assert_eq!(
        c.must("DELETE FROM t WHERE id = 99")
            .await
            .ok()
            .rows_affected,
        Some(0)
    );
    assert_eq!(
        c.must("UPDATE t SET id = id + 1").await.ok().rows_affected,
        Some(2)
    );
    assert_eq!(c.must("BEGIN").await.ok().rows_affected, Some(0));
    c.must("ROLLBACK").await;
}

// ---- introspection ---------------------------------------------------------------------------

async fn children(c: &Connected, path: &NodePath) -> Vec<TreeNode> {
    c.mgr.introspect("conf", path).await.expect("children")
}

fn find<'a>(nodes: &'a [TreeNode], name: &str) -> &'a TreeNode {
    nodes.iter().find(|n| n.name == name).unwrap_or_else(|| {
        panic!(
            "no node {name} in {:?}",
            nodes.iter().map(|n| &n.name).collect::<Vec<_>>()
        )
    })
}

async fn seed(c: &Connected) {
    c.must("CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR NOT NULL UNIQUE)")
        .await;
    c.must("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users (id), status VARCHAR DEFAULT 'new', note VARCHAR)").await;
    c.must("CREATE INDEX orders_status_idx ON orders (status)")
        .await;
    c.must("CREATE VIEW open_orders AS SELECT * FROM orders WHERE status = 'new'")
        .await;
    c.must("CREATE SEQUENCE order_seq").await;
    c.must("INSERT INTO users VALUES (1, 'a@example.com')")
        .await;
    c.must("INSERT INTO orders SELECT i, 1, 'new', NULL FROM range(1, 51) t(i)")
        .await;
}

#[tokio::test]
async fn the_tree_loads_lazily_down_to_columns() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    seed(&c).await;

    let dbs = children(&c, &NodePath::root()).await;
    assert_eq!(dbs.len(), 1);
    assert_eq!(dbs[0].kind, NodeKind::Database);
    assert!(dbs[0]
        .detail
        .as_deref()
        .unwrap_or_default()
        .ends_with("test.duckdb"));

    let schemas = children(&c, &dbs[0].path).await;
    let main = find(&schemas, "main");
    assert_eq!(main.kind, NodeKind::Schema);

    let groups = children(&c, &main.path).await;
    assert_eq!(
        groups
            .iter()
            .map(|g| (g.name.as_str(), g.detail.as_deref()))
            .collect::<Vec<_>>(),
        [
            ("tables", Some("2")),
            ("views", Some("1")),
            ("sequences", Some("1")),
            ("indexes", Some("1"))
        ]
    );

    let tables = children(&c, &find(&groups, "tables").path).await;
    assert_eq!(
        tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["orders", "users"]
    );
    assert!(tables
        .iter()
        .all(|t| t.kind == NodeKind::Table && t.has_children));

    let cols = children(&c, &find(&tables, "orders").path).await;
    let id = cols
        .iter()
        .find(|n| n.name == "id")
        .unwrap()
        .column
        .as_ref()
        .unwrap();
    assert!(id.primary_key && !id.nullable);
    let user = cols
        .iter()
        .find(|n| n.name == "user_id")
        .unwrap()
        .column
        .as_ref()
        .unwrap();
    assert_eq!(user.foreign_key.as_deref(), Some("users.id"));
    let status = cols
        .iter()
        .find(|n| n.name == "status")
        .unwrap()
        .column
        .as_ref()
        .unwrap();
    assert!(status.default.as_deref().unwrap().contains("new"));
    assert_eq!(status.type_name, "VARCHAR");

    let views = children(&c, &find(&groups, "views").path).await;
    assert_eq!(views[0].name, "open_orders");
    assert_eq!(views[0].kind, NodeKind::View);
    let idx = children(&c, &find(&groups, "indexes").path).await;
    assert_eq!(idx[0].detail.as_deref(), Some("ON orders"));
}

#[tokio::test]
async fn attached_databases_appear_as_catalogs() {
    let (dir, cfg) = fresh();
    let c = connect(&cfg).await;
    let other = dir
        .path()
        .join("other.duckdb")
        .to_string_lossy()
        .replace('\\', "/");
    c.must(&format!("ATTACH '{other}' AS side")).await;
    c.must("CREATE TABLE side.main.extra (a INTEGER)").await;
    let dbs = children(&c, &NodePath::root()).await;
    assert!(dbs.iter().any(|d| d.name == "side"), "{dbs:?}");
}

fn path_of(db: &str, table: &str) -> NodePath {
    NodePath::root()
        .child(NodeKind::Database, db)
        .child(NodeKind::Schema, "main")
        .child(NodeKind::Group, "tables")
        .child(NodeKind::Table, table)
}

#[tokio::test]
async fn ddl_table_meta_and_counts() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    seed(&c).await;
    let db = children(&c, &NodePath::root()).await[0].name.clone();

    let ddl = c.mgr.ddl("conf", &path_of(&db, "orders")).await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE orders"), "{ddl}");
    assert!(
        c.mgr
            .count_rows("conf", &path_of(&db, "orders"))
            .await
            .unwrap()
            == 50
    );

    let meta = c
        .mgr
        .table_meta("conf", &path_of(&db, "orders"))
        .await
        .unwrap();
    assert_eq!(
        meta.columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["id", "user_id", "status", "note"]
    );
    assert!(meta.columns[0].primary_key);
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.primary && i.columns == ["id"]));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.name == "orders_status_idx" && i.columns == ["status"]));
    assert_eq!(meta.foreign_keys[0].ref_table, "users");
    assert_eq!(meta.foreign_keys[0].columns, ["user_id"]);
    let users = c
        .mgr
        .table_meta("conf", &path_of(&db, "users"))
        .await
        .unwrap();
    assert_eq!(users.referenced_by[0].table, "orders");
}

#[tokio::test]
async fn the_completion_snapshot_has_tables_columns_and_functions() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    seed(&c).await;
    let db = children(&c, &NodePath::root()).await[0].name.clone();
    let snap = c.mgr.completion_snapshot("conf", &db).await.unwrap();
    let main = snap
        .schemas
        .iter()
        .find(|s| s.name == "main")
        .expect("main");
    let orders = main.tables.iter().find(|t| t.name == "orders").unwrap();
    assert_eq!(orders.kind, NodeKind::Table);
    assert_eq!(orders.columns.len(), 4);
    assert_eq!(
        main.tables
            .iter()
            .find(|t| t.name == "open_orders")
            .unwrap()
            .kind,
        NodeKind::View
    );
    assert!(
        main.functions.iter().any(|f| f == "lower"),
        "functions come with the schema"
    );
}

// ---- editing ---------------------------------------------------------------------------------

#[tokio::test]
async fn staged_changes_apply_and_roll_back_on_conflict() {
    let (_dir, cfg) = fresh();
    let c = connect(&cfg).await;
    c.must("CREATE TABLE t (id INTEGER PRIMARY KEY, name VARCHAR, n DECIMAL(10,2), note VARCHAR)")
        .await;
    c.must("INSERT INTO t VALUES (1, 'old', 1.50, NULL), (2, 'gone', 2.00, 'x')")
        .await;
    let db = children(&c, &NodePath::root()).await[0].name.clone();
    let path = NodePath::root()
        .child(NodeKind::Database, &db)
        .child(NodeKind::Schema, "main")
        .child(NodeKind::Group, "tables")
        .child(NodeKind::Table, "t");
    let request = |old: &str| -> clew_lib::changes::ChangeRequest {
        serde_json::from_value(serde_json::json!({
            "path": path,
            "columns": [
                {"name": "id", "type_name": "INTEGER"}, {"name": "name", "type_name": "VARCHAR"},
                {"name": "n", "type_name": "DECIMAL(10,2)"}, {"name": "note", "type_name": "VARCHAR"},
            ],
            "keyColumns": ["id"],
            "edits": [{"key": [{"kind": "int", "value": 1}], "changes": [
                {"column": "name", "old": {"kind": "text", "value": old, "truncated": false},
                 "new": {"kind": "value", "value": {"kind": "text", "value": "it's new", "truncated": false}}},
                {"column": "n", "old": {"kind": "decimal", "value": "1.50"},
                 "new": {"kind": "value", "value": {"kind": "decimal", "value": "9.25"}}},
                {"column": "note", "old": {"kind": "null"},
                 "new": {"kind": "value", "value": {"kind": "text", "value": "hi", "truncated": false}}},
            ]}],
            "inserts": [{"values": [
                {"column": "id", "value": {"kind": "value", "value": {"kind": "int", "value": 3}}},
                {"column": "name", "value": {"kind": "value", "value": {"kind": "null"}}},
            ]}],
            "deletes": [{"key": [{"kind": "int", "value": 2}]}],
        }))
        .unwrap()
    };
    let stale = clew_lib::changes::build("duckdb", &request("someone else's")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &stale).await.unwrap();
    assert!(out.failure.expect("conflict").conflict);
    assert_eq!(
        c.must("SELECT count(*) FROM t").await.scalar_int(),
        2,
        "rolled back"
    );

    let ok = clew_lib::changes::build("duckdb", &request("old")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &ok).await.unwrap();
    assert!(out.failure.is_none(), "{:?}", out.failure);
    let rows = c
        .must("SELECT id, name, CAST(n AS VARCHAR), note FROM t ORDER BY id")
        .await
        .rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(text(&rows[0][1]), "it's new");
    assert_eq!(text(&rows[0][2]), "9.25");
    assert_eq!(int(&rows[1][0]), 3);
}
