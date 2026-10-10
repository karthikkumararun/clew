//! PostgreSQL conformance + driver-specific tests. Needs `docker compose up -d --build --wait`
//! (and `scripts/gen-test-certs.sh` once). Run with `cargo test --features integration`.
#![cfg(feature = "integration")]

mod conformance;

use clew_lib::drivers::introspect::{NodeKind, NodePath, TreeNode};
use clew_lib::drivers::{
    ErrorCode, FullValueRequest, ResolvedConfig, Secret, Target, TlsConfig, TlsMode, Value,
    ValueKind,
};
use conformance::*;

const PORT: u16 = 54316;
const TLS_PORT: u16 = 54317;
const TLS_WRONG_PORT: u16 = 54318;

fn cfg_for(port: u16) -> ResolvedConfig {
    ResolvedConfig {
        driver: "postgres".into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port,
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
        cfg: cfg_for(PORT),
        dialect: Dialect {
            product: "PostgreSQL",
            generate_rows: |n| format!("SELECT g AS n FROM generate_series(1, {n}) g"),
            sleep_long: "SELECT pg_sleep(60)",
            syntax_error: "SELEC 1",
            error_position: Some(1),
            backend_id_sql: Some("SELECT pg_backend_pid()"),
            kill_sql: Some(|pid| format!("SELECT pg_terminate_backend({pid})")),
        },
    }
}

fn certs(name: &str) -> String {
    format!(
        "{}/../docker/postgres-tls/certs/{name}",
        env!("CARGO_MANIFEST_DIR")
    )
}

// ---- shared conformance ----------------------------------------------------------------------

#[tokio::test]
async fn test_connection() {
    test_connection_reports_the_server(&suite()).await;
}

#[tokio::test]
async fn the_server_version_shows_in_the_session() {
    let s = suite();
    session_reports_the_server(&s).await;
    let c = connect(&s.cfg).await;
    let v = c.mgr.server_info(&c.session).unwrap();
    assert!(
        v.version.starts_with("16") || v.version.starts_with("17"),
        "{}",
        v.version
    );
    assert_eq!(v.display(), format!("PostgreSQL {}", v.version));
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
    rows_affected_without_a_result_set(&suite(), "conf_pg_affected").await;
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
async fn transactions() {
    transactions_span_statements(&suite(), "conf_pg_tx").await;
}

#[tokio::test]
async fn temp_tables() {
    temporary_tables_belong_to_the_session(&suite(), "conf_pg_temp").await;
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
async fn lost_connection() {
    a_killed_connection_is_reported_then_reconnected(&suite()).await;
}

#[tokio::test]
async fn lost_connection_with_a_transaction() {
    an_open_transaction_is_reported_rolled_back_after_a_kill(&suite()).await;
}

#[tokio::test]
async fn introspection_is_independent_of_the_session() {
    introspection_works_while_a_query_runs(&suite()).await;
}

#[tokio::test]
async fn wrong_password() {
    let mut cfg = cfg_for(PORT);
    cfg.password = Some(Secret::new("wrong-secret-pw"));
    wrong_credentials_are_auth_failed(&cfg, "wrong-secret-pw").await;
}

#[tokio::test]
async fn unreachable() {
    let mut cfg = cfg_for(PORT);
    cfg.target = Target::Network {
        host: "10.255.255.1".into(),
        port: 5432,
    };
    cfg.connect_timeout_secs = 2;
    an_unreachable_host_times_out(&cfg, "10.255.255.1:5432").await;
}

#[tokio::test]
async fn unknown_driver() {
    unknown_driver_is_unavailable(&cfg_for(PORT)).await;
}

// ---- PostgreSQL specifics --------------------------------------------------------------------

#[tokio::test]
async fn source_table_and_column_are_reported_for_editing() {
    let c = connect(&suite().cfg).await;
    c.must("DROP TABLE IF EXISTS conf_pg_src").await;
    c.must("CREATE TABLE conf_pg_src (id int8 PRIMARY KEY, label text)")
        .await;
    c.must("INSERT INTO conf_pg_src VALUES (1, 'a')").await;
    let r = c
        .must("SELECT id, label, id + 1 AS computed FROM conf_pg_src")
        .await;
    let cols = r.columns();
    assert_eq!(cols[0].source_table.as_deref(), Some("public.conf_pg_src"));
    assert_eq!(cols[0].source_column.as_deref(), Some("id"));
    assert_eq!(cols[1].source_column.as_deref(), Some("label"));
    assert_eq!(
        cols[2].source_table, None,
        "computed columns have no source"
    );
    assert_eq!(cols[0].type_name, "INT8");
    assert_eq!(cols[0].kind, ValueKind::Bigint);
    c.must("DROP TABLE conf_pg_src").await;
}

#[tokio::test]
async fn type_decoding_covers_the_value_model() {
    let c = connect(&suite().cfg).await;
    let r = c
        .must(
            "SELECT \
               12345678901234567890.0123456789::numeric(30,10) AS dec, \
               9007199254740993::int8 AS big, \
               '2026-10-08 21:14:07+00'::timestamptz AS tstz, \
               '2026-10-08 21:14:07.5'::timestamp AS ts, \
               '2026-10-08'::date AS d, \
               '21:14:07'::time AS t, \
               'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS u, \
               '{\"a\":[1,2,{\"b\":null}]}'::jsonb AS jb, \
               '{\"a\":1}'::json AS j, \
               ARRAY[1,2,3]::int4[] AS arr, \
               ARRAY[[1,2],[3,4]]::int4[] AS arr2, \
               ARRAY['x',NULL,'z']::text[] AS txt_arr, \
               '1 year 2 mons 3 days 04:05:06.25'::interval AS iv, \
               '\\xdeadbeef'::bytea AS bin, \
               true AS flag, \
               1.5::float8 AS f, \
               'NaN'::float8 AS nan, \
               NULL::text AS nothing, \
               '10.0.0.1/24'::inet AS ip, \
               '(1,2)'::point AS pt, \
               'héllo'::text AS word",
        )
        .await;
    let row = &r.rows()[0];
    let by_name: std::collections::HashMap<_, _> = r
        .columns()
        .iter()
        .map(|c| c.name.clone())
        .zip(row.iter().cloned())
        .collect();

    assert_eq!(
        by_name["dec"],
        Value::decimal("12345678901234567890.0123456789")
    );
    assert_eq!(
        by_name["big"],
        Value::Bigint {
            value: "9007199254740993".into()
        }
    );
    assert_eq!(
        by_name["tstz"],
        Value::Timestamptz {
            value: "2026-10-08T21:14:07Z".into()
        }
    );
    assert_eq!(
        by_name["ts"],
        Value::Timestamp {
            value: "2026-10-08T21:14:07.5".into()
        }
    );
    assert_eq!(
        by_name["d"],
        Value::Date {
            value: "2026-10-08".into()
        }
    );
    assert_eq!(
        by_name["t"],
        Value::Time {
            value: "21:14:07".into()
        }
    );
    assert_eq!(
        by_name["u"],
        Value::Uuid {
            value: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into()
        }
    );
    assert_eq!(
        by_name["jb"],
        Value::json(serde_json::json!({"a": [1, 2, {"b": null}]}))
    );
    assert_eq!(by_name["j"], Value::json(serde_json::json!({"a": 1})));
    assert_eq!(
        by_name["arr"],
        Value::Array {
            value: (1..=3).map(|v| Value::Int { value: v }).collect()
        }
    );
    assert!(matches!(&by_name["arr2"], Value::Array { value } if value.len() == 2));
    assert_eq!(
        by_name["txt_arr"],
        Value::Array {
            value: vec![Value::text("x"), Value::Null, Value::text("z")]
        }
    );
    assert_eq!(
        by_name["iv"],
        Value::Interval {
            value: "P1Y2M3DT4H5M6.25S".into()
        }
    );
    assert_eq!(by_name["bin"], Value::bytes(&[0xde, 0xad, 0xbe, 0xef]));
    assert_eq!(by_name["flag"], Value::Bool { value: true });
    assert_eq!(by_name["f"], Value::Float { value: 1.5 });
    assert_eq!(by_name["nan"], Value::other("NaN", "FLOAT8"));
    assert_eq!(by_name["nothing"], Value::Null);
    assert_eq!(by_name["ip"], Value::other("10.0.0.1/24", "INET"));
    assert_eq!(by_name["pt"], Value::other("(1,2)", "POINT"));
    assert!(by_name["pt"].is_read_only());
    assert_eq!(by_name["word"], Value::text("héllo"));
}

#[tokio::test]
async fn enums_and_domains_decode_as_text() {
    let c = connect(&suite().cfg).await;
    c.must("DROP TABLE IF EXISTS conf_pg_enum").await;
    c.must("DROP TYPE IF EXISTS conf_status").await;
    c.must("DROP DOMAIN IF EXISTS conf_dom").await;
    c.must("CREATE TYPE conf_status AS ENUM ('new', 'paid')")
        .await;
    c.must("CREATE DOMAIN conf_dom AS int4 CHECK (VALUE > 0)")
        .await;
    c.must("CREATE TABLE conf_pg_enum (s conf_status, d conf_dom, a conf_status[])")
        .await;
    c.must("INSERT INTO conf_pg_enum VALUES ('paid', 5, ARRAY['new','paid']::conf_status[])")
        .await;
    let r = c.must("SELECT s, d, a FROM conf_pg_enum").await;
    let row = &r.rows()[0];
    assert_eq!(row[0], Value::text("paid"));
    assert_eq!(row[1], Value::Int { value: 5 });
    assert_eq!(
        row[2],
        Value::Array {
            value: vec![Value::text("new"), Value::text("paid")]
        }
    );
    c.must("DROP TABLE conf_pg_enum").await;
    c.must("DROP TYPE conf_status").await;
    c.must("DROP DOMAIN conf_dom").await;
}

#[tokio::test]
async fn large_values_are_truncated_and_can_be_fetched_whole() {
    let c = connect(&suite().cfg).await;
    c.must("DROP TABLE IF EXISTS conf_pg_big").await;
    c.must("CREATE TABLE conf_pg_big (id int4 PRIMARY KEY, body text, blob bytea)")
        .await;
    c.must("INSERT INTO conf_pg_big SELECT 1, repeat('x', 1500000), decode(repeat('ab', 1200000), 'hex')").await;

    let r = c.must("SELECT body, blob FROM conf_pg_big").await;
    let row = &r.rows()[0];
    let Value::Text { value, truncated } = &row[0] else {
        panic!("{:?}", row[0])
    };
    assert!(truncated);
    assert_eq!(value.len(), 64 * 1024);
    let Value::Bytes {
        value,
        len,
        truncated,
    } = &row[1]
    else {
        panic!()
    };
    assert!(truncated);
    assert_eq!(*len, 1_200_000);
    assert_eq!(value.len(), 64 * 1024 * 2);
    assert!(row[0].is_read_only());

    let table = NodePath::root()
        .child(NodeKind::Database, "clew")
        .child(NodeKind::Schema, "public")
        .child(NodeKind::Table, "conf_pg_big");
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

    let missing = c
        .mgr
        .fetch_full_value(
            &c.session,
            FullValueRequest {
                table,
                column: "body".into(),
                key: vec![("id".into(), Value::Int { value: 99 })],
            },
        )
        .await;
    assert!(missing.is_err());
    c.must("DROP TABLE conf_pg_big").await;
}

#[tokio::test]
async fn permission_denied_is_access_denied() {
    let c = connect(&suite().cfg).await;
    c.must("DROP TABLE IF EXISTS conf_pg_secret").await;
    c.must("CREATE TABLE conf_pg_secret (x int)").await;
    c.must("DROP ROLE IF EXISTS conf_nobody").await;
    c.must("CREATE ROLE conf_nobody LOGIN PASSWORD 'nobody'")
        .await;
    let mut cfg = cfg_for(PORT);
    cfg.user = Some("conf_nobody".into());
    cfg.password = Some(Secret::new("nobody"));
    let n = connect(&cfg).await;
    let r = n.run("SELECT * FROM conf_pg_secret").await;
    assert_eq!(r.err().code, ErrorCode::AccessDenied, "{:?}", r.err());
    c.must("DROP TABLE conf_pg_secret").await;
    c.must("DROP OWNED BY conf_nobody").await;
    c.must("DROP ROLE conf_nobody").await;
}

#[tokio::test]
async fn read_only_sessions_refuse_writes() {
    let mut cfg = cfg_for(PORT);
    cfg.read_only = true;
    let c = connect(&cfg).await;
    let r = c.run("CREATE TABLE conf_pg_ro (x int)").await;
    assert_eq!(r.err().code, ErrorCode::QueryFailed);
    assert!(
        r.err().message.to_lowercase().contains("read-only"),
        "{}",
        r.err().message
    );
    assert_eq!(c.must("SELECT 1").await.scalar_int(), 1);
}

#[tokio::test]
async fn server_errors_carry_hint_and_detail() {
    let c = connect(&suite().cfg).await;
    c.must("DROP TABLE IF EXISTS conf_pg_hint").await;
    c.must("CREATE TABLE conf_pg_hint (id int PRIMARY KEY)")
        .await;
    c.must("INSERT INTO conf_pg_hint VALUES (1)").await;
    let dup = c.run("INSERT INTO conf_pg_hint VALUES (1)").await;
    let err = dup.err();
    assert_eq!(err.code, ErrorCode::QueryFailed);
    assert!(
        err.detail
            .as_deref()
            .unwrap_or("")
            .contains("already exists"),
        "{err:?}"
    );
    let typo = c.run("SELECT idd FROM conf_pg_hint").await;
    assert!(
        typo.err().hint.as_deref().unwrap_or("").contains("id"),
        "{:?}",
        typo.err()
    );
    assert!(typo.err().position.is_some());
    c.must("DROP TABLE conf_pg_hint").await;
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
    let c = connect(&suite().cfg).await;
    c.must("DROP SCHEMA IF EXISTS conf_tree CASCADE").await;
    c.must("CREATE SCHEMA conf_tree").await;
    c.must("CREATE TABLE conf_tree.users (id int8 PRIMARY KEY, name text NOT NULL DEFAULT 'anon')")
        .await;
    c.must("CREATE TABLE conf_tree.orders (id int8 PRIMARY KEY, user_id int8 NOT NULL REFERENCES conf_tree.users(id), total numeric(12,2))").await;
    c.must("CREATE INDEX orders_user_idx ON conf_tree.orders (user_id)")
        .await;
    c.must("CREATE VIEW conf_tree.big_orders AS SELECT * FROM conf_tree.orders WHERE total > 100")
        .await;
    c.must("CREATE FUNCTION conf_tree.add_one(i int) RETURNS int LANGUAGE sql AS 'SELECT i + 1'")
        .await;
    c.must("CREATE SEQUENCE conf_tree.seq1").await;
    c.must("CREATE TYPE conf_tree.mood AS ENUM ('ok', 'sad')")
        .await;
    c.must("INSERT INTO conf_tree.users SELECT g, 'u' || g FROM generate_series(1, 5000) g")
        .await;
    c.must("ANALYZE conf_tree.users").await;

    // databases
    let dbs = children(&c, &NodePath::root()).await;
    let db = find(&dbs, "clew");
    assert_eq!(db.kind, NodeKind::Database);
    assert!(db.has_children);
    assert!(
        !dbs.iter().any(|d| d.name == "template0"),
        "templates are hidden"
    );

    // schemas
    let schemas = children(&c, &db.path).await;
    assert!(!schemas
        .iter()
        .any(|s| s.name == "pg_catalog" || s.name == "information_schema"));
    let schema = find(&schemas, "conf_tree");

    // groups with counts
    let groups = children(&c, &schema.path).await;
    let names: Vec<_> = groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "tables",
            "views",
            "materialized views",
            "functions",
            "sequences",
            "types"
        ]
    );
    assert_eq!(find(&groups, "tables").detail.as_deref(), Some("2"));
    assert_eq!(find(&groups, "views").detail.as_deref(), Some("1"));
    assert!(!find(&groups, "materialized views").has_children);

    // tables sorted by name with an estimate
    let tables = children(&c, &find(&groups, "tables").path).await;
    let t: Vec<_> = tables.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(t, ["orders", "users"]);
    assert_eq!(find(&tables, "users").detail.as_deref(), Some("5.0k"));

    // views, functions, sequences, types
    assert_eq!(
        children(&c, &find(&groups, "views").path).await[0].name,
        "big_orders"
    );
    let funcs = children(&c, &find(&groups, "functions").path).await;
    assert_eq!(funcs[0].name, "add_one");
    assert_eq!(funcs[0].detail.as_deref(), Some("(i integer)"));
    assert_eq!(
        children(&c, &find(&groups, "sequences").path).await[0].name,
        "seq1"
    );
    let types = children(&c, &find(&groups, "types").path).await;
    assert_eq!(
        (types[0].name.as_str(), types[0].detail.as_deref()),
        ("mood", Some("enum"))
    );

    // columns of orders: type, nullability, default, pk and fk target
    let cols = children(&c, &find(&tables, "orders").path).await;
    let id = find(&cols, "id").column.clone().unwrap();
    assert!(id.primary_key && !id.nullable);
    let user_id = find(&cols, "user_id").column.clone().unwrap();
    assert_eq!(user_id.foreign_key.as_deref(), Some("users.id"));
    assert_eq!(user_id.type_name, "bigint");
    assert!(find(&cols, "total").column.clone().unwrap().nullable);
    assert_eq!(
        find(&cols, "total").column.clone().unwrap().type_name,
        "numeric(12,2)"
    );
    assert_eq!(
        find(&cols, "user_id").detail.as_deref(),
        Some("bigint → users.id")
    );
    let users_cols = children(&c, &find(&tables, "users").path).await;
    assert_eq!(
        find(&users_cols, "name")
            .column
            .clone()
            .unwrap()
            .default
            .as_deref(),
        Some("'anon'::text")
    );
    // keys and indexes follow the columns
    assert!(cols.iter().any(|n| n.kind == NodeKind::PrimaryKey));
    assert!(cols.iter().any(|n| n.kind == NodeKind::ForeignKey));
    assert!(cols
        .iter()
        .any(|n| n.kind == NodeKind::Index && n.name == "orders_user_idx"));

    c.must("DROP SCHEMA conf_tree CASCADE").await;
}

#[tokio::test]
async fn a_schema_without_usage_is_listed_as_access_denied() {
    let c = connect(&suite().cfg).await;
    c.must("DROP SCHEMA IF EXISTS conf_locked CASCADE").await;
    c.must("DROP ROLE IF EXISTS conf_viewer").await;
    c.must("CREATE ROLE conf_viewer LOGIN PASSWORD 'viewer'")
        .await;
    c.must("CREATE SCHEMA conf_locked").await;
    c.must("REVOKE ALL ON SCHEMA conf_locked FROM PUBLIC").await;
    c.must("GRANT CONNECT ON DATABASE clew TO conf_viewer")
        .await;

    let mut cfg = cfg_for(PORT);
    cfg.user = Some("conf_viewer".into());
    cfg.password = Some(Secret::new("viewer"));
    let v = connect(&cfg).await;
    let dbs = children(&v, &NodePath::root()).await;
    let schemas = children(&v, &find(&dbs, "clew").path).await;
    let locked = find(&schemas, "conf_locked");
    assert_eq!(locked.detail.as_deref(), Some("access_denied"));
    assert!(!locked.has_children);
    assert!(
        schemas.iter().any(|s| s.name == "public"),
        "the rest of the list still loads"
    );

    drop(v);
    c.must("DROP SCHEMA conf_locked CASCADE").await;
    c.must("REVOKE ALL ON DATABASE clew FROM conf_viewer").await;
    c.must("DROP ROLE conf_viewer").await;
}

#[tokio::test]
async fn the_completion_snapshot_has_everything_in_one_call() {
    let c = connect(&suite().cfg).await;
    c.must("DROP SCHEMA IF EXISTS conf_snap CASCADE").await;
    c.must("CREATE SCHEMA conf_snap").await;
    c.must("CREATE TABLE conf_snap.items (id int8, label text)")
        .await;
    c.must("CREATE VIEW conf_snap.v_items AS SELECT id FROM conf_snap.items")
        .await;
    c.must("CREATE FUNCTION conf_snap.f() RETURNS int LANGUAGE sql AS 'SELECT 1'")
        .await;

    let snap = c
        .mgr
        .completion_snapshot("conf", "clew")
        .await
        .expect("snapshot");
    let schema = snap
        .schemas
        .iter()
        .find(|s| s.name == "conf_snap")
        .expect("schema");
    let items = schema.tables.iter().find(|t| t.name == "items").unwrap();
    assert_eq!(items.kind, NodeKind::Table);
    let cols: Vec<_> = items
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str()))
        .collect();
    assert_eq!(cols, [("id", "bigint"), ("label", "text")]);
    assert_eq!(
        schema
            .tables
            .iter()
            .find(|t| t.name == "v_items")
            .unwrap()
            .kind,
        NodeKind::View
    );
    assert_eq!(schema.functions, ["f"]);
    assert!(!snap.schemas.iter().any(|s| s.name == "pg_catalog"));
    c.must("DROP SCHEMA conf_snap CASCADE").await;
}

// ---- TLS -------------------------------------------------------------------------------------

fn tls_cfg(port: u16, mode: TlsMode, ca: bool) -> ResolvedConfig {
    let mut cfg = cfg_for(port);
    cfg.tls = TlsConfig {
        mode,
        ca_file: ca.then(|| certs("ca.crt")),
        client_cert: None,
        client_key: None,
    };
    cfg
}

async fn ssl_in_use(cfg: &ResolvedConfig) -> bool {
    let c = connect(cfg).await;
    let r = c
        .must("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
        .await;
    matches!(r.rows()[0][0], Value::Bool { value: true })
}

#[tokio::test]
async fn tls_modes_against_a_real_server() {
    // disable: plain text even though the server offers TLS
    assert!(!ssl_in_use(&tls_cfg(TLS_PORT, TlsMode::Disable, false)).await);
    // require / prefer: encrypted without needing a CA
    assert!(ssl_in_use(&tls_cfg(TLS_PORT, TlsMode::Require, false)).await);
    assert!(ssl_in_use(&tls_cfg(TLS_PORT, TlsMode::Prefer, false)).await);
    // verify-ca and verify-full with the right CA
    assert!(ssl_in_use(&tls_cfg(TLS_PORT, TlsMode::VerifyCa, true)).await);
    assert!(ssl_in_use(&tls_cfg(TLS_PORT, TlsMode::VerifyFull, true)).await);
}

#[tokio::test]
async fn prefer_falls_back_to_plaintext_when_the_server_has_no_tls() {
    assert!(!ssl_in_use(&tls_cfg(PORT, TlsMode::Prefer, false)).await);
}

#[tokio::test]
async fn require_fails_when_the_server_has_no_tls() {
    let err = manager()
        .test_connection(&tls_cfg(PORT, TlsMode::Require, false))
        .await
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::TlsFailed, "{err:?}");
}

#[tokio::test]
async fn verify_full_with_the_wrong_host_name_is_tls_failed_and_names_the_mismatch() {
    let err = manager()
        .test_connection(&tls_cfg(TLS_WRONG_PORT, TlsMode::VerifyFull, true))
        .await
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::TlsFailed, "{err:?}");
    assert!(err.message.contains("127.0.0.1"), "{}", err.message);
    assert!(
        err.message.contains("not valid for the host name"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn verify_ca_accepts_the_wrong_host_name_but_not_the_wrong_ca() {
    // right CA, mismatched name: verify-ca does not care about the name
    assert!(ssl_in_use(&tls_cfg(TLS_WRONG_PORT, TlsMode::VerifyCa, true)).await);
    // no CA given: the OS trust store does not know our test CA
    let err = manager()
        .test_connection(&tls_cfg(TLS_PORT, TlsMode::VerifyCa, false))
        .await
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::TlsFailed, "{err:?}");
}

#[tokio::test]
async fn a_missing_ca_file_fails_before_connecting() {
    let mut cfg = tls_cfg(TLS_PORT, TlsMode::VerifyFull, false);
    cfg.tls.ca_file = Some("/no/such/ca.pem".into());
    let err = manager()
        .test_connection(&cfg)
        .await
        .expect_err("must fail");
    assert_eq!(err.code, ErrorCode::TlsFailed);
    assert!(err.message.contains("/no/such/ca.pem"));
}

// ---- SSH tunnel end to end -------------------------------------------------------------------

#[tokio::test]
async fn a_tunnelled_session_works_and_reports_the_transport() {
    use clew_lib::drivers::{SshAuth, SshConfig};
    use clew_lib::transport::hostkey::{HostKeyPrompt, HostKeyPrompter, KnownHosts};
    use clew_lib::transport::ssh::SshEnv;
    use std::sync::Arc;

    struct Yes;
    #[async_trait::async_trait]
    impl HostKeyPrompter for Yes {
        async fn confirm(&self, _: HostKeyPrompt) -> bool {
            true
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let env = SshEnv {
        known_hosts: KnownHosts {
            user_file: None,
            app_file: dir.path().join("kh"),
        },
        prompter: Arc::new(Yes),
    };
    let mgr = Arc::new(clew_lib::sessions::SessionManager::new(
        Arc::new(clew_lib::drivers::registry::Registry::with_defaults()),
        env,
    ));
    let mut cfg = cfg_for(PORT);
    // `postgres` is the compose service name, resolvable from the bastion only
    cfg.target = Target::Network {
        host: "postgres".into(),
        port: 5432,
    };
    cfg.ssh = Some(SshConfig {
        host: "127.0.0.1".into(),
        port: 2222,
        user: "tunnel".into(),
        auth: SshAuth::Password {
            password: Secret::new("tunnelpw"),
        },
    });

    let info = mgr
        .test_connection(&cfg)
        .await
        .expect("test through the tunnel");
    assert_eq!(info.product, "PostgreSQL");

    mgr.connect("t", cfg)
        .await
        .expect("connect through the tunnel");
    let opened = mgr.open_session("t").await.expect("open");
    assert_eq!(opened.transport.as_deref(), Some("via SSH 127.0.0.1"));
    let r = run(&mgr, &opened.session_id, "SELECT 1").await;
    assert_eq!(r.scalar_int(), 1);
    let nodes = mgr
        .introspect("t", &NodePath::root())
        .await
        .expect("introspect through the tunnel");
    assert!(!nodes.is_empty());
}
