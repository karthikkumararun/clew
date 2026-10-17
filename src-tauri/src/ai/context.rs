//! Context for a request (spec: ai-assistant › Schema-grounded context): the dialect, the schema
//! of the tables the question is about, the statement, the last error and attached rows. The
//! builder collects candidates; `policy::filter` decides what is actually sent.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::policy::{redact, ContextItem, ItemKind, MAX_ROWS};
use crate::drivers::graph::GraphSchema;
use crate::drivers::introspect::{SchemaSnapshot, SnapshotTable};

/// Tables whose schema is attached at most (mentioned ones first).
pub const MAX_TABLES: usize = 12;
/// Longest statement or error text sent, in characters.
const MAX_TEXT: usize = 8_000;

/// Rows the user attached to a message.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowsAttachment {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

pub struct ContextInput<'a> {
    pub driver: &'a str,
    pub server_version: Option<&'a str>,
    pub snapshot: Option<&'a SchemaSnapshot>,
    /// Tables the user @-mentioned.
    pub mentioned: &'a [String],
    pub statement: Option<&'a str>,
    pub error: Option<&'a str>,
    pub rows: Option<&'a RowsAttachment>,
    pub hosts: &'a [String],
    pub users: &'a [String],
}

/// The name of the language the model should write for a driver.
pub fn dialect_name(driver: &str) -> &'static str {
    match driver {
        "postgres" => "PostgreSQL",
        "mysql" => "MySQL",
        "mariadb" => "MariaDB",
        "sqlserver" => "SQL Server (T-SQL)",
        "oracle" => "Oracle SQL",
        "clickhouse" => "ClickHouse SQL",
        "sqlite" => "SQLite",
        "duckdb" => "DuckDB",
        "mongodb" => "MongoDB (shell syntax)",
        "redis" => "Redis commands",
        "neo4j" => "Cypher (Neo4j)",
        _ => "SQL",
    }
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX_TEXT {
        return s.to_string();
    }
    let mut t: String = s.chars().take(MAX_TEXT).collect();
    t.push_str("\n… (truncated)");
    t
}

/// `schema.table` pairs of the snapshot.
fn tables(snapshot: &SchemaSnapshot) -> Vec<(&str, &SnapshotTable)> {
    snapshot
        .schemas
        .iter()
        .flat_map(|s| s.tables.iter().map(move |t| (s.name.as_str(), t)))
        .collect()
}

/// A table by `name` or `schema.name`, case-insensitively.
pub fn find_table<'a>(
    snapshot: &'a SchemaSnapshot,
    name: &str,
) -> Option<(&'a str, &'a SnapshotTable)> {
    let wanted = name
        .trim()
        .trim_matches(['"', '`', '[', ']'])
        .to_lowercase();
    let all = tables(snapshot);
    all.iter()
        .find(|(s, t)| format!("{}.{}", s.to_lowercase(), t.name.to_lowercase()) == wanted)
        .or_else(|| all.iter().find(|(_, t)| t.name.to_lowercase() == wanted))
        .copied()
}

/// Names in `statement` that are tables of the snapshot.
pub fn referenced_tables(statement: &str, snapshot: &SchemaSnapshot) -> Vec<String> {
    let known: BTreeSet<String> = tables(snapshot)
        .iter()
        .map(|(_, t)| t.name.to_lowercase())
        .collect();
    let re = regex::Regex::new(r"[A-Za-z_][A-Za-z0-9_$]*").expect("valid regex");
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for m in re.find_iter(statement) {
        let lower = m.as_str().to_lowercase();
        if known.contains(&lower) && seen.insert(lower) {
            out.push(m.as_str().to_string());
        }
    }
    out
}

/// One table as the model reads it.
pub fn describe(schema: &str, multiple_schemas: bool, t: &SnapshotTable) -> String {
    let name = if multiple_schemas {
        format!("{schema}.{}", t.name)
    } else {
        t.name.clone()
    };
    let kind = match t.kind {
        crate::drivers::introspect::NodeKind::View => "view",
        crate::drivers::introspect::NodeKind::MaterializedView => "materialized view",
        _ => "table",
    };
    let cols = t
        .columns
        .iter()
        .map(|c| {
            if c.type_name.is_empty() {
                c.name.clone()
            } else {
                format!("{} {}", c.name, c.type_name)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("{name} ({kind}): {cols}")
}

pub fn graph_description(g: &GraphSchema) -> String {
    let counts = |items: &[crate::drivers::graph::GraphCount]| {
        items
            .iter()
            .map(|i| format!("{} ({})", i.name, i.count))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut lines = vec![
        format!("Node labels: {}", counts(&g.labels)),
        format!("Relationship types: {}", counts(&g.relationship_types)),
        format!("Property keys: {}", g.property_keys.join(", ")),
    ];
    for (title, items) in [("Indexes", &g.indexes), ("Constraints", &g.constraints)] {
        if !items.is_empty() {
            let list = items
                .iter()
                .map(|i| {
                    format!(
                        "{} {} on {}({})",
                        i.kind,
                        i.name,
                        i.labels.join("|"),
                        i.properties.join(", ")
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            lines.push(format!("{title}: {list}"));
        }
    }
    lines.join("\n")
}

/// Candidate context items and the names of the tables whose schema they hold.
pub fn build(input: &ContextInput<'_>) -> (Vec<ContextItem>, Vec<String>) {
    let mut items = Vec::new();
    let mut read = Vec::new();

    let dialect = dialect_name(input.driver);
    items.push(ContextItem {
        kind: ItemKind::Dialect,
        label: "dialect".into(),
        content: match input.server_version.filter(|v| !v.is_empty()) {
            Some(v) => format!("{dialect}, server version {v}"),
            None => dialect.to_string(),
        },
    });

    if let Some(snapshot) = input.snapshot {
        if let Some(graph) = &snapshot.graph {
            items.push(ContextItem {
                kind: ItemKind::Schema,
                label: "graph schema".into(),
                content: graph_description(graph),
            });
        }
        let multiple = snapshot.schemas.len() > 1;
        let mut wanted: Vec<String> = input.mentioned.to_vec();
        if let Some(s) = input.statement {
            wanted.extend(referenced_tables(s, snapshot));
        }
        let mut seen = BTreeSet::new();
        for name in wanted {
            if read.len() >= MAX_TABLES {
                break;
            }
            let Some((schema, table)) = find_table(snapshot, &name) else {
                continue;
            };
            if !seen.insert(format!("{schema}.{}", table.name).to_lowercase()) {
                continue;
            }
            read.push(table.name.clone());
            items.push(ContextItem {
                kind: ItemKind::Schema,
                label: format!("schema of {}", table.name),
                content: describe(schema, multiple, table),
            });
        }
    }

    if let Some(s) = input.statement.filter(|s| !s.trim().is_empty()) {
        items.push(ContextItem {
            kind: ItemKind::Statement,
            label: "statement".into(),
            content: truncate(s),
        });
    }
    if let Some(e) = input.error.filter(|e| !e.trim().is_empty()) {
        items.push(ContextItem {
            kind: ItemKind::Error,
            label: "error".into(),
            content: truncate(&redact(e, input.hosts, input.users)),
        });
    }
    if let Some(r) = input.rows {
        let rows: Vec<String> = r
            .rows
            .iter()
            .take(MAX_ROWS)
            .map(|row| row.join(" | "))
            .collect();
        items.push(ContextItem {
            kind: ItemKind::Rows,
            label: format!("{} sample rows", rows.len()),
            content: format!("{}\n{}", r.columns.join(" | "), rows.join("\n")),
        });
    }
    (items, read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::introspect::{NodeKind, SnapshotColumn, SnapshotSchema};

    fn snapshot() -> SchemaSnapshot {
        let col = |n: &str, t: &str| SnapshotColumn {
            name: n.into(),
            type_name: t.into(),
        };
        let table = |n: &str, cols: Vec<SnapshotColumn>| SnapshotTable {
            name: n.into(),
            kind: NodeKind::Table,
            columns: cols,
        };
        SchemaSnapshot {
            schemas: vec![SnapshotSchema {
                name: "public".into(),
                tables: vec![
                    table(
                        "orders",
                        vec![col("id", "integer"), col("user_id", "integer")],
                    ),
                    table(
                        "shipments",
                        vec![col("order_id", "integer"), col("carrier", "text")],
                    ),
                    table("users", vec![col("id", "integer")]),
                ],
                functions: vec![],
            }],
            graph: None,
        }
    }

    fn input<'a>(snap: &'a SchemaSnapshot) -> ContextInput<'a> {
        ContextInput {
            driver: "postgres",
            server_version: Some("16.2"),
            snapshot: Some(snap),
            mentioned: &[],
            statement: None,
            error: None,
            rows: None,
            hosts: &[],
            users: &[],
        }
    }

    #[test]
    fn finds_the_tables_a_statement_references() {
        let snap = snapshot();
        let sql =
            "SELECT o.id, s.carrier FROM Orders o JOIN shipments s ON s.order_id = o.id -- users";
        assert_eq!(
            referenced_tables(sql, &snap),
            vec!["Orders", "shipments", "users"]
        );
    }

    #[test]
    fn builds_dialect_schema_statement_and_error() {
        let snap = snapshot();
        let mentioned = vec!["users".to_string()];
        let (items, read) = build(&ContextInput {
            mentioned: &mentioned,
            statement: Some("SELECT o.carrier FROM orders o"),
            error: Some("column o.carrier does not exist"),
            ..input(&snap)
        });
        let labels: Vec<_> = items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "dialect",
                "schema of users",
                "schema of orders",
                "statement",
                "error"
            ]
        );
        assert_eq!(read, vec!["users", "orders"]);
        assert_eq!(items[0].content, "PostgreSQL, server version 16.2");
        assert_eq!(
            items[2].content,
            "orders (table): id integer, user_id integer"
        );
    }

    #[test]
    fn error_text_is_redacted_before_it_is_an_item() {
        let snap = snapshot();
        let hosts = vec!["db.internal.example.com".to_string()];
        let users = vec!["app_reader".to_string()];
        let (items, _) = build(&ContextInput {
            error: Some("could not connect to db.internal.example.com as app_reader"),
            hosts: &hosts,
            users: &users,
            ..input(&snap)
        });
        let e = items.iter().find(|i| i.kind == ItemKind::Error).unwrap();
        assert_eq!(e.content, "could not connect to <host> as <user>");
    }

    #[test]
    fn at_most_twenty_rows_are_attached() {
        let snap = snapshot();
        let rows = RowsAttachment {
            columns: vec!["id".into()],
            rows: (0..50).map(|i| vec![i.to_string()]).collect(),
        };
        let (items, _) = build(&ContextInput {
            rows: Some(&rows),
            ..input(&snap)
        });
        let r = items.iter().find(|i| i.kind == ItemKind::Rows).unwrap();
        assert_eq!(r.label, "20 sample rows");
        assert_eq!(r.content.lines().count(), 21);
    }

    #[test]
    fn a_disconnected_console_still_gets_a_dialect() {
        let (items, read) = build(&ContextInput {
            snapshot: None,
            ..input(&snapshot())
        });
        assert_eq!(items.len(), 1);
        assert!(read.is_empty());
    }

    /// (spec: graph-browser › Explorer, palette and AI integration)
    #[test]
    fn graph_connections_get_a_cypher_dialect_and_a_graph_schema() {
        use crate::drivers::graph::{GraphCount, GraphSchema, GraphSchemaItem};
        let snap = SchemaSnapshot {
            schemas: vec![],
            graph: Some(GraphSchema {
                labels: vec![GraphCount {
                    name: "Person".into(),
                    count: 3,
                }],
                relationship_types: vec![GraphCount {
                    name: "KNOWS".into(),
                    count: 2,
                }],
                property_keys: vec!["name".into(), "born".into()],
                indexes: vec![GraphSchemaItem {
                    name: "person_name".into(),
                    kind: "RANGE".into(),
                    labels: vec!["Person".into()],
                    properties: vec!["name".into()],
                    state: Some("ONLINE".into()),
                }],
                ..Default::default()
            }),
        };
        let (items, _) = build(&ContextInput {
            driver: "neo4j",
            server_version: Some("5.20"),
            snapshot: Some(&snap),
            ..input(&snap)
        });
        assert_eq!(items[0].content, "Cypher (Neo4j), server version 5.20");
        let g = &items[1];
        assert_eq!(g.kind, ItemKind::Schema);
        assert!(g.content.contains("Node labels: Person (3)"));
        assert!(g.content.contains("Relationship types: KNOWS (2)"));
        assert!(g.content.contains("Property keys: name, born"));
        assert!(g
            .content
            .contains("Indexes: RANGE person_name on Person(name)"));
    }

    #[test]
    fn find_table_accepts_qualified_and_quoted_names() {
        let snap = snapshot();
        assert!(find_table(&snap, "public.orders").is_some());
        assert!(find_table(&snap, "\"Orders\"").is_some());
        assert!(find_table(&snap, "missing").is_none());
    }
}
