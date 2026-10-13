//! Neo4j driver tests. Need `docker compose --profile graph up -d --wait` (Neo4j 5 community,
//! seeded from docker/neo4j/seed.cypher: 5 User, 6 Product, 4 Order, 3 Category nodes).
//! Run with `cargo test --features integration --test neo4j`.
#![cfg(feature = "integration")]

mod conformance;

use std::time::{Duration, Instant};

use clew_lib::drivers::graph::{GraphAccess, GraphMode, GraphRequest, GraphResult};
use clew_lib::drivers::introspect::{NodeKind, NodePath};
use clew_lib::drivers::registry::Registry;
use clew_lib::drivers::{
    DriverError, ErrorCode, ResolvedConfig, Secret, Session, Target, TlsConfig, Value,
};
use clew_lib::safety::guard::{Decision, Policy};
use conformance::{connect, Connected};

const PORT: u16 = 17687;

fn cfg(protocol: &str, read_only: bool) -> ResolvedConfig {
    ResolvedConfig {
        driver: "neo4j".into(),
        target: Target::Network {
            host: "127.0.0.1".into(),
            port: PORT,
        },
        user: Some("neo4j".into()),
        password: Some(Secret::new("clewclew")),
        database: None,
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 10,
        query_timeout_secs: None,
        read_only,
        options: [("neo4j.protocol".to_string(), protocol.to_string())].into(),
        on_connect: vec![],
        isolation: None,
    }
}

fn request(cypher: &str, access: GraphAccess) -> GraphRequest {
    GraphRequest {
        cypher: cypher.into(),
        params: serde_json::Map::new(),
        access,
        mode: GraphMode::Run,
        fetch_size: 500,
    }
}

fn with_params(cypher: &str, access: GraphAccess, params: serde_json::Value) -> GraphRequest {
    GraphRequest {
        params: params.as_object().unwrap().clone(),
        ..request(cypher, access)
    }
}

impl Connected {
    async fn read(&self, cypher: &str) -> GraphResult {
        self.mgr
            .graph_query(&self.session, request(cypher, GraphAccess::Read), None)
            .await
            .unwrap_or_else(|e| panic!("{cypher}: {e:?}"))
    }

    async fn write(&self, cypher: &str) -> GraphResult {
        self.mgr
            .graph_query(&self.session, request(cypher, GraphAccess::Write), None)
            .await
            .unwrap_or_else(|e| panic!("{cypher}: {e:?}"))
    }

    async fn fails(&self, req: GraphRequest) -> DriverError {
        self.mgr
            .graph_query(&self.session, req, None)
            .await
            .expect_err("the query should fail")
    }
}

async fn open() -> Connected {
    connect(&cfg("bolt", false)).await
}

/// The seed's nodes only: other tests create and delete temporary ones while this runs.
const SEED_NODES: &str =
    "MATCH (n) WHERE any(l IN labels(n) WHERE l IN ['User', 'Product', 'Order', 'Category'])";

fn int(v: &Value) -> i64 {
    conformance::int(v)
}

fn text(v: &Value) -> String {
    conformance::text(v)
}

fn count_of(r: &GraphResult) -> i64 {
    int(&r.records[0][0])
}

#[tokio::test]
async fn test_connection_reports_the_server_and_a_wrong_password_is_auth_failed() {
    let mgr = conformance::manager();
    let info = mgr.test_connection(&cfg("bolt", false)).await.unwrap();
    assert_eq!(info.product, "Neo4j");
    assert!(info.version.starts_with('5'), "{info:?}");

    let mut wrong = cfg("bolt", false);
    wrong.password = Some(Secret::new("not-the-password"));
    let err = mgr.test_connection(&wrong).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed, "{err:?}");
    assert!(!err.message.contains("not-the-password"));

    let mut closed = cfg("bolt", false);
    closed.target = Target::Network {
        host: "127.0.0.1".into(),
        port: 1,
    };
    assert_eq!(
        mgr.test_connection(&closed).await.unwrap_err().code,
        ErrorCode::ConnectionLost
    );
}

/// (cluster routing for neo4j:// schemes is checked in the fake-server tests)
#[tokio::test]
async fn neo4j_scheme_routes_through_the_routing_table() {
    let c = connect(&cfg("neo4j", false)).await;
    let r = c.read("MATCH (u:User) RETURN count(u) AS n").await;
    assert_eq!(count_of(&r), 5);
    // a write goes to the writer from the same table
    let r = c
        .write("CREATE (n:CwRouted) WITH n DELETE n RETURN 1 AS ok")
        .await;
    assert_eq!(r.summary.counters.get("nodes-created"), Some(&1));
    let info = c.mgr.server_info(&c.session).unwrap();
    assert!(
        !info.version.contains("cluster"),
        "one server is not a cluster"
    );
}

/// (spec: driver-framework › Graph session contract › Records with graph values)
#[tokio::test]
async fn records_carry_graph_values_and_the_result_dedupes_elements() {
    let c = open().await;
    let r = c
        .read(
            "MATCH (u:User {id: 1})-[b:BOUGHT]->(p:Product) \
             RETURN u, b, p ORDER BY p.name",
        )
        .await;
    assert_eq!(r.columns, ["u", "b", "p"]);
    assert_eq!(r.records.len(), 4);
    assert!(!r.has_more && r.cursor_id.is_none());

    let Value::Node {
        labels, properties, ..
    } = &r.records[0][0]
    else {
        panic!("{:?}", r.records[0][0])
    };
    assert_eq!(labels, &["User"]);
    assert_eq!(text(&properties["name"]), "Ada Lovelace");
    assert!(matches!(r.records[0][1], Value::Relationship { .. }));
    let Value::Node { properties, .. } = &r.records[0][2] else {
        panic!()
    };
    assert_eq!(text(&properties["name"]), "Brass Lamp");

    // one user, four products and four relationships: each exactly once
    assert_eq!(r.nodes.len(), 5);
    assert_eq!(r.relationships.len(), 4);
    let user = r.nodes.iter().find(|n| n.labels == ["User"]).unwrap();
    for rel in &r.relationships {
        assert_eq!(rel.rel_type, "BOUGHT");
        assert_eq!(rel.start_id, user.element_id);
        assert!(r.nodes.iter().any(|n| n.element_id == rel.end_id));
    }
    // Neo4j 5 element ids are strings like 4:<uuid>:<n>
    assert!(user.element_id.contains(':'), "{}", user.element_id);
}

#[tokio::test]
async fn paths_list_their_nodes_and_relationships_in_walk_order() {
    let c = open().await;
    let r = c
        .read("MATCH p = (u:User {id: 1})-[:PLACED]->(o:Order {id: 'O-1001'}) RETURN p")
        .await;
    let Value::Path {
        nodes,
        relationships,
    } = &r.records[0][0]
    else {
        panic!()
    };
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0].labels, ["User"]);
    assert_eq!(relationships.len(), 1);
    assert_eq!(relationships[0].start_id, nodes[0].element_id);
    assert_eq!(relationships[0].end_id, nodes[1].element_id);
    assert_eq!(r.nodes.len(), 2);
    assert_eq!(r.relationships.len(), 1);
}

/// (spec: driver-framework › Graph session contract › Paging records)
#[tokio::test]
async fn records_page_with_has_more_and_fetch_more() {
    let c = open().await;
    let mut req = request("UNWIND range(1, 1200) AS n RETURN n", GraphAccess::Read);
    req.fetch_size = 500;
    let first = c.mgr.graph_query(&c.session, req, None).await.unwrap();
    assert!(first.has_more);
    assert_eq!(first.records.len(), 500);
    let cursor = first.cursor_id.clone().expect("a cursor while more waits");
    assert_eq!(int(&first.records[0][0]), 1);

    let second = c.mgr.graph_fetch_more(&c.session, &cursor).await.unwrap();
    assert!(second.has_more);
    assert_eq!(second.records.len(), 500);
    assert_eq!(int(&second.records[0][0]), 501);
    assert_eq!(second.cursor_id.as_deref(), Some(cursor.as_str()));

    let last = c.mgr.graph_fetch_more(&c.session, &cursor).await.unwrap();
    assert!(!last.has_more && last.cursor_id.is_none());
    assert_eq!(last.records.len(), 200);
    assert_eq!(int(&last.records[199][0]), 1200);

    // read to the end: the cursor is gone, the session is fine
    assert!(c.mgr.graph_fetch_more(&c.session, &cursor).await.is_err());
    assert_eq!(count_of(&c.read("RETURN 1 AS one").await), 1);
}

#[tokio::test]
async fn a_new_query_abandons_an_open_result() {
    let c = open().await;
    let mut req = request("UNWIND range(1, 5000) AS n RETURN n", GraphAccess::Read);
    req.fetch_size = 100;
    let first = c.mgr.graph_query(&c.session, req, None).await.unwrap();
    let cursor = first.cursor_id.unwrap();
    assert_eq!(count_of(&c.read("RETURN 42 AS answer").await), 42);
    let err = c
        .mgr
        .graph_fetch_more(&c.session, &cursor)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::QueryFailed);
}

#[tokio::test]
async fn graph_results_stream_nodes_per_batch() {
    let c = open().await;
    let mut req = request(
        &format!("{SEED_NODES} RETURN n ORDER BY elementId(n)"),
        GraphAccess::Read,
    );
    req.fetch_size = 10;
    let first = c.mgr.graph_query(&c.session, req, None).await.unwrap();
    assert_eq!(first.records.len(), 10);
    assert_eq!(first.nodes.len(), 10);
    let second = c
        .mgr
        .graph_fetch_more(&c.session, first.cursor_id.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(second.records.len(), 8, "18 nodes in the seed");
    assert_eq!(second.nodes.len(), 8, "only the new nodes");
    assert!(!second.has_more);
}

#[tokio::test]
async fn cancel_interrupts_a_running_query_and_the_session_stays_usable() {
    let c = open().await;
    let mgr = c.mgr.clone();
    let sid = c.session.clone();
    let running = tokio::spawn(async move {
        mgr.graph_query(
            &sid,
            request(
                "UNWIND range(1, 2000000000) AS x WITH x WHERE x % 7 = 0 RETURN count(*) AS c",
                GraphAccess::Read,
            ),
            None,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(700)).await;
    let started = Instant::now();
    c.mgr.cancel(&c.session).await.unwrap();
    let err = running.await.unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
    // the same session runs the next statement
    let started = Instant::now();
    assert_eq!(count_of(&c.read("RETURN 7 AS seven").await), 7);
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// (spec: driver-framework › Neo4j driver › Read-only access mode)
#[tokio::test]
async fn read_only_sessions_refuse_writes_and_the_server_backs_the_guard_up() {
    let c = connect(&cfg("bolt", true)).await;
    let before = count_of(&c.read(&format!("{SEED_NODES} RETURN count(n) AS n")).await);

    // the guard blocks it before it is sent
    let err = c
        .mgr
        .graph_query(
            &c.session,
            request("CREATE (n:CwNever)", GraphAccess::Write),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ReadOnly);
    let report = c
        .mgr
        .safety_check(&c.session, "CREATE (n:CwNever)", false)
        .await
        .unwrap();
    assert_eq!(report.decision, Decision::Block);

    // reads run, and ask for write access anyway: the session runs them in READ mode
    let r = c
        .mgr
        .graph_query(
            &c.session,
            request(
                &format!("{SEED_NODES} RETURN count(n) AS n"),
                GraphAccess::Write,
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(count_of(&r), before);

    // a writable session that asks for READ access: the guard allows the text, the server's READ
    // transaction rejects it
    let w = open().await;
    let err = w
        .mgr
        .graph_query(
            &w.session,
            request("CREATE (n:CwNever)", GraphAccess::Read),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ReadOnly, "{err:?}");
    assert_eq!(
        count_of(&w.read("MATCH (n:CwNever) RETURN count(n) AS n").await),
        0
    );

    // switching the session to read-write lifts it
    c.mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap();
    let r = c
        .write("CREATE (n:CwSwitched) WITH n DELETE n RETURN 1 AS ok")
        .await;
    assert_eq!(r.summary.counters.get("nodes-created"), Some(&1));
}

/// (spec: driver-framework › Neo4j driver › Large integers)
#[tokio::test]
async fn integers_beyond_javascript_stay_exact() {
    let c = open().await;
    let r = c
        .read("MATCH (o:Order {id: 'O-1001'}) RETURN o.reference AS r, o")
        .await;
    assert_eq!(
        r.records[0][0],
        Value::Bigint {
            value: "9007199254740993".into()
        }
    );
    let Value::Node { properties, .. } = &r.records[0][1] else {
        panic!()
    };
    assert_eq!(
        properties["reference"],
        Value::Bigint {
            value: "9007199254740993".into()
        }
    );
    assert_eq!(
        serde_json::to_value(&r.records[0][0]).unwrap(),
        serde_json::json!({"kind": "bigint", "value": "9007199254740993"})
    );
    // a parameter round trip; the frontend sends such integers as {kind, value}
    let r = c
        .mgr
        .graph_query(
            &c.session,
            with_params(
                "RETURN $big AS big, $big + 1 AS next, $small AS small",
                GraphAccess::Read,
                serde_json::json!({"big": {"kind": "bigint", "value": "9007199254740993"}, "small": 5}),
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        r.records[0][0],
        Value::Bigint {
            value: "9007199254740993".into()
        }
    );
    assert_eq!(
        r.records[0][1],
        Value::Bigint {
            value: "9007199254740994".into()
        }
    );
    assert_eq!(r.records[0][2], Value::Int { value: 5 });
    // inside a map they are strings too
    let r = c.read("RETURN {big: 9007199254740993} AS m").await;
    let Value::Json { value } = &r.records[0][0] else {
        panic!()
    };
    assert_eq!(value["big"], "9007199254740993");
}

#[tokio::test]
async fn temporal_spatial_and_collection_types_convert() {
    let c = open().await;
    let r = c
        .read(
            "RETURN date('2025-03-02') AS d, localtime('10:30:15.5') AS lt, \
             time('10:30:00+01:00') AS t, localdatetime('2025-03-02T10:00:00') AS ldt, \
             datetime('2025-03-02T10:00:00+01:00') AS dt, \
             datetime({year: 2025, month: 7, day: 1, hour: 10, timezone: 'Europe/Paris'}) AS zdt, \
             duration('P1Y2M3DT4H5M6.5S') AS du, point({x: 1.5, y: 2}) AS p, \
             [1, 'a', null] AS l, {a: 1, b: [true]} AS m, 1.5 AS f, null AS n, true AS b",
        )
        .await;
    let row = &r.records[0];
    assert_eq!(
        row[0],
        Value::Date {
            value: "2025-03-02".into()
        }
    );
    assert_eq!(
        row[1],
        Value::Time {
            value: "10:30:15.5".into()
        }
    );
    assert_eq!(
        row[2],
        Value::Time {
            value: "10:30:00+01:00".into()
        }
    );
    assert_eq!(
        row[3],
        Value::Timestamp {
            value: "2025-03-02T10:00:00".into()
        }
    );
    assert_eq!(
        row[4],
        Value::Timestamptz {
            value: "2025-03-02T10:00:00+01:00".into()
        }
    );
    assert_eq!(
        row[5],
        Value::Timestamptz {
            value: "2025-07-01T10:00:00+02:00".into()
        }
    );
    assert_eq!(
        row[6],
        Value::Interval {
            value: "P1Y2M3DT4H5M6.5S".into()
        }
    );
    let Value::Other { value, type_name } = &row[7] else {
        panic!("{:?}", row[7])
    };
    assert_eq!(type_name, "Point");
    assert!(
        value.contains("x: 1.5") && value.contains("y: 2"),
        "{value}"
    );
    assert!(matches!(&row[8], Value::Array { value } if value.len() == 3));
    assert_eq!(
        serde_json::to_value(&row[9]).unwrap()["value"],
        serde_json::json!({"a": 1, "b": [true]})
    );
    assert_eq!(row[10], Value::Float { value: 1.5 });
    assert_eq!(row[11], Value::Null);
    assert_eq!(row[12], Value::Bool { value: true });
}

#[tokio::test]
async fn a_syntax_error_reports_its_position() {
    let c = open().await;
    let err = c
        .fails(request("MATCH (n) RETRUN n", GraphAccess::Read))
        .await;
    assert_eq!(err.code, ErrorCode::QueryFailed);
    assert!(
        err.message.to_lowercase().contains("invalid input"),
        "{err:?}"
    );
    assert_eq!(err.position, Some(11), "1-based offset of RETRUN");
    // the session survives the failure
    assert_eq!(count_of(&c.read("RETURN 1 AS one").await), 1);
}

/// (schema introspection of the graph session contract)
#[tokio::test]
async fn schema_lists_labels_types_keys_indexes_and_constraints() {
    let c = open().await;
    let schema = c.mgr.graph_schema("conf", None).await.unwrap();
    let count = |items: &[clew_lib::drivers::graph::GraphCount], name: &str| {
        items
            .iter()
            .find(|i| i.name == name)
            .unwrap_or_else(|| panic!("{name} in {items:?}"))
            .count
    };
    assert_eq!(count(&schema.labels, "User"), 5);
    assert_eq!(count(&schema.labels, "Product"), 6);
    assert_eq!(count(&schema.labels, "Order"), 4);
    assert_eq!(count(&schema.labels, "Category"), 3);
    assert_eq!(count(&schema.relationship_types, "BOUGHT"), 8);
    assert_eq!(count(&schema.relationship_types, "IN_CATEGORY"), 6);
    assert!(schema.property_keys.contains(&"name".to_string()));
    assert!(schema.property_keys.contains(&"reference".to_string()));
    let index = schema
        .indexes
        .iter()
        .find(|i| i.name == "product_name")
        .expect("product_name index");
    assert_eq!(index.labels, ["Product"]);
    assert_eq!(index.properties, ["name"]);
    assert_eq!(index.state.as_deref(), Some("ONLINE"));
    let constraint = schema
        .constraints
        .iter()
        .find(|i| i.name == "user_id")
        .expect("user_id constraint");
    assert_eq!(constraint.kind, "UNIQUENESS");
    assert_eq!(constraint.properties, ["id"]);
    assert!(schema
        .functions
        .as_ref()
        .is_some_and(|f| f.iter().any(|n| n == "count")));
    assert!(schema
        .procedures
        .as_ref()
        .is_some_and(|p| p.iter().any(|n| n == "db.labels")));

    let dbs = c.mgr.graph_databases("conf").await.unwrap();
    assert_eq!(dbs, ["neo4j", "system"]);
    // an explicit database
    let again = c.mgr.graph_schema("conf", Some("neo4j")).await.unwrap();
    assert_eq!(count(&again.labels, "User"), 5);
}

#[tokio::test]
async fn the_explorer_tree_and_completion_snapshot() {
    let c = open().await;
    let root = c.mgr.introspect("conf", &NodePath::root()).await.unwrap();
    assert_eq!(
        root.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
        ["neo4j", "system"]
    );
    assert!(root.iter().all(|n| n.kind == NodeKind::Database));
    let db = &root[0].path;
    let groups = c.mgr.introspect("conf", db).await.unwrap();
    assert_eq!(
        groups.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
        ["Node labels", "Relationship types", "Indexes"]
    );
    let labels = c.mgr.introspect("conf", &groups[0].path).await.unwrap();
    let user = labels.iter().find(|n| n.name == "User").unwrap();
    assert_eq!(
        (user.kind, user.detail.as_deref()),
        (NodeKind::Table, Some("5"))
    );
    let types = c.mgr.introspect("conf", &groups[1].path).await.unwrap();
    let bought = types.iter().find(|n| n.name == "BOUGHT").unwrap();
    assert_eq!(
        (bought.kind, bought.detail.as_deref()),
        (NodeKind::Type, Some("8"))
    );
    let indexes = c.mgr.introspect("conf", &groups[2].path).await.unwrap();
    assert!(indexes
        .iter()
        .any(|n| n.name == "product_name" && n.kind == NodeKind::Index));

    let snap = c.mgr.completion_snapshot("conf", "neo4j").await.unwrap();
    assert!(snap.schemas[0].tables.iter().any(|t| t.name == "Product"));
    assert!(snap.schemas[0].functions.iter().any(|f| f == "db.labels"));
    let graph = snap.graph.expect("graph schema in the snapshot");
    assert!(graph.relationship_types.iter().any(|t| t.name == "FOLLOWS"));
    assert!(graph.property_keys.iter().any(|k| k == "sku"));
}

/// (spec: graph-browser › Graph view › Expand neighbours)
#[tokio::test]
async fn expanding_a_node_returns_its_neighbours_in_a_read_transaction() {
    let c = open().await;
    let r = c
        .read("MATCH (p:Product {name: 'Brass Lamp'}) RETURN p")
        .await;
    let Value::Node { element_id, .. } = &r.records[0][0] else {
        panic!()
    };
    let expanded = c
        .mgr
        .graph_expand(&c.session, element_id, 25)
        .await
        .unwrap();
    // Ada and Grace bought it, two orders contain it, it is in the Lighting category
    assert_eq!(expanded.columns, ["r", "m"]);
    assert_eq!(expanded.records.len(), 5);
    assert_eq!(expanded.relationships.len(), 5);
    assert!(expanded.nodes.iter().any(|n| n.labels == ["Category"]));
    assert!(expanded.nodes.iter().any(|n| n
        .properties
        .get("name")
        .is_some_and(|v| text(v) == "Ada Lovelace")));
    assert!(expanded.nodes.iter().all(|n| &n.element_id != element_id));

    let limited = c.mgr.graph_expand(&c.session, element_id, 2).await.unwrap();
    assert_eq!(limited.records.len(), 2);

    // read-only or not, expanding never writes
    let ro = connect(&cfg("bolt", true)).await;
    assert_eq!(
        ro.mgr
            .graph_expand(&ro.session, element_id, 25)
            .await
            .unwrap()
            .records
            .len(),
        5
    );
}

/// (spec: graph-browser › Table, JSON and Plan views › Profile)
#[tokio::test]
async fn explain_and_profile_return_plans() {
    let c = open().await;
    let mut explain = request("MATCH (u:User) RETURN u.name", GraphAccess::Read);
    explain.mode = GraphMode::Explain;
    let r = c.mgr.graph_query(&c.session, explain, None).await.unwrap();
    assert!(r.records.is_empty());
    let plan = r.plan.expect("an EXPLAIN plan");
    assert_eq!(plan.operator, "ProduceResults");
    assert!(plan.estimated_rows.is_some());
    assert!(plan.db_hits.is_none() && plan.rows.is_none());
    assert!(!plan.children.is_empty());

    let mut profile = request(
        "MATCH (u:User)-[:BOUGHT]->(p:Product) RETURN u.name, p.name",
        GraphAccess::Read,
    );
    profile.mode = GraphMode::Profile;
    let r = c.mgr.graph_query(&c.session, profile, None).await.unwrap();
    assert_eq!(r.records.len(), 8, "PROFILE still returns the rows");
    let plan = r.plan.expect("a PROFILE plan");
    assert_eq!(plan.rows, Some(8));
    fn max_hits(n: &clew_lib::drivers::graph::PlanNode) -> i64 {
        n.children
            .iter()
            .map(max_hits)
            .chain(n.db_hits)
            .max()
            .unwrap_or(0)
    }
    assert!(max_hits(&plan) > 0, "{plan:?}");

    // EXPLAIN of a write runs nothing and is not a write
    let c2 = connect(&cfg("bolt", true)).await;
    let mut explain_write = request("MATCH (n) DETACH DELETE n", GraphAccess::Read);
    explain_write.mode = GraphMode::Explain;
    let r = c2
        .mgr
        .graph_query(&c2.session, explain_write, None)
        .await
        .unwrap();
    assert!(r.plan.is_some());
    assert_eq!(
        count_of(&c.read(&format!("{SEED_NODES} RETURN count(n) AS n")).await),
        18
    );
}

#[tokio::test]
async fn writes_report_counters_and_property_edits_are_parameterised() {
    let c = open().await;
    let r = c
        .mgr
        .graph_query(
            &c.session,
            with_params(
                "CREATE (n:CwEdit {name: $name, plan: 'free'}) RETURN n",
                GraphAccess::Write,
                serde_json::json!({"name": "Temp"}),
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(r.summary.counters.get("nodes-created"), Some(&1));
    assert_eq!(r.summary.counters.get("properties-set"), Some(&2));
    let Value::Node { element_id, .. } = &r.records[0][0] else {
        panic!()
    };
    let id = element_id.clone();

    // edit: change one property, add one, remove one
    let props = serde_json::json!({"plan": "pro", "seats": 3, "name": null});
    let updated = c
        .mgr
        .graph_update_properties(
            &c.session,
            &id,
            "node",
            props.as_object().unwrap().clone(),
            None,
        )
        .await
        .unwrap();
    let Value::Node { properties, .. } = &updated.records[0][0] else {
        panic!()
    };
    assert_eq!(text(&properties["plan"]), "pro");
    assert_eq!(int(&properties["seats"]), 3);
    assert!(!properties.contains_key("name"));

    // a property value that looks like Cypher is just a value
    let evil = serde_json::json!({"plan": "x' }) DETACH DELETE (n) //"});
    c.mgr
        .graph_update_properties(
            &c.session,
            &id,
            "node",
            evil.as_object().unwrap().clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        count_of(&c.read("MATCH (n:CwEdit) RETURN count(n) AS n").await),
        1
    );

    // relationships
    let r = c
        .write(
            "MATCH (a:User {id: 1}), (b:User {id: 2}) \
             CREATE (a)-[r:CW_TEMP {w: 1}]->(b) RETURN r",
        )
        .await;
    let Value::Relationship {
        element_id: rid, ..
    } = &r.records[0][0]
    else {
        panic!()
    };
    let updated = c
        .mgr
        .graph_update_properties(
            &c.session,
            rid,
            "relationship",
            serde_json::json!({"w": 2}).as_object().unwrap().clone(),
            None,
        )
        .await
        .unwrap();
    let Value::Relationship { properties, .. } = &updated.records[0][0] else {
        panic!()
    };
    assert_eq!(int(&properties["w"]), 2);

    // read-only sessions refuse edits
    c.mgr.set_session_read_only(&c.session, true).await.unwrap();
    let err = c
        .mgr
        .graph_update_properties(
            &c.session,
            &id,
            "node",
            serde_json::json!({"plan": "free"})
                .as_object()
                .unwrap()
                .clone(),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ReadOnly);
    c.mgr
        .set_session_read_only(&c.session, false)
        .await
        .unwrap();

    c.write("MATCH (n:CwEdit) DETACH DELETE n").await;
    c.write("MATCH ()-[r:CW_TEMP]->() DELETE r").await;
}

/// A write that streams more rows than one batch is committed whole and still pages.
#[tokio::test]
async fn a_write_with_many_rows_commits_and_pages_what_it_returns() {
    let c = open().await;
    let mut req = request(
        "UNWIND range(1, 1200) AS i CREATE (n:CwBulk {i: i}) RETURN n.i AS i",
        GraphAccess::Write,
    );
    req.fetch_size = 500;
    let first = c.mgr.graph_query(&c.session, req, None).await.unwrap();
    assert_eq!(first.records.len(), 500);
    assert!(first.has_more);
    let cursor = first.cursor_id.unwrap();
    // the rows are all written even though only 500 were read so far
    assert_eq!(
        count_of(&c.read("MATCH (n:CwBulk) RETURN count(n) AS n").await),
        1200
    );
    // (that query abandoned the buffered result; run it again to read the rest)
    assert!(c.mgr.graph_fetch_more(&c.session, &cursor).await.is_err());
    c.write("MATCH (n:CwBulk) DELETE n").await;
}

/// (spec: graph-browser › Cypher safeguards)
#[tokio::test]
async fn the_guard_judges_cypher_like_sql() {
    let c = open().await;
    c.mgr
        .set_policy("conf", Policy::managed("prod-graph", "production", false));
    let before = count_of(&c.read(&format!("{SEED_NODES} RETURN count(n) AS n")).await);

    // read procedure: no question
    let report = c
        .mgr
        .safety_check(&c.session, "CALL db.labels()", false)
        .await
        .unwrap();
    assert_eq!(report.decision, Decision::Allow);

    // unfiltered delete on production: the typed name
    let report = c
        .mgr
        .safety_check(&c.session, "MATCH (n) DETACH DELETE n", false)
        .await
        .unwrap();
    assert_eq!(report.decision, Decision::TypedConfirm);
    assert_eq!(report.typed.as_deref(), Some("prod-graph"));
    let token = report.token.clone().expect("a token to answer with");

    // without the token nothing runs
    let err = c
        .mgr
        .graph_query(
            &c.session,
            request("MATCH (n) DETACH DELETE n", GraphAccess::Write),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ConfirmationRequired);
    // a token for other text does not work either
    let err = c
        .mgr
        .graph_query(
            &c.session,
            request("MATCH (n) DETACH DELETE n // x", GraphAccess::Write),
            Some(token),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ConfirmationRequired);
    assert_eq!(
        count_of(&c.read(&format!("{SEED_NODES} RETURN count(n) AS n")).await),
        before,
        "nothing was deleted"
    );

    // a filtered write only needs the policy's confirm-writes (off here)
    let report = c
        .mgr
        .safety_check(&c.session, "MATCH (n:CwNone) DETACH DELETE n", false)
        .await
        .unwrap();
    assert_eq!(report.decision, Decision::Allow);

    // with confirm-writes on, a confirmed write runs once
    c.mgr
        .set_policy("conf", Policy::managed("staging-graph", "staging", true));
    let text = "CREATE (n:CwConfirmed) WITH n DELETE n RETURN 1 AS ok";
    let report = c.mgr.safety_check(&c.session, text, false).await.unwrap();
    assert_eq!(report.decision, Decision::Confirm);
    let token = report.token.unwrap();
    c.mgr
        .graph_query(
            &c.session,
            request(text, GraphAccess::Write),
            Some(token.clone()),
        )
        .await
        .unwrap();
    let again = c
        .mgr
        .graph_query(&c.session, request(text, GraphAccess::Write), Some(token))
        .await
        .unwrap_err();
    assert_eq!(
        again.code,
        ErrorCode::ConfirmationRequired,
        "tokens work once"
    );

    // property edits ask too
    let report = c
        .mgr
        .graph_update_safety_check(&c.session, "node")
        .await
        .unwrap();
    assert_eq!(report.decision, Decision::Confirm);
}

#[tokio::test]
async fn switching_database_keeps_the_session_working() {
    let c = open().await;
    let sql = c
        .mgr
        .switch_namespace(&c.session, Some("neo4j"), None)
        .await
        .unwrap();
    assert_eq!(sql, ":use neo4j");
    assert_eq!(
        count_of(&c.read("MATCH (u:User) RETURN count(u) AS n").await),
        5
    );
    // the system database has no user data
    c.mgr
        .switch_namespace(&c.session, Some("system"), None)
        .await
        .unwrap();
    let r = c.read("SHOW DATABASES YIELD name RETURN name").await;
    assert!(r.records.len() >= 2);
    assert_eq!(r.summary.database, "system");
    // an unknown database is refused and the session stays where it was
    let err = c
        .mgr
        .switch_namespace(&c.session, Some("nonexistent"), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::QueryFailed, "{err:?}");
    assert!(
        c.read("SHOW DATABASES YIELD name RETURN name")
            .await
            .records
            .len()
            >= 2
    );
    c.mgr
        .switch_namespace(&c.session, Some("neo4j"), None)
        .await
        .unwrap();
    assert_eq!(
        count_of(&c.read("MATCH (u:User) RETURN count(u) AS n").await),
        5
    );
}

/// Table-style execution (the console's generic statement path) works too.
#[tokio::test]
async fn the_generic_execute_path_returns_table_rows() {
    let c = open().await;
    let r = conformance::run_page(
        &c.mgr,
        &c.session,
        "UNWIND range(1, 25) AS n RETURN n, 'x' AS s",
        10,
    )
    .await;
    let summary = r.ok();
    assert!(summary.has_more);
    assert_eq!(
        r.columns()
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["n", "s"]
    );
    assert_eq!(r.rows().len(), 10);
    let id = r.result_id();
    let (emit, log) = conformance::collector();
    let more = c.mgr.fetch_more(&c.session, id, 10, emit).await.unwrap();
    assert!(more);
    assert_eq!(log.lock().unwrap().len(), 2, "rows then done");
}

#[tokio::test]
async fn statements_show_in_the_sessions_panel_while_they_run() {
    let c = open().await;
    let mgr = c.mgr.clone();
    let sid = c.session.clone();
    let running = tokio::spawn(async move {
        mgr.graph_query(
            &sid,
            request(
                "UNWIND range(1, 2000000000) AS x WITH x WHERE x % 7 = 0 RETURN count(*) AS c",
                GraphAccess::Read,
            ),
            None,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let meta = c
        .mgr
        .sessions_list()
        .into_iter()
        .find(|m| m.id == c.session)
        .unwrap();
    assert!(meta
        .running_statement
        .as_deref()
        .is_some_and(|s| s.starts_with("UNWIND range")));
    c.mgr.cancel(&c.session).await.unwrap();
    let _ = running.await;
}

#[tokio::test]
async fn open_returns_a_session_that_closes_cleanly() {
    let mut s: Box<dyn Session> = Registry::with_defaults()
        .get("neo4j")
        .unwrap()
        .open(&cfg("bolt", false))
        .await
        .unwrap();
    assert!(s.as_graph().is_some());
    assert!(s.is_alive());
    s.close().await.unwrap();
}
