//! MySQL 8 and MariaDB 11 conformance + driver-specific tests, run against both servers.
//! Needs `docker compose up -d --build --wait`. Run with `cargo test --features integration`.
#![cfg(feature = "integration")]

mod conformance;

use clew_lib::drivers::introspect::{NodeKind, NodePath, TreeNode};
use clew_lib::drivers::{
    ErrorCode, FullValueRequest, ResolvedConfig, Secret, Target, TlsConfig, TlsMode, Value,
    ValueKind,
};
use conformance::*;

#[derive(Clone, Copy)]
struct Flavor {
    driver: &'static str,
    product: &'static str,
    port: u16,
    maria: bool,
}

const MYSQL: Flavor = Flavor {
    driver: "mysql",
    product: "MySQL",
    port: 33068,
    maria: false,
};
const MARIADB: Flavor = Flavor {
    driver: "mariadb",
    product: "MariaDB",
    port: 33071,
    maria: true,
};

fn cfg_as(f: Flavor, user: &str, password: &str) -> ResolvedConfig {
    ResolvedConfig {
        driver: f.driver.into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port: f.port,
        },
        user: Some(user.into()),
        password: Some(Secret::new(password)),
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

fn cfg(f: Flavor) -> ResolvedConfig {
    cfg_as(f, "clew", "clew")
}

fn root(f: Flavor) -> ResolvedConfig {
    cfg_as(f, "root", "clew")
}

/// A long-running statement that, unlike `SELECT SLEEP(n)`, fails with an error when killed.
const SLOW: &str = "SELECT COUNT(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c";

fn suite(f: Flavor) -> Suite {
    Suite {
        cfg: cfg(f),
        dialect: Dialect {
            product: f.product,
            generate_rows: |n| {
                format!(
                    "SELECT n FROM (SELECT a.d + 10*b.d + 100*c.d + 1000*e.d + 1 AS n FROM \
                     (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 \
                      UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a, \
                     (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 \
                      UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b, \
                     (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 \
                      UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c, \
                     (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 \
                      UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e) t \
                     WHERE n <= {n} ORDER BY n"
                )
            },
            sleep_long: SLOW,
            syntax_error: "SELEC 1",
            error_position: Some(1),
            backend_id_sql: Some("SELECT CONNECTION_ID()"),
            kill_sql: Some(|id| format!("KILL {id}")),
        },
    }
}

macro_rules! both {
    ($group:ident: $($name:ident => $body:expr;)*) => {
        mod $group {
            use super::*;
            mod mysql {
                use super::*;
                $( #[tokio::test] async fn $name() { let f = MYSQL; ($body)(f).await } )*
            }
            mod mariadb {
                use super::*;
                $( #[tokio::test] async fn $name() { let f = MARIADB; ($body)(f).await } )*
            }
        }
    };
}

// ---- shared conformance ----------------------------------------------------------------------

both! {
    shared:
    test_connection => |f| async move { test_connection_reports_the_server(&suite(f)).await };
    session_server => |f| async move { session_reports_the_server(&suite(f)).await };
    paging => |f| async move { large_results_are_paged(&suite(f)).await };
    abandoning_a_result => |f| async move { a_new_statement_abandons_an_open_result(&suite(f)).await };
    columns => |f| async move { column_metadata(&suite(f)).await };
    rows_affected => |f| async move { rows_affected_without_a_result_set(&suite(f), "conf_my_affected").await };
    scripts => |f| async move { scripts_run_in_order_and_stop_on_error(&suite(f)).await };
    syntax_error_position => |f| async move { syntax_errors_carry_a_position(&suite(f)).await };
    transactions => |f| async move { transactions_span_statements(&suite(f), "conf_my_tx").await };
    temp_tables => |f| async move { temporary_tables_belong_to_the_session(&suite(f), "conf_my_temp").await };
    cancel => |f| async move { cancel_stops_a_long_query(&suite(f)).await };
    timeout => |f| async move { the_query_timeout_cancels_the_statement(&suite(f)).await };
    lost_connection => |f| async move { a_killed_connection_is_reported_then_reconnected(&suite(f)).await };
    lost_connection_with_a_transaction => |f| async move { an_open_transaction_is_reported_rolled_back_after_a_kill(&suite(f)).await };
    introspection_is_independent_of_the_session => |f| async move { introspection_works_while_a_query_runs(&suite(f)).await };
    unknown_driver => |f| async move { unknown_driver_is_unavailable(&cfg(f)).await };
}

both! {
    credentials:
    wrong_password => |f| async move {
        let c = cfg_as(f, "clew", "wrong-secret-pw");
        wrong_credentials_are_auth_failed(&c, "wrong-secret-pw").await;
    };
    unreachable => |f| async move {
        let mut c = cfg(f);
        c.target = Target::Network { host: "10.255.255.1".into(), port: 3306 };
        c.connect_timeout_secs = 2;
        an_unreachable_host_times_out(&c, "10.255.255.1:3306").await;
    };
}

// ---- MySQL / MariaDB specifics ---------------------------------------------------------------

both! {
    specifics:
    // (spec: driver-framework › Cancel a long query)
    cancel_select_sleep => |_f| async move {
        // The spec scenario: SELECT SLEEP(60). MySQL returns from an interrupted SLEEP() without
        // an error, so only the timing and the session's health are checked.
        let c = connect(&cfg(_f)).await;
        let mgr = c.mgr.clone();
        let sid = c.session.clone();
        let task = tokio::spawn(async move { run(&mgr, &sid, "SELECT SLEEP(60)").await });
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let started = std::time::Instant::now();
        c.mgr.cancel(&c.session).await.expect("cancel");
        let _ = task.await.unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
        assert_eq!(c.must("SELECT 1").await.scalar_int(), 1);
    };

    source_table_and_column => |f| async move {
        let c = connect(&cfg(f)).await;
        c.must("DROP TABLE IF EXISTS conf_my_src").await;
        c.must("CREATE TABLE conf_my_src (id BIGINT PRIMARY KEY, label VARCHAR(20))").await;
        c.must("INSERT INTO conf_my_src VALUES (1, 'a')").await;
        let r = c.must("SELECT id AS pk, label, id + 1 AS computed FROM conf_my_src").await;
        let cols = r.columns();
        assert!(cols[0].source_table.as_deref().unwrap_or("").ends_with("conf_my_src"), "{:?}", cols[0]);
        assert_eq!(cols[0].source_column.as_deref(), Some("id"), "the original name, not the alias");
        assert_eq!(cols[1].source_column.as_deref(), Some("label"));
        assert_eq!(cols[2].source_table, None, "computed columns have no source");
        assert_eq!(cols[0].kind, ValueKind::Bigint);
        c.must("DROP TABLE conf_my_src").await;
    };

    type_decoding => |f| async move {
        let c = connect(&root(f)).await;
        c.must("DROP TABLE IF EXISTS clew.conf_my_types").await;
        c.must("CREATE TABLE clew.conf_my_types (\
                 tiny TINYINT, big_u BIGINT UNSIGNED, big BIGINT, dec30 DECIMAL(30,10), \
                 dt DATETIME(6), ts TIMESTAMP NULL, d DATE, t TIME, yr YEAR, js JSON, \
                 b8 BIT(8), flag TINYINT(1), status ENUM('new','paid'), tags SET('a','b','c'), \
                 blob_ BLOB, vbin VARBINARY(10), f FLOAT, dbl DOUBLE, txt TEXT, nothing VARCHAR(5))").await;
        // allow zero dates for this session only
        c.must("SET SESSION sql_mode = ''").await;
        c.must("INSERT INTO clew.conf_my_types (tiny, big_u, big, dec30, dt, ts, d, t, yr, js, b8, flag, status, tags, blob_, vbin, f, dbl, txt) VALUES \
                 (-5, 18446744073709551615, 9007199254740993, 12345678901234567890.0123456789, \
                  '2026-10-08 21:14:07.5', '2026-10-08 21:14:07', '2026-10-08', '21:14:07', 2026, '{\"a\":[1,2]}', \
                  b'101', 1, 'paid', 'a,c', X'DEAD', X'BEEF', 0.1, 1.5, 'héllo')").await;
        c.must("INSERT INTO clew.conf_my_types (dt, d, ts) VALUES ('0000-00-00 00:00:00', '0000-00-00', '0000-00-00 00:00:00')").await;

        let r = c.must("SELECT * FROM clew.conf_my_types ORDER BY tiny DESC").await;
        let cols: Vec<String> = r.columns().iter().map(|c| c.name.clone()).collect();
        let row = &r.rows()[0];
        let by: std::collections::HashMap<_, _> = cols.iter().cloned().zip(row.iter().cloned()).collect();

        assert_eq!(by["tiny"], Value::Int { value: -5 });
        assert_eq!(by["big_u"], Value::Bigint { value: "18446744073709551615".into() });
        assert_eq!(by["big"], Value::Bigint { value: "9007199254740993".into() });
        assert_eq!(by["dec30"], Value::decimal("12345678901234567890.0123456789"));
        assert_eq!(by["dt"], Value::Timestamp { value: "2026-10-08T21:14:07.500000".into() });
        assert_eq!(by["ts"], Value::Timestamptz { value: "2026-10-08T21:14:07Z".into() });
        assert_eq!(by["d"], Value::Date { value: "2026-10-08".into() });
        assert_eq!(by["t"], Value::Time { value: "21:14:07".into() });
        assert_eq!(by["yr"], Value::Int { value: 2026 });
        if f.maria {
            // MariaDB's JSON is an alias for LONGTEXT
            assert!(matches!(&by["js"], Value::Text { value, .. } if value.contains("\"a\"")), "{:?}", by["js"]);
        } else {
            assert_eq!(by["js"], Value::json(serde_json::json!({"a": [1, 2]})));
        }
        assert_eq!(by["b8"], Value::Int { value: 5 });
        assert_eq!(by["flag"], Value::Bool { value: true });
        assert_eq!(by["status"], Value::text("paid"));
        assert_eq!(by["tags"], Value::text("a,c"));
        assert_eq!(by["blob_"], Value::bytes(&[0xde, 0xad]));
        assert_eq!(by["vbin"], Value::bytes(&[0xbe, 0xef]));
        assert_eq!(by["f"], Value::Float { value: 0.1 });
        assert_eq!(by["dbl"], Value::Float { value: 1.5 });
        assert_eq!(by["txt"], Value::text("héllo"));
        assert_eq!(by["nothing"], Value::Null);

        // zero dates arrive as `other` with their text, not as an error
        let zero = &r.rows()[1];
        let z: std::collections::HashMap<_, _> = cols.iter().cloned().zip(zero.iter().cloned()).collect();
        assert_eq!(z["dt"], Value::other("0000-00-00 00:00:00.000000", "DATETIME"));
        assert_eq!(z["d"], Value::other("0000-00-00", "DATE"));
        assert!(z["dt"].is_read_only());
        assert_eq!(z["tiny"], Value::Null);
        c.must("DROP TABLE clew.conf_my_types").await;
    };

    large_values => |f| async move {
        let c = connect(&cfg(f)).await;
        c.must("DROP TABLE IF EXISTS conf_my_big").await;
        c.must("CREATE TABLE conf_my_big (id INT PRIMARY KEY, body LONGTEXT, blob_ LONGBLOB)").await;
        c.must("INSERT INTO conf_my_big VALUES (1, REPEAT('x', 1500000), UNHEX(REPEAT('AB', 1200000)))").await;
        let r = c.must("SELECT body, blob_ FROM conf_my_big").await;
        let row = &r.rows()[0];
        let Value::Text { value, truncated } = &row[0] else { panic!("{:?}", row[0]) };
        assert!(truncated);
        assert_eq!(value.len(), 64 * 1024);
        let Value::Bytes { len, truncated, .. } = &row[1] else { panic!() };
        assert!(truncated);
        assert_eq!(*len, 1_200_000);

        let table = NodePath::root()
            .child(NodeKind::Database, "clew")
            .child(NodeKind::Table, "conf_my_big");
        let full = c
            .mgr
            .fetch_full_value(&c.session, FullValueRequest {
                table: table.clone(),
                column: "body".into(),
                key: vec![("id".into(), Value::Int { value: 1 })],
            })
            .await
            .expect("full value");
        let Value::Text { value, truncated } = full else { panic!() };
        assert!(!truncated);
        assert_eq!(value.len(), 1_500_000);
        let missing = c
            .mgr
            .fetch_full_value(&c.session, FullValueRequest {
                table,
                column: "body".into(),
                key: vec![("id".into(), Value::Int { value: 99 })],
            })
            .await;
        assert!(missing.is_err());
        c.must("DROP TABLE conf_my_big").await;
    };

    read_only_sessions_refuse_writes => |f| async move {
        let admin = connect(&root(f)).await;
        admin.must("DROP TABLE IF EXISTS clew.conf_my_ro").await;
        admin.must("CREATE TABLE clew.conf_my_ro (x INT)").await;
        admin.must("GRANT ALL ON clew.* TO 'clew'@'%'").await;
        let mut c = cfg(f);
        c.read_only = true;
        let ro = connect(&c).await;
        let r = ro.run("INSERT INTO conf_my_ro VALUES (1)").await;
        assert_eq!(r.err().code, ErrorCode::ReadOnly);
        assert!(r.err().message.to_lowercase().contains("read-only"), "{}", r.err().message);
        assert_eq!(ro.must("SELECT 1").await.scalar_int(), 1);
        admin.must("DROP TABLE clew.conf_my_ro").await;
    };

    permission_denied_is_access_denied => |f| async move {
        let admin = connect(&root(f)).await;
        admin.must("DROP TABLE IF EXISTS clew.conf_my_secret").await;
        admin.must("CREATE TABLE clew.conf_my_secret (x INT)").await;
        admin.must("DROP USER IF EXISTS 'conf_nobody'@'%'").await;
        admin.must("CREATE USER 'conf_nobody'@'%' IDENTIFIED BY 'nobody'").await;
        let mut nobody = cfg_as(f, "conf_nobody", "nobody");
        nobody.database = None; // the user may not even enter `clew`
        let n = connect(&nobody).await;
        let r = n.run("SELECT * FROM clew.conf_my_secret").await;
        assert_eq!(r.err().code, ErrorCode::AccessDenied, "{:?}", r.err());
        admin.must("DROP USER 'conf_nobody'@'%'").await;
        admin.must("DROP TABLE clew.conf_my_secret").await;
    };

    server_errors => |f| async move {
        let c = connect(&cfg(f)).await;
        c.must("DROP TABLE IF EXISTS conf_my_err").await;
        c.must("CREATE TABLE conf_my_err (id INT PRIMARY KEY)").await;
        c.must("INSERT INTO conf_my_err VALUES (1)").await;
        let dup = c.run("INSERT INTO conf_my_err VALUES (1)").await;
        assert_eq!(dup.err().code, ErrorCode::QueryFailed);
        assert!(dup.err().message.contains("Duplicate"), "{}", dup.err().message);
        let missing = c.run("SELECT * FROM no_such_table").await;
        assert_eq!(missing.err().code, ErrorCode::QueryFailed);
        assert_eq!(c.must("SELECT 1").await.scalar_int(), 1);
        c.must("DROP TABLE conf_my_err").await;
    };
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

both! {
    introspection:
    the_tree_loads_lazily_down_to_columns => |f| async move {
        let c = connect(&root(f)).await;
        c.must("DROP DATABASE IF EXISTS conf_tree").await;
        c.must("CREATE DATABASE conf_tree").await;
        c.must("CREATE TABLE conf_tree.users (id BIGINT PRIMARY KEY, name VARCHAR(50) NOT NULL DEFAULT 'anon')").await;
        c.must("CREATE TABLE conf_tree.orders (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL, total DECIMAL(12,2), \
                 CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES conf_tree.users(id), KEY orders_user_idx (user_id))").await;
        c.must("CREATE VIEW conf_tree.big_orders AS SELECT * FROM conf_tree.orders WHERE total > 100").await;
        c.must("CREATE FUNCTION conf_tree.add_one(i INT) RETURNS INT DETERMINISTIC RETURN i + 1").await;
        c.must("CREATE TRIGGER conf_tree.orders_bi BEFORE INSERT ON conf_tree.orders FOR EACH ROW SET NEW.total = IFNULL(NEW.total, 0)").await;
        c.must("INSERT INTO conf_tree.users SELECT n, CONCAT('u', n) FROM (SELECT a.d + 10*b.d + 100*c.d + 1 AS n FROM \
                 (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a, \
                 (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b, \
                 (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c) t").await;
        c.must("ANALYZE TABLE conf_tree.users").await;

        // databases are the top level; system databases are hidden
        let dbs = children(&c, &NodePath::root()).await;
        let db = find(&dbs, "conf_tree");
        assert_eq!(db.kind, NodeKind::Database);
        assert!(!dbs.iter().any(|d| d.name == "mysql" || d.name == "information_schema" || d.name == "sys"));

        // groups come straight under the database (no schemas)
        let groups = children(&c, &db.path).await;
        let names: Vec<_> = groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["tables", "views", "routines", "triggers"]);
        assert_eq!(find(&groups, "tables").detail.as_deref(), Some("2"));
        assert_eq!(find(&groups, "views").detail.as_deref(), Some("1"));

        let tables = children(&c, &find(&groups, "tables").path).await;
        assert_eq!(tables.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["orders", "users"]);
        assert!(find(&tables, "users").detail.is_some(), "row estimate is shown");

        assert_eq!(children(&c, &find(&groups, "views").path).await[0].name, "big_orders");
        let routines = children(&c, &find(&groups, "routines").path).await;
        assert_eq!((routines[0].name.as_str(), routines[0].kind), ("add_one", NodeKind::Function));
        let triggers = children(&c, &find(&groups, "triggers").path).await;
        assert_eq!(triggers[0].name, "orders_bi");
        assert_eq!(triggers[0].detail.as_deref(), Some("BEFORE INSERT ON orders"));

        // columns: type, nullability, default, pk and fk target
        let cols = children(&c, &find(&tables, "orders").path).await;
        let id = find(&cols, "id").column.clone().unwrap();
        assert!(id.primary_key && !id.nullable);
        let uid = find(&cols, "user_id").column.clone().unwrap();
        assert_eq!(uid.foreign_key.as_deref(), Some("users.id"));
        assert!(uid.type_name.starts_with("bigint"), "{}", uid.type_name);
        assert!(find(&cols, "total").column.clone().unwrap().nullable);
        assert_eq!(find(&cols, "total").column.clone().unwrap().type_name, "decimal(12,2)");
        let users = children(&c, &find(&tables, "users").path).await;
        let default = find(&users, "name").column.clone().unwrap().default.unwrap();
        assert!(default.contains("anon"), "{default}");
        assert!(cols.iter().any(|n| n.kind == NodeKind::PrimaryKey && n.detail.as_deref() == Some("(id)")));
        assert!(cols.iter().any(|n| n.kind == NodeKind::ForeignKey && n.name == "fk_orders_user"));
        assert!(cols.iter().any(|n| n.kind == NodeKind::Index && n.name == "orders_user_idx"));

        c.must("DROP DATABASE conf_tree").await;
    };

    ddl_via_show_create => |f| async move {
        let c = connect(&root(f)).await;
        c.must("DROP DATABASE IF EXISTS conf_ddl").await;
        c.must("CREATE DATABASE conf_ddl").await;
        c.must("CREATE TABLE conf_ddl.t (id INT PRIMARY KEY)").await;
        c.must("CREATE VIEW conf_ddl.v AS SELECT id FROM conf_ddl.t").await;
        c.must("CREATE FUNCTION conf_ddl.f() RETURNS INT DETERMINISTIC RETURN 1").await;
        let db = NodePath::root().child(NodeKind::Database, "conf_ddl");
        let ddl = |kind, name: &str| {
            let path = db.child(kind, name);
            let mgr = c.mgr.clone();
            async move { mgr.ddl("conf", &path).await.expect("ddl") }
        };
        assert!(ddl(NodeKind::Table, "t").await.contains("CREATE TABLE"));
        assert!(ddl(NodeKind::View, "v").await.contains("VIEW"));
        assert!(ddl(NodeKind::Function, "f").await.contains("FUNCTION"));
        let err = c.mgr.ddl("conf", &db).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Unsupported);
        c.must("DROP DATABASE conf_ddl").await;
    };

    read_only_sessions_and_estimates => |f| async move {
        use clew_lib::safety::guard::{Decision, Policy};
        let c = connect(&root(f)).await;
        c.must("DROP DATABASE IF EXISTS conf_sg").await;
        c.must("CREATE DATABASE conf_sg").await;
        c.must("CREATE TABLE conf_sg.t (id INT PRIMARY KEY, v VARCHAR(10))").await;
        c.must("INSERT INTO conf_sg.t SELECT seq, 'x' FROM (WITH RECURSIVE s(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM s WHERE seq < 200) SELECT seq FROM s) q").await;

        // Backstop: the database itself refuses writes on a read-only session.
        let mut cfg = root(f);
        cfg.read_only = true;
        let registry = clew_lib::drivers::registry::Registry::with_defaults();
        let mut session = registry.get(f.driver).unwrap().open(&cfg).await.unwrap();
        let (sink, _rx) = clew_lib::drivers::ResultSink::channel(8);
        let err = session
            .execute(
                clew_lib::drivers::ExecRequest {
                    sql: "INSERT INTO conf_sg.t VALUES (999, 'z')".into(),
                    page_size: 10,
                    script: false,
                    continue_on_error: false,
                },
                sink,
            )
            .await
            .unwrap_err();
        assert!(err.message.to_lowercase().contains("read only"), "{}", err.message);

        c.mgr.set_policy("conf", Policy::managed("prod", "production", true));
        let report = c.mgr.safety_check(&c.session, "UPDATE conf_sg.t SET v = 'y' WHERE id <= 100", false).await.unwrap();
        assert_eq!(report.decision, Decision::Confirm);
        let estimate = report.statements[0].estimate.expect("an estimate");
        assert!((20..=200).contains(&estimate), "estimate {estimate}");
        c.mgr.set_policy("conf", Policy::default());
        c.must("DROP DATABASE conf_sg").await;
    };

    staged_changes_apply_and_roll_back_on_conflict => |f| async move {
        let c = connect(&root(f)).await;
        c.must("DROP DATABASE IF EXISTS conf_chg").await;
        c.must("CREATE DATABASE conf_chg").await;
        c.must("CREATE TABLE conf_chg.t (id BIGINT PRIMARY KEY, name VARCHAR(40), n DECIMAL(10,2), note TEXT)").await;
        c.must("INSERT INTO conf_chg.t VALUES (1, 'old', 1.50, NULL), (2, 'gone', 2.00, 'x')").await;
        let path = NodePath::root()
            .child(NodeKind::Database, "conf_chg")
            .child(NodeKind::Group, "tables")
            .child(NodeKind::Table, "t");
        let request = |old: &str| -> clew_lib::changes::ChangeRequest {
            serde_json::from_value(serde_json::json!({
                "path": path,
                "columns": [
                    {"name": "id", "type_name": "BIGINT"},
                    {"name": "name", "type_name": "VARCHAR"},
                    {"name": "n", "type_name": "DECIMAL"},
                    {"name": "note", "type_name": "TEXT"},
                ],
                "keyColumns": ["id"],
                "edits": [{
                    "key": [{"kind": "int", "value": 1}],
                    "changes": [
                        {"column": "name",
                         "old": {"kind": "text", "value": old, "truncated": false},
                         "new": {"kind": "value", "value": {"kind": "text", "value": "it's new", "truncated": false}}},
                        {"column": "n",
                         "old": {"kind": "decimal", "value": "1.50"},
                         "new": {"kind": "value", "value": {"kind": "decimal", "value": "9.25"}}},
                        {"column": "note",
                         "old": {"kind": "null"},
                         "new": {"kind": "value", "value": {"kind": "text", "value": "hi", "truncated": false}}},
                    ],
                }],
                "inserts": [{"values": [
                    {"column": "id", "value": {"kind": "value", "value": {"kind": "int", "value": 3}}},
                    {"column": "name", "value": {"kind": "value", "value": {"kind": "null"}}},
                ]}],
                "deletes": [{"key": [{"kind": "int", "value": 2}]}],
            }))
            .unwrap()
        };
        let driver = f.driver;
        let stale = clew_lib::changes::build(driver, &request("someone else's")).unwrap();
        let out = c.mgr.apply_changes(&c.session, &stale).await.expect("apply");
        assert!(out.failure.expect("conflict").conflict);
        let n = run(&c.mgr, &c.session, "SELECT count(*) FROM conf_chg.t").await.scalar_int();
        assert_eq!(n, 2, "rolled back");

        let ok = clew_lib::changes::build(driver, &request("old")).unwrap();
        let out = c.mgr.apply_changes(&c.session, &ok).await.expect("apply");
        assert!(out.failure.is_none(), "{:?}", out.failure);
        let rows = run(&c.mgr, &c.session, "SELECT id, name, CAST(n AS CHAR), note FROM conf_chg.t ORDER BY id").await.rows();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][1], Value::Text { value: "it's new".into(), truncated: false });
        assert_eq!(rows[0][3], Value::Text { value: "hi".into(), truncated: false });
        assert_eq!(rows[1][0], Value::Int { value: 3 });
        c.must("DROP DATABASE conf_chg").await;
    };

    table_meta_reports_structure => |f| async move {
        let c = connect(&root(f)).await;
        c.must("DROP DATABASE IF EXISTS conf_meta").await;
        c.must("CREATE DATABASE conf_meta").await;
        c.must("CREATE TABLE conf_meta.users (id BIGINT PRIMARY KEY, email VARCHAR(100) NOT NULL, UNIQUE KEY users_email (email))").await;
        c.must("CREATE TABLE conf_meta.orders (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL, status VARCHAR(20) DEFAULT 'new' COMMENT 'Order state', note TEXT, KEY orders_status_idx (status), CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES conf_meta.users (id) ON DELETE CASCADE)").await;
        c.must("CREATE TABLE conf_meta.items (order_id BIGINT, n INT, CONSTRAINT items_order_fk FOREIGN KEY (order_id) REFERENCES conf_meta.orders (id))").await;
        let db = NodePath::root().child(NodeKind::Database, "conf_meta");
        let orders = c.mgr.table_meta("conf", &db.child(NodeKind::Table, "orders")).await.expect("meta");
        let col = |n: &str| orders.columns.iter().find(|c| c.name == n).unwrap();
        assert!(col("id").primary_key);
        assert!(!col("user_id").nullable && col("note").nullable);
        assert_eq!(col("status").comment.as_deref(), Some("Order state"));
        // MariaDB reports string defaults quoted, MySQL does not.
        assert_eq!(col("status").default.as_deref().map(|d| d.trim_matches('\'')), Some("new"));
        let idx = orders.indexes.iter().find(|i| i.name == "orders_status_idx").unwrap();
        assert_eq!(idx.columns, ["status"]);
        assert!(!idx.unique);
        assert!(orders.indexes.iter().any(|i| i.primary && i.unique));
        let fk = &orders.foreign_keys[0];
        assert_eq!((fk.name.as_str(), fk.ref_table.as_str()), ("orders_user_fk", "users"));
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(orders.referenced_by.len(), 1);
        assert_eq!(orders.referenced_by[0].table, "items");
        assert_eq!(orders.referenced_by[0].columns, ["order_id"]);
        let users = c.mgr.table_meta("conf", &db.child(NodeKind::Table, "users")).await.unwrap();
        assert!(users.indexes.iter().any(|i| i.name == "users_email" && i.unique));
        c.must("DROP DATABASE conf_meta").await;
    };

    count_rows_is_exact => |f| async move {
        let c = connect(&root(f)).await;
        c.must("DROP DATABASE IF EXISTS conf_count").await;
        c.must("CREATE DATABASE conf_count").await;
        c.must("CREATE TABLE conf_count.`we``ird` (id INT)").await;
        c.must("INSERT INTO conf_count.`we``ird` VALUES (1), (2), (3)").await;
        c.must("CREATE VIEW conf_count.v AS SELECT id FROM conf_count.`we``ird` WHERE id > 1").await;
        let db = NodePath::root().child(NodeKind::Database, "conf_count");
        assert_eq!(c.mgr.count_rows("conf", &db.child(NodeKind::Table, "we`ird")).await.unwrap(), 3);
        assert_eq!(c.mgr.count_rows("conf", &db.child(NodeKind::View, "v")).await.unwrap(), 2);
        c.must("DROP DATABASE conf_count").await;
    };

    completion_snapshot => |f| async move {
        let c = connect(&root(f)).await;
        c.must("DROP DATABASE IF EXISTS conf_snap").await;
        c.must("CREATE DATABASE conf_snap").await;
        c.must("CREATE TABLE conf_snap.items (id BIGINT, label VARCHAR(20))").await;
        c.must("CREATE VIEW conf_snap.v_items AS SELECT id FROM conf_snap.items").await;
        c.must("CREATE FUNCTION conf_snap.f() RETURNS INT DETERMINISTIC RETURN 1").await;
        let snap = c.mgr.completion_snapshot("conf", "conf_snap").await.expect("snapshot");
        assert_eq!(snap.schemas.len(), 1);
        let s = &snap.schemas[0];
        assert_eq!(s.name, "conf_snap");
        let items = s.tables.iter().find(|t| t.name == "items").unwrap();
        let cols: Vec<_> = items.columns.iter().map(|c| (c.name.as_str(), c.type_name.as_str())).collect();
        assert_eq!(cols[0].0, "id");
        assert!(cols[0].1.starts_with("bigint"), "{:?}", cols);
        assert_eq!(cols[1], ("label", "varchar(20)"));
        assert_eq!(s.tables.iter().find(|t| t.name == "v_items").unwrap().kind, NodeKind::View);
        assert_eq!(s.functions, ["f"]);
        c.must("DROP DATABASE conf_snap").await;
    };
}

// ---- TLS -------------------------------------------------------------------------------------

fn tls(f: Flavor, mode: TlsMode) -> ResolvedConfig {
    let mut c = cfg(f);
    c.tls = TlsConfig {
        mode,
        ..Default::default()
    };
    c
}

async fn cipher(cfg: &ResolvedConfig) -> String {
    let c = connect(cfg).await;
    let r = c.must("SHOW SESSION STATUS LIKE 'Ssl_cipher'").await;
    match &r.rows()[0][1] {
        Value::Text { value, .. } => value.clone(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn mysql_encrypts_when_asked_and_not_when_disabled() {
    assert!(
        !cipher(&tls(MYSQL, TlsMode::Require)).await.is_empty(),
        "require encrypts"
    );
    assert!(
        !cipher(&tls(MYSQL, TlsMode::Prefer)).await.is_empty(),
        "prefer uses TLS when offered"
    );
    assert!(
        cipher(&tls(MYSQL, TlsMode::Disable)).await.is_empty(),
        "disable stays in plain text"
    );
}

#[tokio::test]
async fn mysql_verify_ca_rejects_a_server_certificate_it_does_not_trust() {
    let mut c = tls(MYSQL, TlsMode::VerifyCa);
    // the test CA did not sign MySQL's auto-generated certificate
    c.tls.ca_file = Some(format!(
        "{}/../docker/postgres-tls/certs/ca.crt",
        env!("CARGO_MANIFEST_DIR")
    ));
    let err = manager().test_connection(&c).await.expect_err("must fail");
    assert_eq!(err.code, ErrorCode::TlsFailed, "{err:?}");
}

#[tokio::test]
async fn mariadb_encrypts_when_asked_and_not_when_disabled() {
    // MariaDB 11 generates a certificate by default, so it behaves like MySQL here.
    assert!(!cipher(&tls(MARIADB, TlsMode::Require)).await.is_empty());
    assert!(cipher(&tls(MARIADB, TlsMode::Disable)).await.is_empty());
}

#[tokio::test]
async fn binary_collations_do_not_turn_text_into_bytes() {
    for f in [MYSQL, MARIADB] {
        let c = connect(&root(f)).await;
        c.must("DROP TABLE IF EXISTS clew.conf_my_bin").await;
        c.must("CREATE TABLE clew.conf_my_bin (a VARCHAR(10) COLLATE utf8mb4_bin, b VARBINARY(10), c TEXT COLLATE utf8mb4_bin)").await;
        c.must("INSERT INTO clew.conf_my_bin VALUES ('abc', 'xyz', 'long text')")
            .await;
        let r = c.must("SELECT a, b, c FROM clew.conf_my_bin").await;
        let row = &r.rows()[0];
        assert_eq!(row[0], Value::text("abc"), "{}", f.product);
        assert_eq!(row[1], Value::bytes(b"xyz"), "a real VARBINARY stays bytes");
        assert_eq!(row[2], Value::text("long text"));
        assert_eq!(r.columns()[0].type_name, "VARCHAR");
        c.must("DROP TABLE clew.conf_my_bin").await;
    }
}

// ---- SSH tunnel ------------------------------------------------------------------------------

both! {
    tunnel:
    a_tunnelled_session_works => |f| async move {
        use clew_lib::drivers::{SshAuth, SshConfig};
        use clew_lib::transport::hostkey::{HostKeyPrompt, HostKeyPrompter, KnownHosts};
        use clew_lib::transport::ssh::SshEnv;
        use std::sync::Arc;

        struct Yes;
        #[async_trait::async_trait]
        impl HostKeyPrompter for Yes {
            async fn confirm(&self, _: HostKeyPrompt) -> bool { true }
        }
        let dir = tempfile::tempdir().unwrap();
        let env = SshEnv {
            known_hosts: KnownHosts { user_file: None, app_file: dir.path().join("kh") },
            prompter: Arc::new(Yes),
        };
        let mgr = Arc::new(clew_lib::sessions::SessionManager::new(
            Arc::new(clew_lib::drivers::registry::Registry::with_defaults()),
            env,
        ));
        let mut c = cfg(f);
        // the compose service name, resolvable from the bastion only
        c.target = Target::Network { host: f.driver.to_string(), port: 3306 };
        c.ssh = Some(SshConfig {
            host: "127.0.0.1".into(),
            port: 2222,
            user: "tunnel".into(),
            auth: SshAuth::Password { password: Secret::new("tunnelpw") },
        });
        // `mariadb`'s service is called mariadb, `mysql`'s is mysql: same as the driver id here
        let info = mgr.test_connection(&c).await.expect("test through the tunnel");
        assert_eq!(info.product, f.product);
        mgr.connect("t", c).await.expect("connect");
        let opened = mgr.open_session("t").await.expect("open");
        assert_eq!(opened.transport.as_deref(), Some("via SSH 127.0.0.1"));
        assert_eq!(run(&mgr, &opened.session_id, "SELECT 1").await.scalar_int(), 1);
    };
}
