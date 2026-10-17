//! The command palette's object index and fuzzy search (spec: command-palette › Object index,
//! Fuzzy search). Objects come from the completion snapshot, so no extra queries run. The index
//! lives in `clew.db` (so disconnected connections stay searchable) and is mirrored in memory,
//! where `nucleo-matcher` scores it.

use std::cmp::Reverse;
use std::collections::HashSet;
use std::sync::Mutex;

use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

use crate::drivers::graph::GraphSchema;
use crate::drivers::introspect::{NodeKind, NodePath, SchemaSnapshot};

/// Results returned by one search.
pub const RESULT_LIMIT: usize = 50;

/// Bonus for a match at the very start of the name, and for one at the start of a word.
const PREFIX_BONUS: u32 = 100_000;
const WORD_BONUS: u32 = 50_000;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Table,
    View,
    MaterializedView,
    Collection,
    Column,
    Field,
    Label,
    RelationshipType,
    KeyPrefix,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::View => "view",
            Self::MaterializedView => "materialized_view",
            Self::Collection => "collection",
            Self::Column => "column",
            Self::Field => "field",
            Self::Label => "label",
            Self::RelationshipType => "relationship_type",
            Self::KeyPrefix => "key_prefix",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "table" => Self::Table,
            "view" => Self::View,
            "materialized_view" => Self::MaterializedView,
            "collection" => Self::Collection,
            "column" => Self::Column,
            "field" => Self::Field,
            "label" => Self::Label,
            "relationship_type" => Self::RelationshipType,
            "key_prefix" => Self::KeyPrefix,
            _ => return None,
        })
    }

    /// Tables and the like rank above their columns on equal matches.
    fn weight(self) -> u32 {
        match self {
            Self::Table | Self::Collection | Self::Label | Self::RelationshipType => 3,
            Self::View | Self::MaterializedView | Self::KeyPrefix => 2,
            Self::Column | Self::Field => 0,
        }
    }
}

/// One searchable object.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub connection_id: String,
    pub database: String,
    pub kind: EntryKind,
    /// What is matched and shown: `orders`, or `orders.customer_id` for a column.
    pub name: String,
    /// `analytics.public`, shown beside the name.
    pub parent_label: String,
    /// Opens the object (for a column, its table).
    pub path: NodePath,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    All,
    Objects,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteHit {
    pub entry: IndexEntry,
    /// Character positions of `entry.name` that matched, for highlighting.
    pub indices: Vec<u32>,
    #[ts(type = "number")]
    pub score: u32,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteStats {
    pub connections: u32,
    pub objects: u32,
}

/// The in-memory half of the index.
#[derive(Debug, Default)]
pub struct Palette {
    entries: Mutex<Vec<IndexEntry>>,
}

impl Palette {
    pub fn with_entries(entries: Vec<IndexEntry>) -> Self {
        Self {
            entries: Mutex::new(entries),
        }
    }

    /// Replace what is known of one (connection, database).
    pub fn replace(&self, connection_id: &str, database: &str, new: Vec<IndexEntry>) {
        let mut all = self.entries.lock().unwrap();
        all.retain(|e| !(e.connection_id == connection_id && e.database == database));
        all.extend(new);
    }

    pub fn remove_connection(&self, connection_id: &str) {
        self.entries
            .lock()
            .unwrap()
            .retain(|e| e.connection_id != connection_id);
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }

    pub fn stats(&self) -> PaletteStats {
        let all = self.entries.lock().unwrap();
        let connections: HashSet<&str> = all.iter().map(|e| e.connection_id.as_str()).collect();
        PaletteStats {
            connections: connections.len() as u32,
            objects: all.len() as u32,
        }
    }

    /// The best matches, exact prefixes first, then word-boundary matches, then the matcher's
    /// score, then the object kind and how recently it was indexed. An empty query lists the
    /// most recently indexed tables.
    pub fn search(&self, query: &str, scope: &Scope, limit: usize) -> Vec<PaletteHit> {
        let all = self.entries.lock().unwrap();
        let query = query.trim();
        let _ = scope; // Both scopes search the same objects; the UI decides what to show with them.
        if query.is_empty() {
            let mut recent: Vec<&IndexEntry> =
                all.iter().filter(|e| e.kind.weight() >= 2).collect();
            recent.sort_by_key(|e| Reverse(e.updated_at));
            return recent
                .into_iter()
                .take(limit)
                .map(|e| PaletteHit {
                    entry: e.clone(),
                    indices: vec![],
                    score: 0,
                })
                .collect();
        }
        let pattern = Pattern::new(
            query,
            CaseMatching::Ignore,
            Normalization::Smart,
            AtomKind::Fuzzy,
        );
        let mut matcher = Matcher::new(Config::DEFAULT);
        let lowered = query.to_lowercase();
        let mut buf = Vec::new();
        let mut scored: Vec<(u32, &IndexEntry)> = Vec::new();
        for e in all.iter() {
            let hay = Utf32Str::new(&e.name, &mut buf);
            let Some(score) = pattern.score(hay, &mut matcher) else {
                continue;
            };
            let name = e.name.to_lowercase();
            let mut rank = score;
            if name.starts_with(&lowered) {
                rank += PREFIX_BONUS;
            } else if starts_a_word(&name, &lowered) {
                rank += WORD_BONUS;
            }
            scored.push((rank, e));
        }
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.kind.weight().cmp(&a.1.kind.weight()))
                .then(b.1.updated_at.cmp(&a.1.updated_at))
                .then(a.1.name.len().cmp(&b.1.name.len()))
        });
        scored.truncate(limit);
        scored
            .into_iter()
            .map(|(rank, e)| {
                let mut indices = Vec::new();
                let mut buf = Vec::new();
                pattern.indices(Utf32Str::new(&e.name, &mut buf), &mut matcher, &mut indices);
                indices.sort_unstable();
                indices.dedup();
                PaletteHit {
                    entry: e.clone(),
                    indices,
                    score: rank,
                }
            })
            .collect()
    }
}

/// Whether `query` matches the start of a word in `name` (after `_`, `.`, `-`, space or `/`, or
/// at a lower-to-upper camel-case step in the original).
fn starts_a_word(name: &str, query: &str) -> bool {
    name.match_indices(query).any(|(i, _)| {
        i == 0
            || name[..i]
                .chars()
                .next_back()
                .is_some_and(|c| matches!(c, '_' | '.' | '-' | ' ' | '/' | ':'))
    })
}

/// How a driver's explorer tree is shaped, which decides the path that opens a table.
fn path_of(driver: &str, database: &str, schema: &str, kind: NodeKind, table: &str) -> NodePath {
    let mut path = NodePath::root();
    match driver {
        // schema → table, no database level.
        "oracle" => path = path.child(NodeKind::Schema, schema),
        // database → schema → table.
        "postgres" | "sqlserver" | "duckdb" => {
            if !database.is_empty() {
                path = path.child(NodeKind::Database, database);
            }
            path = path.child(NodeKind::Schema, schema);
        }
        // database → table (the snapshot's "schema" is the database).
        _ => path = path.child(NodeKind::Database, schema),
    }
    path.child(kind, table)
}

fn parent_label(driver: &str, database: &str, schema: &str) -> String {
    match driver {
        "postgres" | "sqlserver" | "duckdb" if !database.is_empty() => {
            format!("{database}.{schema}")
        }
        _ => schema.to_string(),
    }
}

/// Everything the snapshot of `driver`'s `database` makes searchable: tables, views and
/// collections, their columns and fields, and graph labels and relationship types.
pub fn entries_from_snapshot(
    connection_id: &str,
    driver: &str,
    database: &str,
    snapshot: &SchemaSnapshot,
    now: i64,
) -> Vec<IndexEntry> {
    let mongo = driver == "mongodb";
    let mut out = Vec::new();
    for schema in &snapshot.schemas {
        let parent = parent_label(driver, database, &schema.name);
        for table in &schema.tables {
            let kind = match (table.kind, mongo) {
                (_, true) => EntryKind::Collection,
                (NodeKind::View, _) => EntryKind::View,
                (NodeKind::MaterializedView, _) => EntryKind::MaterializedView,
                _ => EntryKind::Table,
            };
            let path = path_of(driver, database, &schema.name, table.kind, &table.name);
            out.push(IndexEntry {
                connection_id: connection_id.to_string(),
                database: database.to_string(),
                kind,
                name: table.name.clone(),
                parent_label: parent.clone(),
                path: path.clone(),
                updated_at: now,
            });
            for column in &table.columns {
                out.push(IndexEntry {
                    connection_id: connection_id.to_string(),
                    database: database.to_string(),
                    kind: if mongo {
                        EntryKind::Field
                    } else {
                        EntryKind::Column
                    },
                    name: format!("{}.{}", table.name, column.name),
                    parent_label: parent.clone(),
                    path: path.clone(),
                    updated_at: now,
                });
            }
        }
    }
    if let Some(graph) = &snapshot.graph {
        out.extend(graph_entries(connection_id, database, graph, now));
    }
    out
}

fn graph_entries(
    connection_id: &str,
    database: &str,
    graph: &GraphSchema,
    now: i64,
) -> Vec<IndexEntry> {
    let group = |name: &str| {
        NodePath::root()
            .child(NodeKind::Database, database)
            .child(NodeKind::Group, name)
    };
    let labels = graph
        .labels
        .iter()
        .map(|l| (EntryKind::Label, "Node labels", &l.name));
    let types = graph
        .relationship_types
        .iter()
        .map(|t| (EntryKind::RelationshipType, "Relationship types", &t.name));
    labels
        .chain(types)
        .map(|(kind, folder, name)| IndexEntry {
            connection_id: connection_id.to_string(),
            database: database.to_string(),
            kind,
            name: name.clone(),
            parent_label: database.to_string(),
            path: group(folder).child(NodeKind::Table, name.clone()),
            updated_at: now,
        })
        .collect()
}

#[cfg(test)]
mod tests;
