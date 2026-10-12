//! Oracle conformance + driver-specific tests. Needs `docker compose up -d --wait oracle`
//! (Oracle Database 23ai Free) and an Oracle Instant Client the driver can find (ORACLE_HOME, or
//! a `~/Downloads/instantclient_*` folder). Run with `cargo test --features integration-heavy`.
#![cfg(feature = "integration-heavy")]

mod conformance;

use clew_lib::drivers::introspect::{NodeKind, NodePath, TreeNode};
use clew_lib::drivers::{ErrorCode, ResolvedConfig, Secret, Target, TlsConfig, Value, ValueKind};
use conformance::*;

const PORT: u16 = 15211;

fn cfg() -> ResolvedConfig {
    let mut options = std::collections::BTreeMap::new();
    options.insert("oracle.connect_by".to_string(), "service_name".to_string());
    options.insert("oracle.connect_value".to_string(), "FREEPDB1".to_string());
    ResolvedConfig {
        driver: "oracle".into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port: PORT,
        },
        user: Some("clew".into()),
        password: Some(Secret::new("clew")),
        database: None,
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 15,
        query_timeout_secs: None,
        read_only: false,
        options,
        on_connect: vec![],
    }
}

fn suite() -> Suite {
    Suite {
        cfg: cfg(),
        dialect: Dialect {
            product: "Oracle Database",
            generate_rows: |n| format!("SELECT level AS n FROM dual CONNECT BY level <= {n}"),
            // DBMS_SESSION.SLEEP ignores a cancel until it wakes; a busy query stops at once.
            sleep_long: "SELECT SUM(a.n * b.n) FROM (SELECT level n FROM dual CONNECT BY level <= 40000) a, (SELECT level n FROM dual CONNECT BY level <= 40000) b",
            syntax_error: "SELEC 1 FROM dual",
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
    // Unquoted aliases come back upper-case in Oracle, so quote them.
    let c = connect(&cfg()).await;
    let r = c
        .must("SELECT 1 AS \"one\", 'x' AS \"two\", 2 AS three FROM dual")
        .await;
    let cols = r.columns();
    assert_eq!(
        cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["one", "two", "THREE"]
    );
    assert!(cols.iter().all(|c| !c.type_name.is_empty()));
}
#[tokio::test]
async fn rows_affected() {
    rows_affected_without_a_result_set(&suite(), "conf_or_affected").await;
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
    wrong_credentials_are_auth_failed(&c, "not-the-password").await;
}

#[tokio::test]
async fn an_unreachable_host_is_reported() {
    let mut c = cfg();
    c.connect_timeout_secs = 2;
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
async fn a_missing_client_is_explained() {
    // Only meaningful where the client cannot be found; otherwise the driver just connects.
    let status = clew_lib::drivers::oracle::client::status(None);
    if status.found {
        return;
    }
    let err = manager()
        .test_connection(&cfg())
        .await
        .expect_err("no client");
    assert_eq!(err.code, ErrorCode::DriverUnavailable);
    assert!(err.message.contains("Instant Client"));
}

// ---- scripts, PL/SQL and output --------------------------------------------------------------

/// (spec: driver-framework › PL/SQL block in a script); (spec: driver-framework › DBMS_OUTPUT)
#[tokio::test]
async fn a_plsql_block_in_a_script_runs_as_one_statement_and_prints_its_output() {
    let c = connect(&cfg()).await;
    let r = run_script(
        &c.mgr,
        &c.session,
        "BEGIN\n  DBMS_OUTPUT.PUT_LINE('hello');\n  DBMS_OUTPUT.PUT_LINE('done');\nEND;\n/\nSELECT 7 AS seven FROM dual",
        false,
    )
    .await;
    r.ok();
    assert_eq!(r.notices(), ["hello", "done"]);
    assert_eq!(int(&r.rows()[0][0]), 7);
}

#[tokio::test]
async fn program_units_can_be_created_and_called() {
    let c = connect(&cfg()).await;
    let script = "CREATE OR REPLACE FUNCTION conf_or_double(n NUMBER) RETURN NUMBER AS\nBEGIN\n  RETURN n * 2;\nEND;\n/\nSELECT conf_or_double(21) AS answer FROM dual";
    let r = run_script(&c.mgr, &c.session, script, false).await;
    r.ok();
    assert_eq!(int(&r.rows()[0][0]), 42);
    c.must("DROP FUNCTION conf_or_double").await;
}

#[tokio::test]
async fn transactions_are_manual_between_begin_and_commit() {
    let c = connect(&cfg()).await;
    c.must(
        "BEGIN EXECUTE IMMEDIATE 'DROP TABLE conf_or_tx'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    )
    .await;
    c.must("CREATE TABLE conf_or_tx (id NUMBER PRIMARY KEY)")
        .await;
    let other = c.another_session().await;
    let count = |sid| {
        let mgr = c.mgr.clone();
        async move {
            run(&mgr, &sid, "SELECT COUNT(*) FROM conf_or_tx")
                .await
                .scalar_int()
        }
    };

    c.must("INSERT INTO conf_or_tx VALUES (1)").await;
    assert_eq!(
        count(other.clone()).await,
        1,
        "autocommit: committed as it ran"
    );

    c.must("BEGIN TRANSACTION").await;
    c.must("INSERT INTO conf_or_tx VALUES (2)").await;
    assert_eq!(
        c.must("SELECT COUNT(*) FROM conf_or_tx").await.scalar_int(),
        2
    );
    assert_eq!(
        count(other.clone()).await,
        1,
        "another session does not see it"
    );
    assert_eq!(
        c.mgr.sessions_in_transaction("conf"),
        vec![c.session.clone()]
    );
    c.must("ROLLBACK").await;
    assert_eq!(
        c.must("SELECT COUNT(*) FROM conf_or_tx").await.scalar_int(),
        1
    );
    assert!(c.mgr.sessions_in_transaction("conf").is_empty());

    c.must("BEGIN TRANSACTION").await;
    c.must("INSERT INTO conf_or_tx VALUES (3)").await;
    c.must("COMMIT").await;
    assert_eq!(count(other).await, 2);
    c.must("DROP TABLE conf_or_tx PURGE").await;
}

#[tokio::test]
async fn private_temporary_tables_belong_to_the_session() {
    let c = connect(&cfg()).await;
    c.must("CREATE PRIVATE TEMPORARY TABLE ora$ptt_conf (id NUMBER) ON COMMIT PRESERVE DEFINITION")
        .await;
    c.must("INSERT INTO ora$ptt_conf VALUES (7)").await;
    assert_eq!(c.must("SELECT id FROM ora$ptt_conf").await.scalar_int(), 7);
    let other = c.another_session().await;
    assert!(run(&c.mgr, &other, "SELECT id FROM ora$ptt_conf")
        .await
        .result
        .is_err());
}

// ---- values ----------------------------------------------------------------------------------

#[tokio::test]
async fn values_keep_their_types() {
    let c = connect(&cfg()).await;
    let r = c
        .must(
            "SELECT CAST(42 AS NUMBER(10)) AS i, CAST(12.5 AS NUMBER(10,2)) AS d, 1.5 AS plain, \
             DATE '2026-01-02' AS dt, TIMESTAMP '2026-01-02 03:04:05.123' AS ts, \
             TIMESTAMP '2026-01-02 03:04:05 +02:00' AS tz, INTERVAL '3' DAY AS iv, \
             HEXTORAW('DEAD') AS rw, 'héllo' AS txt, TO_CLOB('big text') AS cl, CAST(NULL AS NUMBER) AS n, \
             1.5e0 * 2 AS f, CAST(2.5 AS BINARY_DOUBLE) AS bd FROM dual",
        )
        .await;
    let row = &r.rows()[0];
    assert_eq!(row[0], Value::Int { value: 42 });
    assert_eq!(
        row[1],
        Value::Decimal {
            value: "12.5".into()
        }
    );
    assert_eq!(
        row[2],
        Value::Decimal {
            value: "1.5".into()
        }
    );
    assert_eq!(
        row[3],
        Value::Timestamp {
            value: "2026-01-02T00:00:00".into()
        }
    );
    assert_eq!(
        row[4],
        Value::Timestamp {
            value: "2026-01-02T03:04:05.123".into()
        }
    );
    assert_eq!(
        row[5],
        Value::Timestamptz {
            value: "2026-01-02T03:04:05+02:00".into()
        }
    );
    assert!(
        matches!(&row[6], Value::Interval { value } if value.contains("3")),
        "{:?}",
        row[6]
    );
    assert_eq!(
        row[7],
        Value::Bytes {
            value: "dead".into(),
            len: 2,
            truncated: false
        }
    );
    assert_eq!(row[8], Value::text("héllo"));
    assert_eq!(row[9], Value::text("big text"));
    assert_eq!(row[10], Value::Null);
    assert_eq!(row[12], Value::Float { value: 2.5 });
    let kinds: Vec<_> = r.columns().iter().map(|c| c.kind).collect();
    assert_eq!(kinds[0], ValueKind::Int);
    assert_eq!(kinds[1], ValueKind::Decimal);
    assert_eq!(kinds[3], ValueKind::Timestamp);
    assert_eq!(kinds[5], ValueKind::Timestamptz);
    assert_eq!(r.columns()[1].type_name, "NUMBER(10,2)");
}

#[tokio::test]
async fn large_objects_are_truncated() {
    let c = connect(&cfg()).await;
    c.must(
        "BEGIN EXECUTE IMMEDIATE 'DROP TABLE conf_or_lob'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    )
    .await;
    c.must("CREATE TABLE conf_or_lob (id NUMBER, body CLOB)")
        .await;
    c.must("DECLARE c CLOB; BEGIN DBMS_LOB.CREATETEMPORARY(c, TRUE); FOR i IN 1..40 LOOP DBMS_LOB.WRITEAPPEND(c, 32000, RPAD('x', 32000, 'x')); END LOOP; INSERT INTO conf_or_lob VALUES (1, c); END;").await;
    let r = c.must("SELECT body FROM conf_or_lob").await;
    let Value::Text { value, truncated } = &r.rows()[0][0] else {
        panic!("{:?}", r.rows()[0][0])
    };
    assert!(*truncated);
    assert!(value.len() < 100_000);
    c.must("DROP TABLE conf_or_lob PURGE").await;
}

// ---- read-only -------------------------------------------------------------------------------

/// (spec: driver-framework › Read-only session)
#[tokio::test]
async fn read_only_sessions_block_writes_and_the_database_backs_it_up() {
    let seed = connect(&cfg()).await;
    seed.must(
        "BEGIN EXECUTE IMMEDIATE 'DROP TABLE conf_or_ro'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    )
    .await;
    seed.must("CREATE TABLE conf_or_ro (a NUMBER)").await;
    seed.must("INSERT INTO conf_or_ro VALUES (1)").await;
    // A read-only transaction can't read a table whose definition changed in the same second.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let mut ro = cfg();
    ro.read_only = true;
    let c = connect(&ro).await;
    assert_eq!(
        c.run("INSERT INTO conf_or_ro VALUES (2)").await.err().code,
        ErrorCode::ReadOnly
    );
    assert_eq!(
        c.must("SELECT COUNT(*) FROM conf_or_ro").await.scalar_int(),
        1
    );

    // Straight to the driver (no guard): the read-only transaction refuses it.
    let registry = clew_lib::drivers::registry::Registry::with_defaults();
    let mut raw = registry.get("oracle").unwrap().open(&ro).await.unwrap();
    let (sink, _rx) = clew_lib::drivers::ResultSink::channel(8);
    let err = raw
        .execute(
            clew_lib::drivers::ExecRequest {
                sql: "INSERT INTO conf_or_ro VALUES (3)".into(),
                page_size: 10,
                script: false,
                continue_on_error: false,
            },
            sink,
        )
        .await
        .unwrap_err();
    assert!(err.message.contains("ORA-01456"), "{}", err.message);

    c.mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap();
    c.must("INSERT INTO conf_or_ro VALUES (2)").await;
    assert_eq!(
        seed.must("SELECT COUNT(*) FROM conf_or_ro")
            .await
            .scalar_int(),
        2
    );
    seed.must("DROP TABLE conf_or_ro PURGE").await;
}

// ---- introspection ---------------------------------------------------------------------------

fn find<'a>(nodes: &'a [TreeNode], name: &str) -> &'a TreeNode {
    nodes.iter().find(|n| n.name == name).unwrap_or_else(|| {
        panic!(
            "no node {name} in {:?}",
            nodes.iter().map(|n| &n.name).collect::<Vec<_>>()
        )
    })
}

#[tokio::test]
async fn the_tree_meta_ddl_and_snapshot() {
    let c = connect(&cfg()).await;
    for drop in [
        "DROP VIEW conf_or_open",
        "DROP SYNONYM conf_or_syn",
        "DROP SEQUENCE conf_or_seq",
        "DROP PACKAGE conf_or_pkg",
        "DROP PROCEDURE conf_or_proc",
        "DROP FUNCTION conf_or_fn",
        "DROP TABLE conf_or_orders PURGE",
        "DROP TABLE conf_or_users PURGE",
    ] {
        let _ = c.run(drop).await;
    }
    c.must("CREATE TABLE conf_or_users (id NUMBER(10) PRIMARY KEY, email VARCHAR2(100) NOT NULL UNIQUE)").await;
    c.must("CREATE TABLE conf_or_orders (id NUMBER(10) PRIMARY KEY, user_id NUMBER(10) NOT NULL REFERENCES conf_or_users (id) ON DELETE CASCADE, status VARCHAR2(20) DEFAULT 'new' NOT NULL, note CLOB, total NUMBER(10,2))").await;
    c.must("COMMENT ON COLUMN conf_or_orders.status IS 'Order state'")
        .await;
    c.must("CREATE INDEX conf_or_orders_status_idx ON conf_or_orders (status)")
        .await;
    c.must(
        "CREATE VIEW conf_or_open AS SELECT id, status FROM conf_or_orders WHERE status = 'new'",
    )
    .await;
    c.must("CREATE SEQUENCE conf_or_seq").await;
    c.must("CREATE SYNONYM conf_or_syn FOR conf_or_users").await;
    c.must("CREATE PROCEDURE conf_or_proc AS BEGIN NULL; END;")
        .await;
    c.must("CREATE FUNCTION conf_or_fn RETURN NUMBER AS BEGIN RETURN 1; END;")
        .await;
    c.must("CREATE PACKAGE conf_or_pkg AS PROCEDURE p; END conf_or_pkg;")
        .await;
    c.must("INSERT INTO conf_or_users VALUES (1, 'a@example.com')")
        .await;
    c.must(
        "INSERT INTO conf_or_orders (id, user_id) SELECT level, 1 FROM dual CONNECT BY level <= 3",
    )
    .await;
    c.must("BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, 'CONF_OR_ORDERS'); END;")
        .await;

    let ch = |p: NodePath| {
        let mgr = c.mgr.clone();
        async move { mgr.introspect("conf", &p).await.expect("children") }
    };
    let schemas = ch(NodePath::root()).await;
    let me = find(&schemas, "CLEW");
    assert_eq!(me.kind, NodeKind::Schema);
    let groups = ch(me.path.clone()).await;
    assert_eq!(
        groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        [
            "tables",
            "views",
            "materialized views",
            "sequences",
            "synonyms",
            "packages",
            "procedures",
            "functions"
        ]
    );
    let tables = ch(find(&groups, "tables").path.clone()).await;
    assert!(
        tables
            .iter()
            .any(|t| t.name == "CONF_OR_ORDERS" && t.detail.as_deref() == Some("3")),
        "{tables:?}"
    );
    assert_eq!(
        ch(find(&groups, "views").path.clone())
            .await
            .iter()
            .find(|v| v.name == "CONF_OR_OPEN")
            .unwrap()
            .kind,
        NodeKind::View
    );
    assert!(ch(find(&groups, "sequences").path.clone())
        .await
        .iter()
        .any(|v| v.name == "CONF_OR_SEQ"));
    let syn = ch(find(&groups, "synonyms").path.clone()).await;
    assert_eq!(
        find(&syn, "CONF_OR_SYN").detail.as_deref(),
        Some("→ CLEW.CONF_OR_USERS")
    );
    assert!(ch(find(&groups, "packages").path.clone())
        .await
        .iter()
        .any(|v| v.name == "CONF_OR_PKG" && v.kind == NodeKind::Package));
    assert!(ch(find(&groups, "procedures").path.clone())
        .await
        .iter()
        .any(|v| v.name == "CONF_OR_PROC"));
    assert!(ch(find(&groups, "functions").path.clone())
        .await
        .iter()
        .any(|v| v.name == "CONF_OR_FN"));

    let orders = find(&tables, "CONF_OR_ORDERS").path.clone();
    let cols = ch(orders.clone()).await;
    assert_eq!(
        cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["ID", "USER_ID", "STATUS", "NOTE", "TOTAL"]
    );
    let id = cols[0].column.as_ref().unwrap();
    assert!(id.primary_key && !id.nullable && id.type_name == "NUMBER(10)");
    assert_eq!(
        cols[1].column.as_ref().unwrap().foreign_key.as_deref(),
        Some("CONF_OR_USERS.ID")
    );
    let status = cols[2].column.as_ref().unwrap();
    assert_eq!(status.type_name, "VARCHAR2(20)");
    assert!(status.default.as_deref().unwrap().contains("new"));
    assert_eq!(cols[4].column.as_ref().unwrap().type_name, "NUMBER(10,2)");
    assert!(cols[3].column.as_ref().unwrap().nullable);

    let meta = c.mgr.table_meta("conf", &orders).await.unwrap();
    assert!(meta.columns[0].primary_key);
    assert_eq!(meta.columns[2].comment.as_deref(), Some("Order state"));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.primary && i.columns == ["ID"]));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.name == "CONF_OR_ORDERS_STATUS_IDX" && i.columns == ["STATUS"]));
    assert_eq!(meta.foreign_keys[0].ref_table, "CONF_OR_USERS");
    assert_eq!(meta.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
    assert_eq!(meta.estimated_rows, Some(3));
    let users = c
        .mgr
        .table_meta("conf", &find(&tables, "CONF_OR_USERS").path)
        .await
        .unwrap();
    assert_eq!(users.referenced_by[0].table, "CONF_OR_ORDERS");
    assert_eq!(c.mgr.count_rows("conf", &orders).await.unwrap(), 3);

    let ddl = c.mgr.ddl("conf", &orders).await.unwrap();
    assert!(
        ddl.contains("CREATE TABLE") && ddl.contains("CONF_OR_ORDERS"),
        "{ddl}"
    );
    let func = c
        .mgr
        .ddl(
            "conf",
            &find(
                &ch(find(&groups, "functions").path.clone()).await,
                "CONF_OR_FN",
            )
            .path,
        )
        .await
        .unwrap();
    assert!(
        func.contains("FUNCTION") && func.contains("RETURN 1"),
        "{func}"
    );

    let snap = c.mgr.completion_snapshot("conf", "").await.unwrap();
    let mine = snap.schemas.iter().find(|s| s.name == "CLEW").unwrap();
    assert_eq!(
        mine.tables
            .iter()
            .find(|t| t.name == "CONF_OR_ORDERS")
            .unwrap()
            .columns
            .len(),
        5
    );
    assert_eq!(
        mine.tables
            .iter()
            .find(|t| t.name == "CONF_OR_OPEN")
            .unwrap()
            .kind,
        NodeKind::View
    );
    assert!(mine.functions.iter().any(|f| f == "nvl"));

    for drop in [
        "DROP VIEW conf_or_open",
        "DROP SYNONYM conf_or_syn",
        "DROP SEQUENCE conf_or_seq",
        "DROP PACKAGE conf_or_pkg",
        "DROP PROCEDURE conf_or_proc",
        "DROP FUNCTION conf_or_fn",
        "DROP TABLE conf_or_orders PURGE",
        "DROP TABLE conf_or_users PURGE",
    ] {
        c.must(drop).await;
    }
}

// ---- editing ---------------------------------------------------------------------------------

#[tokio::test]
async fn staged_changes_apply_and_roll_back_on_conflict() {
    let c = connect(&cfg()).await;
    c.must(
        "BEGIN EXECUTE IMMEDIATE 'DROP TABLE conf_or_edit'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    )
    .await;
    c.must("CREATE TABLE conf_or_edit (id NUMBER(10) PRIMARY KEY, name VARCHAR2(40), n NUMBER(10,2), note VARCHAR2(100))").await;
    c.must("INSERT INTO conf_or_edit VALUES (1, 'old', 1.50, NULL)")
        .await;
    c.must("INSERT INTO conf_or_edit VALUES (2, 'gone', 2.00, 'x')")
        .await;
    let path = NodePath::root()
        .child(NodeKind::Schema, "CLEW")
        .child(NodeKind::Group, "tables")
        .child(NodeKind::Table, "CONF_OR_EDIT");
    let request = |old: &str| -> clew_lib::changes::ChangeRequest {
        serde_json::from_value(serde_json::json!({
            "path": path,
            "columns": [
                {"name": "ID", "type_name": "NUMBER(10)"}, {"name": "NAME", "type_name": "VARCHAR2(40)"},
                {"name": "N", "type_name": "NUMBER(10,2)"}, {"name": "NOTE", "type_name": "VARCHAR2(100)"},
            ],
            "keyColumns": ["ID"],
            "edits": [{"key": [{"kind": "int", "value": 1}], "changes": [
                {"column": "NAME", "old": {"kind": "text", "value": old, "truncated": false},
                 "new": {"kind": "value", "value": {"kind": "text", "value": "it's new", "truncated": false}}},
                {"column": "N", "old": {"kind": "decimal", "value": "1.5"},
                 "new": {"kind": "value", "value": {"kind": "decimal", "value": "9.25"}}},
                {"column": "NOTE", "old": {"kind": "null"},
                 "new": {"kind": "value", "value": {"kind": "text", "value": "hi", "truncated": false}}},
            ]}],
            "inserts": [{"values": [
                {"column": "ID", "value": {"kind": "value", "value": {"kind": "int", "value": 3}}},
                {"column": "NAME", "value": {"kind": "value", "value": {"kind": "null"}}},
            ]}],
            "deletes": [{"key": [{"kind": "int", "value": 2}]}],
        }))
        .unwrap()
    };
    let stale = clew_lib::changes::build("oracle", &request("someone else's")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &stale).await.unwrap();
    assert!(out.failure.expect("conflict").conflict);
    assert_eq!(
        c.must("SELECT COUNT(*) FROM conf_or_edit")
            .await
            .scalar_int(),
        2,
        "rolled back"
    );

    let ok = clew_lib::changes::build("oracle", &request("old")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &ok).await.unwrap();
    assert!(out.failure.is_none(), "{:?}", out.failure);
    let other = c.another_session().await;
    let rows = run(
        &c.mgr,
        &other,
        "SELECT id, name, TO_CHAR(n), note FROM conf_or_edit ORDER BY id",
    )
    .await
    .rows();
    assert_eq!(rows.len(), 2, "committed");
    assert_eq!(text(&rows[0][1]), "it's new");
    assert_eq!(text(&rows[0][3]), "hi");
    assert_eq!(int(&rows[1][0]), 3);
    c.must("DROP TABLE conf_or_edit PURGE").await;
}
