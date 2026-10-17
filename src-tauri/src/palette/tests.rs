use std::time::Instant;

use super::*;
use crate::drivers::graph::GraphCount;
use crate::drivers::introspect::{SnapshotColumn, SnapshotSchema, SnapshotTable};
use crate::store::Store;

fn entry(conn: &str, kind: EntryKind, name: &str, parent: &str, at: i64) -> IndexEntry {
    IndexEntry {
        connection_id: conn.into(),
        database: "db".into(),
        kind,
        name: name.into(),
        parent_label: parent.into(),
        path: NodePath::root().child(NodeKind::Table, name),
        updated_at: at,
    }
}

fn names(hits: &[PaletteHit]) -> Vec<(&str, &str)> {
    hits.iter()
        .map(|h| (h.entry.connection_id.as_str(), h.entry.name.as_str()))
        .collect()
}

/// (spec: command-palette › Search "ord")
fn ord_fixture() -> Palette {
    Palette::with_entries(vec![
        entry("dev-mongo", EntryKind::Field, "carts.orderRef", "shop", 5),
        entry("staging-mysql", EntryKind::Table, "orders", "app", 3),
        entry(
            "prod-postgres",
            EntryKind::Table,
            "order_items",
            "analytics.public",
            2,
        ),
        entry(
            "prod-postgres",
            EntryKind::Table,
            "orders",
            "analytics.public",
            4,
        ),
        entry(
            "prod-postgres",
            EntryKind::Table,
            "customers",
            "analytics.public",
            9,
        ),
        entry(
            "prod-postgres",
            EntryKind::Column,
            "customers.border",
            "analytics.public",
            9,
        ),
    ])
}

#[test]
fn ord_ranks_prefix_tables_before_word_matches_and_fields() {
    let hits = ord_fixture().search("ord", &Scope::All, RESULT_LIMIT);
    let got = names(&hits);
    // Prefix matches first (shorter, then more recently indexed, first), the mid-word
    // `border` last; `customers` doesn't match at all.
    assert_eq!(got.len(), 5, "{got:?}");
    let pos = |c: &str, n: &str| got.iter().position(|g| *g == (c, n)).unwrap();
    assert_eq!(got[0], ("prod-postgres", "orders"));
    assert!(pos("prod-postgres", "orders") < pos("prod-postgres", "order_items"));
    assert!(pos("staging-mysql", "orders") < pos("dev-mongo", "carts.orderRef"));
    assert!(pos("dev-mongo", "carts.orderRef") < pos("prod-postgres", "customers.border"));
    assert_eq!(got.last().unwrap().1, "customers.border");
}

#[test]
fn matched_characters_are_reported_for_highlighting() {
    let hits = ord_fixture().search("ord", &Scope::All, RESULT_LIMIT);
    let orders = hits.iter().find(|h| h.entry.name == "orders").unwrap();
    assert_eq!(orders.indices, vec![0, 1, 2]);
}

#[test]
fn nothing_matches_gives_no_hits() {
    assert!(ord_fixture()
        .search("zzzz", &Scope::All, RESULT_LIMIT)
        .is_empty());
}

#[test]
fn empty_query_lists_the_newest_tables() {
    let hits = ord_fixture().search("", &Scope::All, 2);
    assert_eq!(names(&hits)[0], ("prod-postgres", "customers"));
    assert!(hits.iter().all(|h| h.entry.kind != EntryKind::Column));
}

#[test]
fn replacing_one_database_keeps_the_rest() {
    let p = ord_fixture();
    p.replace(
        "prod-postgres",
        "db",
        vec![entry("prod-postgres", EntryKind::Table, "invoices", "x", 1)],
    );
    let all = p.search("o", &Scope::All, 100);
    assert!(all.iter().any(|h| h.entry.name == "invoices"));
    assert!(all.iter().all(|h| h.entry.name != "order_items"));
    assert!(all.iter().any(|h| h.entry.connection_id == "staging-mysql"));
    p.remove_connection("staging-mysql");
    assert_eq!(p.stats().connections, 2);
}

/// 100,000 objects answer within 50 ms in a release build (requirement: Fuzzy search).
#[test]
fn searching_100k_objects_stays_within_budget() {
    let entries = (0..100_000)
        .map(|i| {
            entry(
                &format!("c{}", i % 5),
                if i % 4 == 0 {
                    EntryKind::Table
                } else {
                    EntryKind::Column
                },
                &format!("table_{i}.column_{}", i % 97),
                "public",
                i,
            )
        })
        .collect();
    let p = Palette::with_entries(entries);
    p.search("tab col", &Scope::All, RESULT_LIMIT); // warm up
    let start = Instant::now();
    let hits = p.search("tbl9", &Scope::All, RESULT_LIMIT);
    let took = start.elapsed();
    assert!(!hits.is_empty());
    // The budget is for a release build; a debug build is allowed ten times as long.
    let budget = if cfg!(debug_assertions) { 500 } else { 50 };
    assert!(took.as_millis() < budget, "search took {took:?}");
}

fn snapshot() -> SchemaSnapshot {
    SchemaSnapshot {
        schemas: vec![SnapshotSchema {
            name: "public".into(),
            tables: vec![
                SnapshotTable {
                    name: "orders".into(),
                    kind: NodeKind::Table,
                    columns: vec![SnapshotColumn {
                        name: "id".into(),
                        type_name: "int".into(),
                    }],
                },
                SnapshotTable {
                    name: "v_totals".into(),
                    kind: NodeKind::View,
                    columns: vec![],
                },
            ],
            functions: vec![],
        }],
        graph: None,
    }
}

#[test]
fn postgres_snapshot_becomes_openable_paths() {
    let e = entries_from_snapshot("c1", "postgres", "analytics", &snapshot(), 7);
    assert_eq!(e.len(), 3);
    assert_eq!(e[0].kind, EntryKind::Table);
    assert_eq!(e[0].parent_label, "analytics.public");
    assert_eq!(
        e[0].path,
        NodePath::root()
            .child(NodeKind::Database, "analytics")
            .child(NodeKind::Schema, "public")
            .child(NodeKind::Table, "orders")
    );
    assert_eq!(e[1].kind, EntryKind::Column);
    assert_eq!(e[1].name, "orders.id");
    assert_eq!(e[1].path, e[0].path, "a column opens its table");
    assert_eq!(e[2].kind, EntryKind::View);
}

#[test]
fn mysql_and_mongo_snapshots_use_the_database_level() {
    let m = entries_from_snapshot("c1", "mysql", "", &snapshot(), 0);
    assert_eq!(
        m[0].path,
        NodePath::root()
            .child(NodeKind::Database, "public")
            .child(NodeKind::Table, "orders")
    );
    let mongo = entries_from_snapshot("c2", "mongodb", "shop", &snapshot(), 0);
    assert_eq!(mongo[0].kind, EntryKind::Collection);
    assert_eq!(mongo[1].kind, EntryKind::Field);
}

#[test]
fn graph_labels_and_relationship_types_are_indexed() {
    let snap = SchemaSnapshot {
        graph: Some(GraphSchema {
            labels: vec![GraphCount {
                name: "Person".into(),
                count: 3,
            }],
            relationship_types: vec![GraphCount {
                name: "KNOWS".into(),
                count: 1,
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    let e = entries_from_snapshot("g", "neo4j", "neo4j", &snap, 0);
    assert_eq!(e.len(), 2);
    assert_eq!(e[0].kind, EntryKind::Label);
    assert_eq!(e[1].kind, EntryKind::RelationshipType);
    assert_eq!(e[1].parent_label, "neo4j");
}

/// (spec: command-palette › Disconnected connection)
#[tokio::test]
async fn the_index_survives_a_restart() {
    let store = Store::open_in_memory().await.unwrap();
    let entries = entries_from_snapshot("c1", "postgres", "analytics", &snapshot(), 7);
    store
        .palette_replace("c1", "analytics", &entries)
        .await
        .unwrap();
    store
        .palette_replace("c1", "analytics", &entries)
        .await
        .unwrap(); // replaces, not appends
    let loaded = store.palette_load().await.unwrap();
    assert_eq!(loaded, entries);
    store.palette_remove_connection("c1").await.unwrap();
    assert!(store.palette_load().await.unwrap().is_empty());
}
