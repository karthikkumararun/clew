//! What the graph family adds to the driver contract: Cypher requests, results that carry the
//! distinct nodes and relationships next to the records, query plans, and the graph schema.
//! Graph values (`node`, `relationship`, `path`) are kinds of [`Value`], so a record cell is
//! just a `Value`; the structs here serialize with camelCase field names.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::Value;

/// Which Bolt access mode a query runs in. Read-only sessions always run in `Read`.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphAccess {
    #[default]
    Read,
    Write,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphMode {
    #[default]
    Run,
    /// Plan only; nothing runs.
    Explain,
    /// Runs the query and reports actual rows and db hits per operator.
    Profile,
}

pub const DEFAULT_FETCH_SIZE: u32 = 500;

fn default_fetch_size() -> u32 {
    DEFAULT_FETCH_SIZE
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRequest {
    pub cypher: String,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub params: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub access: GraphAccess,
    #[serde(default)]
    pub mode: GraphMode,
    /// Records per batch; more arrive through `graph_fetch_more`.
    #[serde(default = "default_fetch_size")]
    pub fetch_size: u32,
}

/// A node, de-duplicated by `element_id` across the records of a result.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub element_id: String,
    pub labels: Vec<String>,
    pub properties: BTreeMap<String, Value>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRel {
    pub element_id: String,
    pub rel_type: String,
    pub start_id: String,
    pub end_id: String,
    pub properties: BTreeMap<String, Value>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSummary {
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    /// Update counters the server reports (`nodes-created`, `properties-set`, …) that are not 0.
    #[ts(type = "Record<string, number>")]
    pub counters: BTreeMap<String, i64>,
    /// The database the query ran on.
    pub database: String,
}

/// One operator of an EXPLAIN / PROFILE plan, children below it.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    /// `Expand(All)`, `NodeByLabelScan`, … without the `@database` suffix.
    pub operator: String,
    /// The operator's arguments in one line (`(n:User)`, `n.id = $id`).
    pub details: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub estimated_rows: Option<f64>,
    /// Actual rows (PROFILE only).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub rows: Option<i64>,
    /// Database hits (PROFILE only).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub db_hits: Option<i64>,
    pub children: Vec<PlanNode>,
}

/// One batch of a graph query. Later batches (`graph_fetch_more`) carry only their own records,
/// nodes and relationships.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphResult {
    /// Present while more records are waiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cursor_id: Option<String>,
    pub columns: Vec<String>,
    pub records: Vec<Vec<Value>>,
    pub nodes: Vec<GraphNode>,
    pub relationships: Vec<GraphRel>,
    pub has_more: bool,
    pub summary: GraphSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan: Option<PlanNode>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphCount {
    pub name: String,
    #[ts(type = "number")]
    pub count: i64,
}

/// An index or a constraint. `labels` holds the node labels or relationship types it covers.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSchemaItem {
    pub name: String,
    /// `RANGE`, `TEXT`, `UNIQUENESS`, `NODE_KEY`, … as the server reports it.
    pub kind: String,
    pub labels: Vec<String>,
    pub properties: Vec<String>,
    /// Indexes only: `ONLINE`, `POPULATING`, `FAILED`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSchema {
    pub labels: Vec<GraphCount>,
    pub relationship_types: Vec<GraphCount>,
    pub property_keys: Vec<String>,
    pub indexes: Vec<GraphSchemaItem>,
    pub constraints: Vec<GraphSchemaItem>,
    /// Function and procedure names, for completion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub functions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub procedures: Option<Vec<String>>,
}
