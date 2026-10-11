//! What the document and key-value families add to the driver contract: the requests a browser
//! can make and the replies it gets. Documents travel as canonical Extended JSON, which keeps
//! every BSON type (Int32 vs Int64 vs Double, ObjectId, Date, Decimal128…) exact; the frontend
//! turns it into typed trees and back.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use super::ResultId;

// ---- documents -------------------------------------------------------------------------------

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CollectionInfo {
    pub name: String,
    /// Estimated document count (from metadata; free).
    #[ts(type = "number | null")]
    pub count: Option<i64>,
    /// `collection`, `view` or `timeseries`.
    pub kind: String,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexInfo {
    pub name: String,
    /// The key pattern as canonical Extended JSON, e.g. `{ "ts": 1 }`.
    pub keys: Json,
    pub unique: bool,
    pub sparse: bool,
    /// `expireAfterSeconds` of a TTL index.
    #[ts(type = "number | null")]
    pub ttl_seconds: Option<i64>,
    #[ts(type = "number | null")]
    pub size_bytes: Option<i64>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TypeShare {
    pub type_name: String,
    /// Share of the sampled documents holding this type at this path, 0–100.
    pub percent: f64,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SchemaField {
    /// Dot path; array elements are `[]` (`items.[].sku`).
    pub path: String,
    pub types: Vec<TypeShare>,
    /// Share of sampled documents that have the path at all.
    pub present_percent: f64,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
pub struct FieldCheck {
    pub path: String,
    /// The field did not exist when the document was loaded (then `value` is ignored).
    pub absent: bool,
    /// The value the field had when the document was loaded.
    pub value: Json,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Json,
    Jsonl,
    Csv,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DocRequest {
    Databases,
    Collections {
        database: String,
    },
    /// Evaluate shell-syntax text (`{ _id: ObjectId("…"), n: NumberLong(5) }`) to canonical
    /// Extended JSON without running anything: the JSON editor's save and the insert dialog.
    Evaluate {
        text: String,
    },
    /// Validate one query-bar field without running anything.
    Parse {
        field: String,
        text: String,
    },
    Find {
        database: String,
        collection: String,
        filter: String,
        projection: String,
        sort: String,
        #[ts(type = "number")]
        skip: u64,
        /// 0 = no limit.
        #[ts(type = "number")]
        limit: u64,
        #[ts(type = "number")]
        page_size: usize,
    },
    Aggregate {
        database: String,
        collection: String,
        pipeline: String,
        #[ts(type = "number")]
        page_size: usize,
    },
    Explain {
        database: String,
        collection: String,
        filter: String,
        sort: String,
    },
    Count {
        database: String,
        collection: String,
        filter: String,
        /// Stop counting here.
        #[ts(type = "number")]
        cap: u64,
    },
    Insert {
        database: String,
        collection: String,
        documents: Vec<Json>,
    },
    Replace {
        database: String,
        collection: String,
        id: Json,
        document: Json,
        #[serde(default)]
        check: Vec<FieldCheck>,
        #[serde(default)]
        force: bool,
    },
    Update {
        database: String,
        collection: String,
        id: Json,
        /// path → new value (canonical Extended JSON)
        set: Json,
        #[serde(default)]
        unset: Vec<String>,
        #[serde(default)]
        check: Vec<FieldCheck>,
        #[serde(default)]
        force: bool,
    },
    Delete {
        database: String,
        collection: String,
        ids: Vec<Json>,
    },
    Indexes {
        database: String,
        collection: String,
    },
    CreateIndex {
        database: String,
        collection: String,
        keys: String,
        name: Option<String>,
        #[serde(default)]
        unique: bool,
        #[serde(default)]
        sparse: bool,
        #[ts(type = "number | null")]
        ttl_seconds: Option<i64>,
    },
    DropIndex {
        database: String,
        collection: String,
        name: String,
    },
    Schema {
        database: String,
        collection: String,
        filter: String,
        #[ts(type = "number")]
        sample: u32,
    },
    /// One console command (`db.events.find(...)`, `show collections`, `use shop`).
    Shell {
        database: String,
        text: String,
        #[ts(type = "number")]
        page_size: usize,
    },
    /// Write every match to a file.
    Export {
        database: String,
        collection: String,
        filter: String,
        projection: String,
        sort: String,
        format: ExportFormat,
        path: String,
    },
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DocReply {
    Databases {
        names: Vec<String>,
    },
    Collections {
        items: Vec<CollectionInfo>,
    },
    Parsed,
    /// Documents were streamed to the sink as `Documents` events under `result_id`.
    Found {
        #[ts(type = "number")]
        result_id: ResultId,
        has_more: bool,
        #[ts(type = "number")]
        elapsed_ms: u64,
        /// The collection the console command ran against, when it changed (`use`).
        database: Option<String>,
    },
    Explain {
        /// Name of the index the winning plan uses.
        index: Option<String>,
        collscan: bool,
    },
    Count {
        #[ts(type = "number")]
        count: u64,
        /// The count stopped at the cap.
        capped: bool,
    },
    Written {
        inserted: Vec<Json>,
        #[ts(type = "number")]
        matched: u64,
        #[ts(type = "number")]
        modified: u64,
        #[ts(type = "number")]
        deleted: u64,
    },
    /// The document changed (or vanished) since it was loaded.
    Conflict {
        current: Option<Json>,
    },
    Indexes {
        items: Vec<IndexInfo>,
    },
    Schema {
        #[ts(type = "number")]
        sampled: u64,
        fields: Vec<SchemaField>,
    },
    /// A single value from the console (a count, `distinct`, an insert result…).
    Value {
        value: Json,
    },
    Text {
        text: String,
    },
    Exported {
        #[ts(type = "number")]
        count: u64,
    },
}

// ---- key-value -------------------------------------------------------------------------------

/// A Redis reply, typed.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RedisValue {
    Nil,
    Int {
        #[ts(type = "number")]
        value: i64,
    },
    Double {
        value: f64,
    },
    Bool {
        value: bool,
    },
    /// `+OK` and friends.
    Status {
        value: String,
    },
    Text {
        value: String,
    },
    /// Not valid UTF-8: hex of the bytes (capped) and the full length.
    Bytes {
        hex: String,
        #[ts(type = "number")]
        len: u64,
    },
    Array {
        items: Vec<RedisValue>,
    },
    Map {
        entries: Vec<(RedisValue, RedisValue)>,
    },
    Error {
        message: String,
    },
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyInfo {
    pub name: String,
    /// `string`, `hash`, `list`, `set`, `zset`, `stream`…
    pub type_name: String,
    /// Milliseconds to live; `None` = no expiry.
    #[ts(type = "number | null")]
    pub ttl_ms: Option<i64>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyDetail {
    pub name: String,
    pub type_name: String,
    #[ts(type = "number | null")]
    pub ttl_ms: Option<i64>,
    /// Elements (or bytes for a string).
    #[ts(type = "number")]
    pub size: u64,
    pub encoding: Option<String>,
    /// `MEMORY USAGE`, when the server answers.
    #[ts(type = "number | null")]
    pub memory: Option<u64>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum KvRequest {
    /// Keyspace sizes per logical database.
    Databases,
    /// One incremental SCAN step. Never `KEYS`.
    Scan {
        db: u32,
        pattern: String,
        cursor: String,
        count: u32,
        /// Only keys of this type (`SCAN … TYPE`).
        type_filter: Option<String>,
    },
    Inspect {
        db: u32,
        key: String,
    },
    /// One chunk of a key's contents (see [`KvReply::Page`]).
    Page {
        db: u32,
        key: String,
        type_name: String,
        /// List/zset offset, or the HSCAN / SSCAN cursor, or the stream's exclusive end id.
        position: String,
        count: u32,
    },
    /// Command names, for completion.
    Commands,
    /// One console line (`HSET session:42 plan pro`), tokenized with shell-style quoting.
    Command {
        db: u32,
        line: String,
    },
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KvReply {
    Databases {
        /// (index, key count) for every database with keys, plus database 0.
        #[ts(type = "Array<[number, number]>")]
        items: Vec<(u32, u64)>,
        databases: u32,
    },
    Keys {
        /// `"0"` when the scan is complete.
        cursor: String,
        keys: Vec<KeyInfo>,
    },
    Key {
        detail: Option<KeyDetail>,
    },
    /// Rows of a key's contents. Shapes: hash `[field, value]`, list `[value]`, set `[member]`,
    /// zset `[member, score]`, stream `[id, [field, value, …]]`, string `[value]`.
    Page {
        rows: Vec<Vec<RedisValue>>,
        /// Where the next chunk starts; `None` at the end.
        next: Option<String>,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    Commands {
        names: Vec<String>,
    },
    Reply {
        value: RedisValue,
    },
}
