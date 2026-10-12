//! MongoDB driver tests. Need `docker compose up -d --wait mongo`.
//! Run with `cargo test --features integration`.
#![cfg(feature = "integration")]

mod conformance;

use std::time::{Duration, Instant};

use clew_lib::safety::guard::{Decision, Policy};
use conformance::{collector, connect, run_page, run_script};

use clew_lib::drivers::introspect::{NodeKind, NodePath};
use clew_lib::drivers::nosql::{DocReply, DocRequest, ExportFormat, FieldCheck};
use clew_lib::drivers::registry::Registry;
use clew_lib::drivers::{
    ErrorCode, ResolvedConfig, ResultEvent, ResultSink, Session, Target, TlsConfig,
};
use serde_json::{json, Value};

const URI: &str = "mongodb://127.0.0.1:27117/?directConnection=true";

fn cfg(read_only: bool) -> ResolvedConfig {
    ResolvedConfig {
        driver: "mongodb".into(),
        target: Target::Uri { uri: URI.into() },
        user: None,
        password: None,
        database: None,
        ssh: None,
        tls: TlsConfig::default(),
        connect_timeout_secs: 5,
        query_timeout_secs: None,
        read_only,
        options: Default::default(),
        on_connect: vec![],
    }
}

async fn open(read_only: bool) -> Box<dyn Session> {
    let driver = Registry::with_defaults().get("mongodb").unwrap();
    driver.open(&cfg(read_only)).await.unwrap()
}

/// Fresh database per test.
async fn fresh(name: &str) -> (Box<dyn Session>, String) {
    let mut s = open(false).await;
    let db = format!("clew_test_{name}");
    s.as_documents()
        .unwrap()
        .call(
            DocRequest::Shell {
                database: db.clone(),
                text: "db.items.drop()".into(),
                page_size: 10,
            },
            ResultSink::channel(8).0,
        )
        .await
        .unwrap();
    (s, db)
}

async fn call(s: &mut Box<dyn Session>, r: DocRequest) -> (DocReply, Vec<Value>) {
    let (sink, mut rx) = ResultSink::channel(256);
    let reply = s.as_documents().unwrap().call(r, sink).await.unwrap();
    (reply, drain(&mut rx))
}

async fn call_err(s: &mut Box<dyn Session>, r: DocRequest) -> clew_lib::drivers::DriverError {
    let (sink, _rx) = ResultSink::channel(256);
    s.as_documents().unwrap().call(r, sink).await.unwrap_err()
}

fn drain(rx: &mut tokio::sync::mpsc::Receiver<ResultEvent>) -> Vec<Value> {
    let mut docs = vec![];
    while let Ok(ev) = rx.try_recv() {
        if let ResultEvent::Documents { docs: d, .. } = ev {
            docs.extend(d);
        }
    }
    docs
}

fn num(n: i64) -> Value {
    json!({"$numberInt": n.to_string()})
}

async fn seed(s: &mut Box<dyn Session>, db: &str, n: i64) {
    let documents = (1..=n)
        .map(|i| json!({"_id": num(i), "name": format!("item{i}"), "qty": num(i % 7), "tags": ["a", "b"]}))
        .collect();
    call(
        s,
        DocRequest::Insert {
            database: db.into(),
            collection: "items".into(),
            documents,
        },
    )
    .await;
}

fn find(db: &str, filter: &str, sort: &str, limit: u64, page: usize) -> DocRequest {
    DocRequest::Find {
        database: db.into(),
        collection: "items".into(),
        filter: filter.into(),
        projection: "".into(),
        sort: sort.into(),
        skip: 0,
        limit,
        page_size: page,
    }
}

fn shell(db: &str, text: &str) -> DocRequest {
    DocRequest::Shell {
        database: db.into(),
        text: text.into(),
        page_size: 50,
    }
}

/// (spec: driver-framework › Server version in status)
#[tokio::test]
async fn test_connection_reports_the_replica_set() {
    let driver = Registry::with_defaults().get("mongodb").unwrap();
    let info = driver.test(&cfg(false)).await.unwrap();
    assert_eq!(info.product, "MongoDB");
    assert!(info.version.contains("replica set rs0"), "{info:?}");
}

#[tokio::test]
async fn bad_host_fails_with_connection_error() {
    let driver = Registry::with_defaults().get("mongodb").unwrap();
    let mut c = cfg(false);
    c.target = Target::Uri {
        uri: "mongodb://127.0.0.1:1/?directConnection=true".into(),
    };
    c.connect_timeout_secs = 1;
    let e = driver.test(&c).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::ConnectionLost, "{e:?}");
}

/// (spec: driver-framework › Cursor paging)
#[tokio::test]
async fn first_page_then_more_sorted_by_id_desc() {
    let (mut s, db) = fresh("paging").await;
    seed(&mut s, &db, 120).await;
    let (reply, docs) = call(&mut s, find(&db, "", "{ _id: -1 }", 0, 50)).await;
    let DocReply::Found {
        result_id,
        has_more,
        ..
    } = reply
    else {
        panic!()
    };
    assert!(has_more);
    assert_eq!(docs.len(), 50);
    assert_eq!(docs[0]["_id"], num(120));
    let (sink, mut rx) = ResultSink::channel(64);
    assert!(s.fetch_more(result_id, 50, sink).await.unwrap());
    assert_eq!(drain(&mut rx).len(), 50);
    let (sink, mut rx) = ResultSink::channel(64);
    assert!(!s.fetch_more(result_id, 50, sink).await.unwrap());
    let last = drain(&mut rx);
    assert_eq!(last.len(), 20);
    assert_eq!(last.last().unwrap()["_id"], num(1));
}

#[tokio::test]
async fn filter_projection_count_and_parse_errors() {
    let (mut s, db) = fresh("filter").await;
    seed(&mut s, &db, 30).await;
    let (_, docs) = call(
        &mut s,
        DocRequest::Find {
            database: db.clone(),
            collection: "items".into(),
            filter: "{ qty: { $gte: 5 }, name: /^item1/ }".into(),
            projection: "{ name: 1, _id: 0 }".into(),
            sort: "{ name: 1 }".into(),
            skip: 0,
            limit: 0,
            page_size: 50,
        },
    )
    .await;
    assert!(!docs.is_empty());
    assert!(docs
        .iter()
        .all(|d| d.get("_id").is_none() && d["name"].as_str().unwrap().starts_with("item1")));
    let (r, _) = call(
        &mut s,
        DocRequest::Count {
            database: db.clone(),
            collection: "items".into(),
            filter: "".into(),
            cap: 10,
        },
    )
    .await;
    let DocReply::Count { count, capped } = r else {
        panic!()
    };
    assert_eq!((count, capped), (10, true));
    let e = call_err(&mut s, find(&db, "{ qty: }", "", 0, 10)).await;
    assert_eq!(e.code, ErrorCode::QueryFailed);
    assert!(e.message.starts_with("Filter:"), "{e:?}");
    assert!(e.position.is_some());
}

#[tokio::test]
async fn explain_reports_index_or_collscan() {
    let (mut s, db) = fresh("explain").await;
    seed(&mut s, &db, 20).await;
    let ex = |filter: &str| DocRequest::Explain {
        database: db.clone(),
        collection: "items".into(),
        filter: filter.into(),
        sort: "".into(),
    };
    let (r, _) = call(&mut s, ex("{ name: 'item3' }")).await;
    let DocReply::Explain { index, collscan } = r else {
        panic!()
    };
    assert!(collscan && index.is_none());
    call(
        &mut s,
        DocRequest::CreateIndex {
            database: db.clone(),
            collection: "items".into(),
            keys: "{ name: 1 }".into(),
            name: Some("name_1".into()),
            unique: true,
            sparse: false,
            ttl_seconds: None,
        },
    )
    .await;
    let (r, _) = call(&mut s, ex("{ name: 'item3' }")).await;
    let DocReply::Explain { index, collscan } = r else {
        panic!()
    };
    assert_eq!(index.as_deref(), Some("name_1"));
    assert!(!collscan);
    let (r, _) = call(
        &mut s,
        DocRequest::Indexes {
            database: db.clone(),
            collection: "items".into(),
        },
    )
    .await;
    let DocReply::Indexes { items } = r else {
        panic!()
    };
    assert!(items.iter().any(|i| i.name == "name_1" && i.unique));
    assert!(items.iter().any(|i| i.name == "_id_"));
    let (r, _) = call(
        &mut s,
        DocRequest::DropIndex {
            database: db.clone(),
            collection: "items".into(),
            name: "name_1".into(),
        },
    )
    .await;
    let DocReply::Indexes { items } = r else {
        panic!()
    };
    assert!(!items.iter().any(|i| i.name == "name_1"));
}

/// (spec: document-browser › Concurrent modification)
#[tokio::test]
async fn edits_detect_a_concurrent_change() {
    let (mut s, db) = fresh("edit").await;
    seed(&mut s, &db, 3).await;
    let id = num(2);
    let update = |value: &str, force: bool, original: &str| DocRequest::Update {
        database: db.clone(),
        collection: "items".into(),
        id: id.clone(),
        set: json!({"name": value}),
        unset: vec!["tags".into()],
        check: vec![FieldCheck {
            path: "name".into(),
            absent: false,
            value: json!(original),
        }],
        force,
    };
    let (r, _) = call(&mut s, update("renamed", false, "item2")).await;
    let DocReply::Written { modified, .. } = r else {
        panic!("{r:?}")
    };
    assert_eq!(modified, 1);
    // someone else changed `name` since we loaded it
    let (r, _) = call(&mut s, update("mine", false, "item2")).await;
    let DocReply::Conflict { current } = r else {
        panic!("{r:?}")
    };
    assert_eq!(current.unwrap()["name"], json!("renamed"));
    // "Overwrite"
    let (r, _) = call(&mut s, update("mine", true, "item2")).await;
    assert!(matches!(r, DocReply::Written { modified: 1, .. }));
    let (_, docs) = call(&mut s, find(&db, "{ _id: 2 }", "", 0, 5)).await;
    assert_eq!(docs[0]["name"], json!("mine"));
    assert!(docs[0].get("tags").is_none());
    // the document vanished
    call(
        &mut s,
        DocRequest::Delete {
            database: db.clone(),
            collection: "items".into(),
            ids: vec![id.clone()],
        },
    )
    .await;
    let (r, _) = call(&mut s, update("again", false, "mine")).await;
    assert!(matches!(r, DocReply::Conflict { current: None }));
}

/// (spec: driver-framework › ObjectId display)
#[tokio::test]
async fn replace_keeps_types() {
    let (mut s, db) = fresh("replace").await;
    seed(&mut s, &db, 1).await;
    let doc = json!({"_id": num(1), "n": {"$numberLong": "5"}, "d": {"$numberDouble": "1.5"}, "when": {"$date": {"$numberLong": "1700000000000"}}});
    let (r, _) = call(
        &mut s,
        DocRequest::Replace {
            database: db.clone(),
            collection: "items".into(),
            id: num(1),
            document: doc.clone(),
            check: vec![],
            force: false,
        },
    )
    .await;
    assert!(matches!(r, DocReply::Written { modified: 1, .. }));
    let (_, docs) = call(&mut s, find(&db, "", "", 0, 5)).await;
    assert_eq!(docs[0], doc);
}

#[tokio::test]
async fn read_only_sessions_refuse_writes() {
    let (mut s, db) = fresh("readonly").await;
    seed(&mut s, &db, 2).await;
    s.set_read_only(true).await.unwrap();
    for r in [
        DocRequest::Delete {
            database: db.clone(),
            collection: "items".into(),
            ids: vec![num(1)],
        },
        DocRequest::Insert {
            database: db.clone(),
            collection: "items".into(),
            documents: vec![json!({"a": 1})],
        },
        shell(&db, "db.items.deleteMany({})"),
        shell(&db, "db.items.aggregate([{ $out: 'copy' }])"),
    ] {
        assert_eq!(call_err(&mut s, r).await.code, ErrorCode::ReadOnly);
    }
    // reads still work
    let (_, docs) = call(&mut s, shell(&db, "db.items.find({})")).await;
    assert_eq!(docs.len(), 2);
}

/// (spec: document-browser › Mixed types)
#[tokio::test]
async fn inferred_schema_from_a_sample() {
    let (mut s, db) = fresh("schema").await;
    call(
        &mut s,
        DocRequest::Insert {
            database: db.clone(),
            collection: "items".into(),
            documents: vec![
                json!({"_id": num(1), "a": "x", "o": {"k": num(1)}}),
                json!({"_id": num(2), "a": num(5)}),
                json!({"_id": num(3), "a": "y"}),
                json!({"_id": num(4), "a": "z"}),
            ],
        },
    )
    .await;
    let (r, _) = call(
        &mut s,
        DocRequest::Schema {
            database: db.clone(),
            collection: "items".into(),
            filter: "".into(),
            sample: 1000,
        },
    )
    .await;
    let DocReply::Schema { sampled, fields } = r else {
        panic!()
    };
    assert_eq!(sampled, 4);
    let a = fields.iter().find(|f| f.path == "a").unwrap();
    assert_eq!(
        (a.types[0].type_name.as_str(), a.types[0].percent),
        ("string", 75.0)
    );
    let k = fields.iter().find(|f| f.path == "o.k").unwrap();
    assert_eq!(k.present_percent, 25.0);
}

/// (spec: document-browser › Aggregate)
#[tokio::test]
async fn the_shell_runs_collection_commands() {
    let (mut s, db) = fresh("shell").await;
    seed(&mut s, &db, 10).await;
    let (_, docs) = call(
        &mut s,
        shell(
            &db,
            "db.items.find({ qty: { $gte: 3 } }, { name: 1 }).sort({ _id: -1 }).limit(3)",
        ),
    )
    .await;
    assert_eq!(docs.len(), 3);
    assert!(docs[0]["_id"].as_object().is_some());
    let (r, _) = call(&mut s, shell(&db, "db.items.countDocuments({})")).await;
    assert!(matches!(r, DocReply::Value { value } if value == json!({"$numberLong": "10"})));
    let (r, _) = call(
        &mut s,
        shell(&db, "db.items.insertOne({ _id: 99, name: 'x' })"),
    )
    .await;
    assert!(matches!(r, DocReply::Value { .. }));
    let (r, _) = call(
        &mut s,
        shell(
            &db,
            "db.items.updateMany({ qty: 0 }, { $set: { zero: true } })",
        ),
    )
    .await;
    let DocReply::Value { value } = r else {
        panic!()
    };
    assert!(value["matchedCount"].as_u64().unwrap() >= 1);
    let (r, _) = call(&mut s, shell(&db, "db.items.distinct('qty')")).await;
    assert!(
        matches!(r, DocReply::Value { value } if value.get("$numberInt").is_none() && value.is_array())
    );
    let (_, names) = call(&mut s, shell(&db, "show collections")).await;
    assert!(names.iter().any(|d| d["name"] == json!("items")));
    let (_, docs) = call(
        &mut s,
        shell(&db, "db.items.aggregate([{ $group: { _id: '$qty', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])"),
    )
    .await;
    // qty 0..=6, plus the inserted document that has none
    assert_eq!(docs.len(), 8);
    let (r, _) = call(&mut s, shell(&db, "use other")).await;
    assert!(matches!(r, DocReply::Found { database: Some(d), .. } if d == "other"));
}

#[tokio::test]
async fn shell_text_evaluates_to_canonical_json() {
    let (mut s, _db) = fresh("evaluate").await;
    let (r, _) = call(
        &mut s,
        DocRequest::Evaluate {
            text: "{ _id: ObjectId('6703f1c2a9e41d7c2e0fb812'), n: NumberLong(5), d: ISODate('2026-10-01') }".into(),
        },
    )
    .await;
    let DocReply::Value { value } = r else {
        panic!()
    };
    assert_eq!(value["_id"], json!({"$oid": "6703f1c2a9e41d7c2e0fb812"}));
    assert_eq!(value["n"], json!({"$numberLong": "5"}));
    assert!(value["d"]["$date"].is_object());
    let e = call_err(
        &mut s,
        DocRequest::Evaluate {
            text: "{ a: }".into(),
        },
    )
    .await;
    assert!(e.position.is_some());
}

/// (spec: document-browser › Unsupported JavaScript)
#[tokio::test]
async fn javascript_is_refused_with_the_documented_message() {
    let (mut s, db) = fresh("js").await;
    let e = call_err(
        &mut s,
        shell(&db, "for (var i = 0; i < 3; i++) { print(i) }"),
    )
    .await;
    assert!(
        e.message
            .contains("Only db.<collection>.<method>(…) commands are supported"),
        "{e:?}"
    );
}

#[tokio::test]
async fn export_writes_json_jsonl_and_csv() {
    let (mut s, db) = fresh("export").await;
    seed(&mut s, &db, 12).await;
    let dir = std::env::temp_dir().join(format!("clew-mongo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (format, name) in [
        (ExportFormat::Json, "a.json"),
        (ExportFormat::Jsonl, "a.jsonl"),
        (ExportFormat::Csv, "a.csv"),
    ] {
        let path = dir.join(name);
        let (r, _) = call(
            &mut s,
            DocRequest::Export {
                database: db.clone(),
                collection: "items".into(),
                filter: "".into(),
                projection: "".into(),
                sort: "{ _id: 1 }".into(),
                format,
                path: path.to_string_lossy().into(),
            },
        )
        .await;
        assert!(matches!(r, DocReply::Exported { count: 12 }));
        let text = std::fs::read_to_string(&path).unwrap();
        match format {
            ExportFormat::Json => {
                assert_eq!(serde_json::from_str::<Vec<Value>>(&text).unwrap().len(), 12)
            }
            ExportFormat::Jsonl => assert_eq!(text.lines().count(), 12),
            ExportFormat::Csv => {
                assert_eq!(text.lines().count(), 13);
                assert!(text.lines().next().unwrap().contains("name"));
            }
        }
    }
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn introspection_lists_databases_and_collections() {
    let (mut s, db) = fresh("tree").await;
    seed(&mut s, &db, 3).await;
    let driver = Registry::with_defaults().get("mongodb").unwrap();
    let pool = driver.open_meta_pool(&cfg(false)).await.unwrap();
    let root = driver.introspect(&pool, &NodePath::root()).await.unwrap();
    assert!(root
        .iter()
        .any(|n| n.name == db && n.kind == NodeKind::Database));
    let colls = driver
        .introspect(
            &pool,
            &NodePath::root().child(NodeKind::Database, db.clone()),
        )
        .await
        .unwrap();
    let items = colls.iter().find(|n| n.name == "items").unwrap();
    assert_eq!(items.kind, NodeKind::Table);
    assert_eq!(items.detail.as_deref(), Some("3"));
}

#[tokio::test]
async fn cancel_stops_a_long_query() {
    let (mut s, db) = fresh("cancel").await;
    seed(&mut s, &db, 3).await;
    let handle = s.cancel_handle();
    let started = Instant::now();
    let task = tokio::spawn(async move {
        let (sink, _rx) = ResultSink::channel(8);
        let r = s
            .as_documents()
            .unwrap()
            .call(
                find(&db, "{ $where: 'sleep(8000) || true' }", "", 0, 10),
                sink,
            )
            .await;
        (s, r)
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    handle.cancel().await.unwrap();
    let (_s, r) = task.await.unwrap();
    assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
}

// ---- the console ---------------------------------------------------------------------------------

async fn console(db: &str) -> conformance::Connected {
    let c = connect(&cfg(false)).await;
    let r = c.run(&format!("use {db}")).await;
    r.ok();
    c.run("db.items.drop()").await.ok();
    c
}

fn doc_events(run: &conformance::Run) -> Vec<Value> {
    run.events
        .iter()
        .filter_map(|e| match e {
            ResultEvent::Documents { docs, .. } => Some(docs.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

#[tokio::test]
async fn the_console_runs_shell_commands_as_documents_and_rows() {
    let c = console("clew_test_console").await;
    c.run("db.items.insertMany([{ _id: 1, name: 'a', qty: 3 }, { _id: 2, name: 'b', qty: 5 }, { _id: 3, name: 'c' }])")
        .await
        .ok();
    let r = c
        .run("db.items.find({ qty: { $gte: 3 } }).sort({ _id: -1 }).limit(5)")
        .await;
    r.ok();
    // documents for the tree / JSON views, and the same result as grid rows
    assert_eq!(doc_events(&r).len(), 2);
    let names: Vec<_> = r.columns().iter().map(|c| c.name.clone()).collect();
    assert_eq!(names, ["_id", "name", "qty"]);
    assert_eq!(r.rows().len(), 2);
    assert_eq!(conformance::int(&r.rows()[0][0]), 2);

    let r = c.run("db.items.countDocuments({})").await;
    r.ok();
    assert_eq!(doc_events(&r).len(), 1);
    assert_eq!(conformance::int(&r.rows()[0][0]), 3);

    let r = c.run("db.items.aggregate([{ $group: { _id: '$qty', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])").await;
    r.ok();
    assert_eq!(r.rows().len(), 3);

    let r = c.run("db.items.distinct('name')").await;
    r.ok();
    assert_eq!(doc_events(&r).len(), 1);

    let r = c
        .run("db.items.updateOne({ _id: 3 }, { $set: { qty: 9 } })")
        .await;
    r.ok();
    let r = c.run("db.items.findOne({ _id: 3 })").await;
    assert_eq!(conformance::int(&r.rows()[0][2]), 9);

    let r = c.run("show collections").await;
    r.ok();
    assert!(doc_events(&r).iter().any(|d| d["name"] == json!("items")));
}

#[tokio::test]
async fn console_results_page_from_the_open_cursor() {
    let c = console("clew_test_console_paging").await;
    let many: Vec<String> = (1..=120).map(|i| format!("{{ _id: {i} }}")).collect();
    c.run(&format!("db.items.insertMany([{}])", many.join(",")))
        .await
        .ok();
    let r = run_page(&c.mgr, &c.session, "db.items.find({}).sort({ _id: 1 })", 50).await;
    r.ok();
    assert_eq!(r.rows().len(), 50);
    assert!(r.ok().has_more);
    let id = r.result_id();
    let (emit, log) = collector();
    assert!(c.mgr.fetch_more(&c.session, id, 50, emit).await.unwrap());
    let rows: usize = log
        .lock()
        .unwrap()
        .iter()
        .map(|e| {
            if let ResultEvent::Rows { rows, .. } = e {
                rows.len()
            } else {
                0
            }
        })
        .sum();
    assert_eq!(rows, 50);
    let (emit, _) = collector();
    assert!(!c.mgr.fetch_more(&c.session, id, 50, emit).await.unwrap());
}

/// (spec: document-browser › Unsupported JavaScript)
#[tokio::test]
async fn the_console_refuses_javascript_with_the_documented_message() {
    let c = console("clew_test_console_js").await;
    for src in [
        "for (var i = 0; i < 3; i++) { print(i) }",
        "var x = db.items.find()",
        "db.items.find().forEach(printjson)",
    ] {
        let r = c.run(src).await;
        assert!(
            r.err()
                .message
                .contains("Only db.<collection>.<method>(…) commands are supported"),
            "{src}: {:?}",
            r.err()
        );
    }
}

#[tokio::test]
async fn a_script_runs_each_command_and_use_switches_the_database() {
    let c = console("clew_test_console_script").await;
    let r = run_script(
        &c.mgr,
        &c.session,
        "db.items.insertOne({ _id: 1 }); db.items.countDocuments({}); use clew_test_console_other",
        false,
    )
    .await;
    r.ok();
    let r = c.run("db.items.countDocuments({})").await;
    assert_eq!(
        conformance::int(&r.rows()[0][0]),
        0,
        "now in another database"
    );
}

#[tokio::test]
async fn production_asks_before_a_blanket_delete_and_refuses_writes_when_read_only() {
    let c = console("clew_test_console_guard").await;
    c.run("db.items.insertMany([{ _id: 1 }, { _id: 2 }])")
        .await
        .ok();
    c.mgr
        .set_policy("conf", Policy::managed("prod-mongo", "production", false));
    let report = c
        .mgr
        .safety_check(&c.session, "db.items.deleteMany({})", false)
        .await
        .unwrap();
    assert_eq!(report.decision, Decision::TypedConfirm);
    assert_eq!(report.typed.as_deref(), Some("prod-mongo"));
    assert_eq!(
        report.statements[0].danger.as_deref(),
        Some("Delete every document in items?")
    );
    assert_eq!(
        c.run("db.items.deleteMany({})").await.err().code,
        ErrorCode::ConfirmationRequired
    );
    // a filtered delete needs nothing
    let ok = c
        .mgr
        .safety_check(&c.session, "db.items.deleteOne({ _id: 1 })", false)
        .await
        .unwrap();
    assert_eq!(ok.decision, Decision::Allow);

    c.mgr.set_session_read_only(&c.session, true).await.unwrap();
    assert_eq!(
        c.run("db.items.deleteOne({ _id: 1 })").await.err().code,
        ErrorCode::ReadOnly
    );
    assert!(c.run("db.items.find({})").await.result.is_ok());
}

#[tokio::test]
async fn an_ssh_tunnel_reaches_the_server_mongo() {
    use clew_lib::drivers::{Secret, SshAuth, SshConfig};
    use clew_lib::transport::hostkey::{HostKeyPrompt, HostKeyPrompter, KnownHosts};
    use clew_lib::transport::ssh::SshEnv;

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
        prompter: std::sync::Arc::new(Yes),
    };
    let mgr = std::sync::Arc::new(clew_lib::sessions::SessionManager::new(
        std::sync::Arc::new(Registry::with_defaults()),
        env,
    ));
    let mut cfg = cfg(false);
    // the compose service name, resolvable from the bastion only
    cfg.target = Target::Uri {
        uri: "mongodb://mongo:27017/?directConnection=true".into(),
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
    assert_eq!(info.product, "MongoDB");
    mgr.connect("t", cfg)
        .await
        .expect("connect through the tunnel");
    let opened = mgr.open_session("t").await.expect("open");
    assert_eq!(opened.transport.as_deref(), Some("via SSH 127.0.0.1"));
}
