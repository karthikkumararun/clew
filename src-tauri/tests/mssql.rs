//! SQL Server conformance + driver-specific tests. Needs `docker compose up -d --wait mssql`
//! (SQL Server 2022; an amd64 image, so it is slow to start on Apple Silicon).
//! Run with `cargo test --features integration-heavy`.
#![cfg(feature = "integration-heavy")]

mod conformance;

use clew_lib::drivers::introspect::{NodeKind, NodePath};
use clew_lib::drivers::{ErrorCode, ResolvedConfig, Secret, Target, TlsConfig, Value, ValueKind};
use conformance::*;

const PORT: u16 = 14331;

fn cfg() -> ResolvedConfig {
    ResolvedConfig {
        driver: "sqlserver".into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port: PORT,
        },
        user: Some("sa".into()),
        password: Some(Secret::new("Clew_test_1")),
        database: Some("master".into()),
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 15,
        query_timeout_secs: None,
        read_only: false,
        options: Default::default(),
        on_connect: vec![],
        isolation: None,
    }
}

fn suite() -> Suite {
    Suite {
        cfg: cfg(),
        dialect: Dialect {
            product: "SQL Server",
            generate_rows: |n| {
                format!("WITH g AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM g WHERE n < {n}) SELECT n FROM g OPTION (MAXRECURSION 0)")
            },
            sleep_long: "WAITFOR DELAY '00:00:30'",
            syntax_error: "SELECT * FROM WHERE",
            error_position: None,
            backend_id_sql: Some("SELECT @@SPID"),
            kill_sql: Some(|id| format!("KILL {id}")),
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
async fn rows_affected() {
    rows_affected_without_a_result_set(&suite(), "conf_ms_affected").await;
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
async fn transactions_span_statements_and_stay_private() {
    let c = connect(&cfg()).await;
    c.must("IF OBJECT_ID('dbo.conf_ms_tx') IS NOT NULL DROP TABLE dbo.conf_ms_tx")
        .await;
    c.must("CREATE TABLE dbo.conf_ms_tx (id INT PRIMARY KEY)")
        .await;
    c.must("BEGIN TRANSACTION").await;
    c.must("INSERT INTO dbo.conf_ms_tx VALUES (1)").await;
    assert_eq!(
        c.must("SELECT COUNT(*) FROM dbo.conf_ms_tx")
            .await
            .scalar_int(),
        1
    );
    let other = c.another_session().await;
    // Another session would block on the uncommitted row; READ UNCOMMITTED shows it isn't visible.
    let outside = run(
        &c.mgr,
        &other,
        "SELECT COUNT(*) FROM dbo.conf_ms_tx WITH (READPAST)",
    )
    .await;
    assert_eq!(outside.scalar_int(), 0);
    c.must("ROLLBACK").await;
    assert_eq!(
        c.must("SELECT COUNT(*) FROM dbo.conf_ms_tx")
            .await
            .scalar_int(),
        0
    );
    c.must("DROP TABLE dbo.conf_ms_tx").await;
}
#[tokio::test]
async fn temp_tables() {
    let c = connect(&cfg()).await;
    c.must("CREATE TABLE #conf_ms_temp (id INT)").await;
    c.must("INSERT INTO #conf_ms_temp VALUES (7)").await;
    assert_eq!(c.must("SELECT id FROM #conf_ms_temp").await.scalar_int(), 7);
    let other = c.another_session().await;
    assert!(run(&c.mgr, &other, "SELECT id FROM #conf_ms_temp")
        .await
        .result
        .is_err());
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
async fn a_killed_connection() {
    a_killed_connection_is_reported_then_reconnected(&suite()).await;
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
async fn an_unreachable_host_times_out() {
    let mut c = cfg();
    c.connect_timeout_secs = 2;
    c.target = Target::Network {
        host: "10.255.255.1".into(),
        port: 1433,
    };
    let err = manager().test_connection(&c).await.expect_err("must fail");
    assert!(
        matches!(err.code, ErrorCode::Timeout | ErrorCode::ConnectionLost),
        "{err:?}"
    );
}

// ---- batches ---------------------------------------------------------------------------------

/// (spec: driver-framework › GO separators)
#[tokio::test]
async fn go_separates_batches_and_variables_stay_inside_one() {
    let c = connect(&cfg()).await;
    let r = run_script(
        &c.mgr,
        &c.session,
        "DECLARE @x INT = 41;\nSELECT @x + 1 AS answer;\nGO\nSELECT 2 AS two\nGO 2\nSELECT 3 AS three",
        false,
    )
    .await;
    r.ok();
    let firsts: Vec<i64> = r.rows().iter().map(|row| int(&row[0])).collect();
    assert_eq!(firsts, [42, 2, 3]);
}

#[tokio::test]
async fn use_and_set_persist_in_the_session() {
    let c = connect(&cfg()).await;
    c.must("SET LANGUAGE us_english").await;
    assert_eq!(
        c.must("SELECT DB_NAME()").await.rows()[0][0],
        Value::text("master")
    );
    c.must("USE tempdb").await;
    assert_eq!(
        c.must("SELECT DB_NAME()").await.rows()[0][0],
        Value::text("tempdb")
    );
    let other = c.another_session().await;
    assert_eq!(
        run(&c.mgr, &other, "SELECT DB_NAME()").await.rows()[0][0],
        Value::text("master")
    );
}

#[tokio::test]
async fn values_keep_their_types() {
    let c = connect(&cfg()).await;
    let r = c
        .must(
            "SELECT CAST(9223372036854775807 AS BIGINT) AS big, CAST(12.5 AS DECIMAL(10,2)) AS dec, \
             CAST(1.5 AS MONEY) AS mon, CAST('2026-01-02T03:04:05.123' AS DATETIME2(3)) AS ts, \
             CAST('2026-01-02' AS DATE) AS d, CAST('03:04:05' AS TIME(0)) AS tm, \
             CAST('2026-01-02T03:04:05+02:00' AS DATETIMEOFFSET) AS tz, \
             CAST('123E4567-E89B-12D3-A456-426614174000' AS UNIQUEIDENTIFIER) AS u, \
             CAST(0xDEAD AS VARBINARY(10)) AS bin, N'héllo' AS txt, CAST(1 AS BIT) AS b, \
             CAST('<a>1</a>' AS XML) AS x, CAST(NULL AS INT) AS n, CAST(2.5 AS FLOAT) AS f",
        )
        .await;
    let row = &r.rows()[0];
    assert_eq!(
        row[0],
        Value::Bigint {
            value: "9223372036854775807".into()
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
        Value::Decimal {
            value: "1.5000".into()
        }
    );
    assert_eq!(
        row[3],
        Value::Timestamp {
            value: "2026-01-02T03:04:05.123".into()
        }
    );
    assert_eq!(
        row[4],
        Value::Date {
            value: "2026-01-02".into()
        }
    );
    assert_eq!(
        row[5],
        Value::Time {
            value: "03:04:05".into()
        }
    );
    assert_eq!(
        row[6],
        Value::Timestamptz {
            value: "2026-01-02T03:04:05+02:00".into()
        }
    );
    assert_eq!(
        row[7],
        Value::Uuid {
            value: "123e4567-e89b-12d3-a456-426614174000".into()
        }
    );
    assert_eq!(
        row[8],
        Value::Bytes {
            value: "dead".into(),
            len: 2,
            truncated: false
        }
    );
    assert_eq!(row[9], Value::text("héllo"));
    assert_eq!(row[10], Value::Bool { value: true });
    assert_eq!(row[11], Value::text("<a>1</a>"));
    assert_eq!(row[12], Value::Null);
    assert_eq!(row[13], Value::Float { value: 2.5 });
    let kinds: Vec<_> = r.columns().iter().map(|c| c.kind).collect();
    assert_eq!(kinds[0], ValueKind::Bigint);
    assert_eq!(kinds[6], ValueKind::Timestamptz);
    assert_eq!(r.columns()[3].type_name, "DATETIME2");
}

/// (spec: driver-framework › No session read-only)
#[tokio::test]
async fn read_only_sessions_are_blocked_by_the_guard_alone() {
    let mut ro = cfg();
    ro.read_only = true;
    let c = connect(&ro).await;
    assert_eq!(
        c.run("CREATE TABLE conf_ms_ro (a INT)").await.err().code,
        ErrorCode::ReadOnly
    );
    assert_eq!(c.must("SELECT 1").await.scalar_int(), 1);
    // SQL Server has no session-level read-only; switching only changes what the guard allows.
    c.mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap();
}

// ---- introspection ---------------------------------------------------------------------------

async fn seed(c: &Connected) {
    c.must("IF DB_ID('clew_ms') IS NOT NULL BEGIN ALTER DATABASE clew_ms SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE clew_ms END").await;
    c.must("CREATE DATABASE clew_ms").await;
    c.must("USE clew_ms").await;
    c.must("CREATE SCHEMA shop").await;
    c.must("CREATE TABLE shop.users (id INT NOT NULL PRIMARY KEY, email NVARCHAR(100) NOT NULL UNIQUE)").await;
    c.must("CREATE TABLE shop.orders (id INT IDENTITY(1,1) PRIMARY KEY, user_id INT NOT NULL REFERENCES shop.users (id) ON DELETE CASCADE, status VARCHAR(20) NOT NULL DEFAULT 'new', note NVARCHAR(MAX) NULL, total DECIMAL(10,2) NULL)").await;
    c.must("CREATE INDEX orders_status_idx ON shop.orders (status)")
        .await;
    c.must("EXEC sp_addextendedproperty 'MS_Description', 'Order state', 'SCHEMA', 'shop', 'TABLE', 'orders', 'COLUMN', 'status'").await;
    c.must(
        "CREATE VIEW shop.open_orders AS SELECT id, status FROM shop.orders WHERE status = 'new'",
    )
    .await;
    c.must("CREATE PROCEDURE shop.touch AS SELECT 1 AS one")
        .await;
    c.must("CREATE FUNCTION shop.double_it(@n INT) RETURNS INT AS BEGIN RETURN @n * 2 END")
        .await;
    c.must("INSERT INTO shop.users VALUES (1, N'a@example.com')")
        .await;
    c.must(
        "INSERT INTO shop.orders (user_id, status) SELECT 1, 'new' FROM (VALUES (1),(2),(3)) v(x)",
    )
    .await;
}

fn find<'a>(
    nodes: &'a [clew_lib::drivers::TreeNode],
    name: &str,
) -> &'a clew_lib::drivers::TreeNode {
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
    seed(&c).await;
    let ch = |p: NodePath| {
        let mgr = c.mgr.clone();
        async move { mgr.introspect("conf", &p).await.expect("children") }
    };

    let dbs = ch(NodePath::root()).await;
    let db = find(&dbs, "clew_ms");
    let schemas = ch(db.path.clone()).await;
    assert!(schemas.iter().any(|s| s.name == "shop") && !schemas.iter().any(|s| s.name == "sys"));
    let groups = ch(find(&schemas, "shop").path.clone()).await;
    assert_eq!(
        groups
            .iter()
            .map(|g| (g.name.as_str(), g.detail.as_deref()))
            .collect::<Vec<_>>(),
        [
            ("tables", Some("2")),
            ("views", Some("1")),
            ("procedures", Some("1")),
            ("functions", Some("1"))
        ]
    );
    let tables = ch(find(&groups, "tables").path.clone()).await;
    assert_eq!(
        tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["orders", "users"]
    );
    assert_eq!(find(&tables, "orders").detail.as_deref(), Some("3"));
    assert_eq!(
        ch(find(&groups, "views").path.clone()).await[0].kind,
        NodeKind::View
    );
    assert_eq!(
        ch(find(&groups, "procedures").path.clone()).await[0].name,
        "touch"
    );
    assert_eq!(
        ch(find(&groups, "functions").path.clone()).await[0].name,
        "double_it"
    );

    let cols = ch(find(&tables, "orders").path.clone()).await;
    assert_eq!(
        cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["id", "user_id", "status", "note", "total"]
    );
    let id = cols[0].column.as_ref().unwrap();
    assert!(id.primary_key && !id.nullable && id.type_name == "int");
    assert_eq!(
        cols[1].column.as_ref().unwrap().foreign_key.as_deref(),
        Some("users.id")
    );
    let status = cols[2].column.as_ref().unwrap();
    assert_eq!(status.type_name, "varchar(20)");
    assert!(status.default.as_deref().unwrap().contains("new"));
    assert_eq!(cols[3].column.as_ref().unwrap().type_name, "nvarchar(max)");
    assert_eq!(cols[4].column.as_ref().unwrap().type_name, "decimal(10,2)");

    let orders = find(&tables, "orders").path.clone();
    let meta = c.mgr.table_meta("conf", &orders).await.unwrap();
    assert!(meta.columns[0].primary_key);
    assert_eq!(meta.columns[2].comment.as_deref(), Some("Order state"));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.primary && i.columns == ["id"]));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.name == "orders_status_idx" && i.columns == ["status"]));
    assert_eq!(meta.foreign_keys[0].ref_table, "users");
    assert_eq!(meta.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
    assert_eq!(meta.estimated_rows, Some(3));
    let users = c
        .mgr
        .table_meta("conf", &find(&tables, "users").path)
        .await
        .unwrap();
    assert_eq!(users.referenced_by[0].table, "orders");
    assert_eq!(c.mgr.count_rows("conf", &orders).await.unwrap(), 3);

    let ddl = c.mgr.ddl("conf", &orders).await.unwrap();
    assert!(ddl.starts_with("CREATE TABLE [shop].[orders]"), "{ddl}");
    assert!(
        ddl.contains("IDENTITY(1,1)") && ddl.contains("PRIMARY KEY") && ddl.contains("FOREIGN KEY"),
        "{ddl}"
    );
    let view = c
        .mgr
        .ddl(
            "conf",
            &ch(find(&groups, "views").path.clone()).await[0].path,
        )
        .await
        .unwrap();
    assert!(view.contains("CREATE VIEW shop.open_orders"), "{view}");

    let snap = c.mgr.completion_snapshot("conf", "clew_ms").await.unwrap();
    let shop = snap.schemas.iter().find(|s| s.name == "shop").unwrap();
    assert_eq!(
        shop.tables
            .iter()
            .find(|t| t.name == "orders")
            .unwrap()
            .columns
            .len(),
        5
    );
    assert_eq!(
        shop.tables
            .iter()
            .find(|t| t.name == "open_orders")
            .unwrap()
            .kind,
        NodeKind::View
    );
    assert!(shop.functions.iter().any(|f| f == "getdate"));

    c.must("USE master").await;
    c.must("ALTER DATABASE clew_ms SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE clew_ms")
        .await;
}

// ---- editing ---------------------------------------------------------------------------------

#[tokio::test]
async fn staged_changes_apply_and_roll_back_on_conflict() {
    let c = connect(&cfg()).await;
    c.must("IF OBJECT_ID('dbo.conf_ms_edit') IS NOT NULL DROP TABLE dbo.conf_ms_edit")
        .await;
    c.must("CREATE TABLE dbo.conf_ms_edit (id INT PRIMARY KEY, name NVARCHAR(40), n DECIMAL(10,2), note NVARCHAR(100))").await;
    c.must("INSERT INTO dbo.conf_ms_edit VALUES (1, N'old', 1.50, NULL), (2, N'gone', 2.00, N'x')")
        .await;
    let path = NodePath::root()
        .child(NodeKind::Database, "master")
        .child(NodeKind::Schema, "dbo")
        .child(NodeKind::Group, "tables")
        .child(NodeKind::Table, "conf_ms_edit");
    let request = |old: &str| -> clew_lib::changes::ChangeRequest {
        serde_json::from_value(serde_json::json!({
            "path": path,
            "columns": [
                {"name": "id", "type_name": "int"}, {"name": "name", "type_name": "nvarchar(40)"},
                {"name": "n", "type_name": "decimal(10,2)"}, {"name": "note", "type_name": "nvarchar(100)"},
            ],
            "keyColumns": ["id"],
            "edits": [{"key": [{"kind": "int", "value": 1}], "changes": [
                {"column": "name", "old": {"kind": "text", "value": old, "truncated": false},
                 "new": {"kind": "value", "value": {"kind": "text", "value": "it's new", "truncated": false}}},
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
    let stale = clew_lib::changes::build("sqlserver", &request("someone else's")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &stale).await.unwrap();
    assert!(out.failure.expect("conflict").conflict);
    assert_eq!(
        c.must("SELECT COUNT(*) FROM dbo.conf_ms_edit")
            .await
            .scalar_int(),
        2,
        "rolled back"
    );

    let ok = clew_lib::changes::build("sqlserver", &request("old")).unwrap();
    let out = c.mgr.apply_changes(&c.session, &ok).await.unwrap();
    assert!(out.failure.is_none(), "{:?}", out.failure);
    let rows = c
        .must("SELECT id, name, note FROM dbo.conf_ms_edit ORDER BY id")
        .await
        .rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(text(&rows[0][1]), "it's new");
    assert_eq!(text(&rows[0][2]), "hi");
    assert_eq!(int(&rows[1][0]), 3);
    c.must("DROP TABLE dbo.conf_ms_edit").await;
}
