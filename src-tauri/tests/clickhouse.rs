//! ClickHouse conformance + driver-specific tests. Needs `docker compose up -d --wait clickhouse`.
//! Run with `cargo test --features integration`.
#![cfg(feature = "integration")]

mod conformance;

use clew_lib::drivers::introspect::{NodeKind, NodePath};
use clew_lib::drivers::{ErrorCode, ResolvedConfig, Secret, Target, TlsConfig, Value, ValueKind};
use conformance::*;

const PORT: u16 = 8123;

fn cfg() -> ResolvedConfig {
    ResolvedConfig {
        driver: "clickhouse".into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port: PORT,
        },
        user: Some("clew".into()),
        password: Some(Secret::new("clew")),
        database: Some("clew".into()),
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 5,
        query_timeout_secs: None,
        read_only: false,
        options: Default::default(),
        on_connect: vec![],
    }
}

fn suite() -> Suite {
    Suite {
        cfg: cfg(),
        dialect: Dialect {
            product: "ClickHouse",
            generate_rows: |n| format!("SELECT number + 1 AS n FROM numbers({n})"),
            sleep_long: "SELECT sum(cityHash64(number)) FROM numbers(100000000000)",
            syntax_error: "SELEC 1",
            error_position: Some(1),
            backend_id_sql: None,
            kill_sql: None,
        },
    }
}

#[tokio::test]
async fn test_connection() {
    test_connection_reports_the_server(&suite()).await;
}
#[tokio::test]
async fn session_server() {
    session_reports_the_server(&suite()).await;
}
#[tokio::test]
async fn paging() {
    large_results_are_paged(&suite()).await;
}
#[tokio::test]
async fn abandoning_a_result() {
    a_new_statement_abandons_an_open_result(&suite()).await;
}
#[tokio::test]
async fn columns() {
    column_metadata(&suite()).await;
}
#[tokio::test]
async fn scripts() {
    scripts_run_in_order_and_stop_on_error(&suite()).await;
}
#[tokio::test]
async fn syntax_error_position() {
    syntax_errors_carry_a_position(&suite()).await;
}
#[tokio::test]
async fn temp_tables() {
    temporary_tables_belong_to_the_session(&suite(), "conf_ch_temp").await;
}
#[tokio::test]
async fn cancel() {
    cancel_stops_a_long_query(&suite()).await;
}
#[tokio::test]
async fn timeout() {
    the_query_timeout_cancels_the_statement(&suite()).await;
}
#[tokio::test]
async fn introspection_is_independent_of_the_session() {
    introspection_works_while_a_query_runs(&suite()).await;
}
#[tokio::test]
async fn unknown_driver() {
    unknown_driver_is_unavailable(&cfg()).await;
}

#[tokio::test]
async fn wrong_credentials() {
    let mut c = cfg();
    c.password = Some(Secret::new("not-the-password"));
    let err = manager().test_connection(&c).await.expect_err("must fail");
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(!err.message.contains("not-the-password"));
}

#[tokio::test]
async fn an_unreachable_host_is_reported() {
    let mut c = cfg();
    c.target = Target::Network {
        host: "127.0.0.1".into(),
        port: 1,
    };
    let err = manager().test_connection(&c).await.expect_err("must fail");
    assert!(
        matches!(err.code, ErrorCode::ConnectionLost | ErrorCode::Timeout),
        "{err:?}"
    );
}

#[tokio::test]
async fn set_and_use_persist_within_a_session() {
    let c = connect(&cfg()).await;
    c.must("SET max_threads = 3").await;
    let r = c
        .must("SELECT value FROM system.settings WHERE name = 'max_threads'")
        .await;
    assert_eq!(text(&r.rows()[0][0]), "3");
    let other = c.another_session().await;
    let r = run(
        &c.mgr,
        &other,
        "SELECT value FROM system.settings WHERE name = 'max_threads'",
    )
    .await;
    assert_ne!(text(&r.rows()[0][0]), "3", "another session is unaffected");
}

#[tokio::test]
async fn statements_without_results_report_rows_written() {
    let c = connect(&cfg()).await;
    c.must("DROP TABLE IF EXISTS conf_ch_w").await;
    let create = c
        .must("CREATE TABLE conf_ch_w (id UInt32, name String) ENGINE = MergeTree ORDER BY id")
        .await;
    assert!(create.columns().is_empty());
    let insert = c
        .must("INSERT INTO conf_ch_w VALUES (1, 'a'), (2, 'b'), (3, 'c')")
        .await;
    assert_eq!(insert.ok().rows_affected, Some(3));
    assert_eq!(
        c.must("SELECT count() FROM conf_ch_w").await.scalar_int(),
        3
    );
    c.must("DROP TABLE conf_ch_w").await;
}

#[tokio::test]
async fn values_keep_their_types() {
    let c = connect(&cfg()).await;
    let r = c
        .must(
            "SELECT toUInt64(18446744073709551615) AS big, toDecimal64(12.5, 2) AS dec, [1, 2] AS arr, \
             (1, 'x') AS tup, map('k', 1) AS m, toDateTime64('2026-01-02 03:04:05.123', 3) AS ts, \
             toDate('2026-01-02') AS d, toUUID('123e4567-e89b-12d3-a456-426614174000') AS u, \
             CAST(NULL AS Nullable(Int32)) AS n, toLowCardinality('x') AS lc, true AS b, 1.5 AS f",
        )
        .await;
    let row = &r.rows()[0];
    assert_eq!(
        row[0],
        Value::Bigint {
            value: "18446744073709551615".into()
        }
    );
    assert_eq!(
        row[1],
        Value::Decimal {
            value: "12.50".into()
        }
    );
    assert_eq!(
        row[2],
        Value::Array {
            value: vec![Value::Int { value: 1 }, Value::Int { value: 2 }]
        }
    );
    assert_eq!(row[3], Value::json(serde_json::json!([1, "x"])));
    assert_eq!(row[4], Value::json(serde_json::json!({"k": 1})));
    assert_eq!(
        row[5],
        Value::Timestamp {
            value: "2026-01-02T03:04:05.123".into()
        }
    );
    assert_eq!(
        row[6],
        Value::Date {
            value: "2026-01-02".into()
        }
    );
    assert_eq!(
        row[7],
        Value::Uuid {
            value: "123e4567-e89b-12d3-a456-426614174000".into()
        }
    );
    assert_eq!(row[8], Value::Null);
    assert_eq!(row[9], Value::text("x"));
    assert_eq!(row[10], Value::Bool { value: true });
    assert_eq!(row[11], Value::Float { value: 1.5 });
    let cols = r.columns();
    assert_eq!(cols[8].nullable, Some(true));
    assert_eq!(cols[8].type_name, "Int32");
    assert_eq!(
        cols[9].type_name, "String",
        "LowCardinality is an encoding, not a type to show"
    );
    assert_eq!(cols[0].kind, ValueKind::Bigint);
}

#[tokio::test]
async fn read_only_sessions_block_writes_and_can_be_switched_per_session() {
    let seed = connect(&cfg()).await;
    seed.must("DROP TABLE IF EXISTS conf_ch_ro").await;
    seed.must("CREATE TABLE conf_ch_ro (a UInt8) ENGINE = Memory")
        .await;
    seed.must("INSERT INTO conf_ch_ro VALUES (1)").await;

    let mut ro = cfg();
    ro.read_only = true;
    let c = connect(&ro).await;
    assert_eq!(
        c.run("INSERT INTO conf_ch_ro VALUES (2)").await.err().code,
        ErrorCode::ReadOnly
    );
    assert_eq!(
        c.must("SELECT count() FROM conf_ch_ro").await.scalar_int(),
        1
    );
    c.mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap();
    c.must("INSERT INTO conf_ch_ro VALUES (2)").await;
    c.mgr.set_session_read_only(&c.session, true).await.unwrap();
    assert_eq!(
        c.run("INSERT INTO conf_ch_ro VALUES (3)").await.err().code,
        ErrorCode::ReadOnly
    );
    assert_eq!(
        seed.must("SELECT count() FROM conf_ch_ro")
            .await
            .scalar_int(),
        2
    );
    seed.must("DROP TABLE conf_ch_ro").await;
}

#[tokio::test]
async fn the_database_refuses_writes_the_classifier_missed() {
    // Straight to the driver: no guard in the way, only the readonly setting.
    let mut ro = cfg();
    ro.read_only = true;
    let registry = clew_lib::drivers::registry::Registry::with_defaults();
    let mut raw = registry.get("clickhouse").unwrap().open(&ro).await.unwrap();
    let (sink, _rx) = clew_lib::drivers::ResultSink::channel(8);
    let err = raw
        .execute(
            clew_lib::drivers::ExecRequest {
                sql: "CREATE TABLE conf_ch_ro (a UInt8) ENGINE = Memory".into(),
                page_size: 10,
                script: false,
                continue_on_error: false,
            },
            sink,
        )
        .await
        .unwrap_err();
    assert!(
        err.message.to_lowercase().contains("readonly"),
        "{}",
        err.message
    );
    // …and switching the session to read-write lifts it (it is only a request setting).
    raw.set_read_only(false).await.unwrap();
}

// ---- introspection ---------------------------------------------------------------------------

/// (spec: driver-framework › Engine shown)
#[tokio::test]
async fn the_tree_shows_engines_columns_and_keys() {
    let c = connect(&cfg()).await;
    c.must("DROP TABLE IF EXISTS conf_ch_tree").await;
    c.must("DROP VIEW IF EXISTS conf_ch_view").await;
    c.must("CREATE TABLE conf_ch_tree (id UInt64, name Nullable(String) COMMENT 'who', ts DateTime DEFAULT now(), INDEX name_idx name TYPE bloom_filter GRANULARITY 1) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY id").await;
    c.must("CREATE VIEW conf_ch_view AS SELECT id FROM conf_ch_tree")
        .await;
    c.must("INSERT INTO conf_ch_tree (id, name) VALUES (1, 'a'), (2, NULL)")
        .await;

    let dbs = c.mgr.introspect("conf", &NodePath::root()).await.unwrap();
    let db = dbs
        .iter()
        .find(|d| d.name == "clew")
        .expect("clew database");
    assert!(dbs
        .iter()
        .all(|d| !d.name.eq_ignore_ascii_case("information_schema")));

    let groups = c.mgr.introspect("conf", &db.path).await.unwrap();
    assert_eq!(
        groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        ["tables", "views"]
    );
    let tables = c.mgr.introspect("conf", &groups[0].path).await.unwrap();
    let t = tables.iter().find(|t| t.name == "conf_ch_tree").unwrap();
    assert!(
        t.detail.as_deref().unwrap().starts_with("MergeTree"),
        "{:?}",
        t.detail
    );
    let views = c.mgr.introspect("conf", &groups[1].path).await.unwrap();
    assert!(views
        .iter()
        .any(|v| v.name == "conf_ch_view" && v.kind == NodeKind::View));

    let cols = c.mgr.introspect("conf", &t.path).await.unwrap();
    assert_eq!(
        cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["id", "name", "ts"]
    );
    let name = cols[1].column.as_ref().unwrap();
    assert!(name.nullable && name.type_name == "Nullable(String)");
    assert!(cols[2]
        .column
        .as_ref()
        .unwrap()
        .default
        .as_deref()
        .unwrap()
        .contains("now()"));
    assert!(
        !cols[0].column.as_ref().unwrap().primary_key,
        "a sorting key is not a unique key"
    );

    let meta = c.mgr.table_meta("conf", &t.path).await.unwrap();
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.name == "ORDER BY" || i.name == "PRIMARY KEY"));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.name == "PARTITION BY" && i.columns == ["toYYYYMM(ts)"]));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.name == "name_idx" && i.method.as_deref() == Some("bloom_filter")));
    assert_eq!(meta.columns[1].comment.as_deref(), Some("who"));
    assert_eq!(c.mgr.count_rows("conf", &t.path).await.unwrap(), 2);
    let ddl = c.mgr.ddl("conf", &t.path).await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE clew.conf_ch_tree"), "{ddl}");

    let snap = c.mgr.completion_snapshot("conf", "clew").await.unwrap();
    let tree = snap.schemas[0]
        .tables
        .iter()
        .find(|t| t.name == "conf_ch_tree")
        .unwrap();
    assert_eq!(tree.columns.len(), 3);
    assert!(snap.schemas[0].functions.iter().any(|f| f == "toDate"));
    c.must("DROP VIEW conf_ch_view").await;
    c.must("DROP TABLE conf_ch_tree").await;
}
