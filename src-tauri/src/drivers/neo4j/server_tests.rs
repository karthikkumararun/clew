//! The driver against a pretend server (`fake.rs`): login, transactions, paging, cancel, errors,
//! routing. The same scenarios run against a real Neo4j in `tests/neo4j.rs`.

use std::time::Duration;

use super::fake::FakeNeo4j;
use super::Neo4jDriver;
use crate::drivers::graph::{GraphAccess, GraphMode, GraphRequest};
use crate::drivers::{
    Driver, ErrorCode, ExecRequest, ResolvedConfig, ResultEvent, ResultSink, Secret, Session,
    Target, TlsConfig, Value,
};

fn cfg(port: u16, protocol: &str) -> ResolvedConfig {
    ResolvedConfig {
        driver: "neo4j".into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port,
        },
        user: Some("neo4j".into()),
        password: Some(Secret::new("pw")),
        database: None,
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 5,
        query_timeout_secs: None,
        read_only: false,
        options: [("neo4j.protocol".to_string(), protocol.to_string())].into(),
        on_connect: vec![],
        isolation: None,
    }
}

fn req(cypher: &str, access: GraphAccess, fetch_size: u32) -> GraphRequest {
    GraphRequest {
        cypher: cypher.into(),
        params: serde_json::Map::new(),
        access,
        mode: GraphMode::Run,
        fetch_size,
    }
}

async fn open(server: &FakeNeo4j) -> Box<dyn Session> {
    Neo4jDriver::new()
        .open(&cfg(server.port, "bolt"))
        .await
        .expect("open")
}

fn ints(r: &crate::drivers::graph::GraphResult) -> Vec<i64> {
    r.records
        .iter()
        .map(|row| match &row[0] {
            Value::Int { value } => *value,
            other => panic!("{other:?}"),
        })
        .collect()
}

#[tokio::test]
async fn login_reports_the_server_and_a_wrong_password_is_auth_failed() {
    let server = FakeNeo4j::start().await;
    let info = Neo4jDriver::new()
        .test(&cfg(server.port, "bolt"))
        .await
        .unwrap();
    assert_eq!(
        (info.product.as_str(), info.version.as_str()),
        ("Neo4j", "5.26.0")
    );

    let mut wrong = cfg(server.port, "bolt");
    wrong.password = Some(Secret::new("nope"));
    let err = Neo4jDriver::new().test(&wrong).await.unwrap_err();
    // the code comes from `neo4j_code`, not the generic `code` Bolt 5.7+ sends next to it
    assert_eq!(err.code, ErrorCode::AuthFailed, "{err:?}");
    assert!(!err.message.contains("nope"));
}

#[tokio::test]
async fn a_closed_port_is_a_connection_error() {
    let err = Neo4jDriver::new().test(&cfg(1, "bolt")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::ConnectionLost);
}

#[tokio::test]
async fn reads_run_in_a_read_transaction_that_commits() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let r = s
        .as_graph()
        .unwrap()
        .query(req("ROWS 5", GraphAccess::Read, 500))
        .await
        .unwrap();
    assert_eq!(ints(&r), [1, 2, 3, 4, 5]);
    assert!(!r.has_more && r.cursor_id.is_none());
    assert_eq!(r.columns, ["n"]);
    let seen = server.seen();
    assert!(seen.contains(&"BEGIN r neo4j".to_string()), "{seen:?}");
    assert_eq!(seen.last().map(String::as_str), Some("COMMIT"));
}

#[tokio::test]
async fn writes_run_in_a_write_transaction() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    s.as_graph()
        .unwrap()
        .query(req("ROWS 1", GraphAccess::Write, 500))
        .await
        .unwrap();
    assert!(server.seen().contains(&"BEGIN w neo4j".to_string()));
}

#[tokio::test]
async fn a_read_only_session_runs_everything_in_read_mode() {
    let server = FakeNeo4j::start().await;
    let mut c = cfg(server.port, "bolt");
    c.read_only = true;
    let mut s = Neo4jDriver::new().open(&c).await.unwrap();
    s.as_graph()
        .unwrap()
        .query(req("ROWS 1", GraphAccess::Write, 500))
        .await
        .unwrap();
    assert!(server.seen().contains(&"BEGIN r neo4j".to_string()));
    // switching it to read-write takes effect for the next query
    s.set_read_only(false).await.unwrap();
    s.as_graph()
        .unwrap()
        .query(req("ROWS 1", GraphAccess::Write, 500))
        .await
        .unwrap();
    assert!(server.seen().contains(&"BEGIN w neo4j".to_string()));
}

#[tokio::test]
async fn the_server_refusing_a_write_in_a_read_transaction_is_read_only() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let err = s
        .as_graph()
        .unwrap()
        .query(req("WRITE", GraphAccess::Read, 500))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ReadOnly, "{err:?}");
    // the failed pipeline was reset: the session carries on, on the same connection
    let r = s
        .as_graph()
        .unwrap()
        .query(req("ROWS 2", GraphAccess::Read, 500))
        .await
        .unwrap();
    assert_eq!(ints(&r), [1, 2]);
    assert_eq!(
        server.connections.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[tokio::test]
async fn a_syntax_error_has_its_position_and_leaves_the_session_usable() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let err = s
        .as_graph()
        .unwrap()
        .query(req("BAD", GraphAccess::Read, 500))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::QueryFailed);
    assert_eq!(err.position, Some(1));
    assert!(s.is_alive());
    let r = s
        .as_graph()
        .unwrap()
        .query(req("ROWS 1", GraphAccess::Read, 500))
        .await
        .unwrap();
    assert_eq!(ints(&r), [1]);
}

/// (spec: driver-framework › Graph session contract › Paging records)
#[tokio::test]
async fn results_page_and_the_transaction_commits_when_the_last_batch_is_read() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let g = s.as_graph().unwrap();
    let first = g
        .query(req("ROWS 25", GraphAccess::Read, 10))
        .await
        .unwrap();
    assert!(first.has_more);
    assert_eq!(ints(&first), (1..=10).collect::<Vec<_>>());
    let id = first.cursor_id.unwrap();
    assert!(!server.seen().contains(&"COMMIT".to_string()), "still open");

    let second = g.fetch_more(&id).await.unwrap();
    assert!(second.has_more);
    assert_eq!(ints(&second), (11..=20).collect::<Vec<_>>());
    let third = g.fetch_more(&id).await.unwrap();
    assert!(!third.has_more && third.cursor_id.is_none());
    assert_eq!(ints(&third), (21..=25).collect::<Vec<_>>());
    assert_eq!(server.seen().last().map(String::as_str), Some("COMMIT"));
    assert!(g.fetch_more(&id).await.is_err(), "the cursor is gone");
}

#[tokio::test]
async fn a_new_query_resets_the_connection_instead_of_leaving_the_stream_open() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let g = s.as_graph().unwrap();
    let first = g
        .query(req("ROWS 100", GraphAccess::Read, 10))
        .await
        .unwrap();
    let id = first.cursor_id.unwrap();
    let next = g.query(req("ROWS 1", GraphAccess::Read, 10)).await.unwrap();
    assert_eq!(ints(&next), [1]);
    let seen = server.seen();
    let reset = seen.iter().position(|l| l == "RESET").expect("a RESET");
    let begin_again = seen.iter().rposition(|l| l.starts_with("BEGIN")).unwrap();
    assert!(reset < begin_again, "{seen:?}");
    assert_eq!(
        g.fetch_more(&id).await.unwrap_err().code,
        ErrorCode::QueryFailed
    );
    assert_eq!(
        server.connections.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "one connection throughout"
    );
}

/// (cancel via RESET keeps the connection)
#[tokio::test]
async fn cancel_sends_reset_and_the_connection_is_reused() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let handle = s.cancel_handle();
    let task = tokio::spawn(async move {
        let r = s
            .as_graph()
            .unwrap()
            .query(req("SLEEP", GraphAccess::Read, 500))
            .await;
        (r, s)
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    handle.cancel().await.unwrap();
    let (result, mut s) = task.await.unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert!(server.seen().contains(&"RESET".to_string()));
    assert!(s.is_alive());
    let r = s
        .as_graph()
        .unwrap()
        .query(req("ROWS 3", GraphAccess::Read, 500))
        .await
        .unwrap();
    assert_eq!(ints(&r), [1, 2, 3]);
    assert_eq!(
        server.connections.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the cancelled query's connection came back clean"
    );
}

#[tokio::test]
async fn a_cancel_that_arrives_between_queries_is_forgotten() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    s.cancel_handle().cancel().await.unwrap();
    let r = s
        .as_graph()
        .unwrap()
        .query(req("ROWS 2", GraphAccess::Read, 500))
        .await
        .unwrap();
    assert_eq!(ints(&r), [1, 2]);
}

#[tokio::test]
async fn nodes_carry_their_element_id() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let r = s
        .as_graph()
        .unwrap()
        .query(req("NODE", GraphAccess::Read, 500))
        .await
        .unwrap();
    assert!(matches!(&r.records[0][0], Value::Node { element_id, .. } if element_id == "4:fake:7"));
    assert_eq!(r.nodes[0].properties["name"], Value::text("Brass Lamp"));
}

#[tokio::test]
async fn use_switches_the_database_after_checking_it_exists() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let (sink, mut rx) = ResultSink::channel(8);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let exec = |sql: &str| ExecRequest {
        sql: sql.into(),
        page_size: 10,
        script: false,
        continue_on_error: false,
    };
    s.execute(exec(":use system"), sink.clone()).await.unwrap();
    s.as_graph()
        .unwrap()
        .query(req("ROWS 1", GraphAccess::Read, 10))
        .await
        .unwrap();
    assert!(server.seen().contains(&"BEGIN r system".to_string()));

    let err = s
        .execute(exec(":use missing"), sink.clone())
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::QueryFailed, "{err:?}");
    // still on `system`
    s.as_graph()
        .unwrap()
        .query(req("ROWS 1", GraphAccess::Read, 10))
        .await
        .unwrap();
    let begins: Vec<_> = server
        .seen()
        .into_iter()
        .filter(|l| l.starts_with("BEGIN r"))
        .collect();
    assert_eq!(begins.last().map(String::as_str), Some("BEGIN r system"));
    drop(sink);
    drain.abort();
}

#[tokio::test]
async fn the_table_path_streams_columns_rows_and_done() {
    let server = FakeNeo4j::start().await;
    let mut s = open(&server).await;
    let (sink, mut rx) = ResultSink::channel(32);
    let summary = s
        .execute(
            ExecRequest {
                sql: "ROWS 3".into(),
                page_size: 10,
                script: false,
                continue_on_error: false,
            },
            sink,
        )
        .await
        .unwrap();
    assert!(!summary.has_more);
    let mut kinds = Vec::new();
    while let Ok(e) = rx.try_recv() {
        kinds.push(match e {
            ResultEvent::Columns { columns, .. } => format!("columns {}", columns[0].name),
            ResultEvent::Rows { rows, .. } => format!("rows {}", rows.len()),
            ResultEvent::Done { .. } => "done".into(),
            other => panic!("{other:?}"),
        });
    }
    assert_eq!(kinds, ["columns n", "rows 3", "done"]);
}

#[tokio::test]
async fn neo4j_scheme_asks_for_a_routing_table_first() {
    let server = FakeNeo4j::start().await;
    let mut s = Neo4jDriver::new()
        .open(&cfg(server.port, "neo4j"))
        .await
        .unwrap();
    assert!(server.seen().contains(&"ROUTE".to_string()));
    let r = s
        .as_graph()
        .unwrap()
        .query(req("ROWS 2", GraphAccess::Write, 500))
        .await
        .unwrap();
    assert_eq!(ints(&r), [1, 2]);
    // one server in the table is not a cluster
    assert_eq!(s.server_info().version, "5.26.0");
}

#[tokio::test]
async fn closing_a_session_says_goodbye() {
    let server = FakeNeo4j::start().await;
    let s = open(&server).await;
    s.close().await.unwrap();
}
