use serde::{Deserialize, Serialize};

/// The uniform value model. Every driver converts to and from this.
///
/// Serialized as `{ "kind": "...", ... }`. Integers outside ±2^53 would lose precision in
/// JavaScript, so constructors (`Value::from_i64`) emit `bigint` strings for those.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Value {
    Null,
    Bool {
        value: bool,
    },
    Int {
        value: i64,
    },
    /// Decimal string; used for integers beyond the JS-safe range and beyond i64.
    Bigint {
        value: String,
    },
    Float {
        value: f64,
    },
    /// Exact decimal as a string. Never converted to a float.
    Decimal {
        value: String,
    },
    Text {
        value: String,
        #[serde(default, skip_serializing_if = "is_false")]
        truncated: bool,
    },
    /// Hex string (no prefix). `len` is the full byte length.
    Bytes {
        value: String,
        len: u64,
        #[serde(default, skip_serializing_if = "is_false")]
        truncated: bool,
    },
    Date {
        value: String,
    },
    Time {
        value: String,
    },
    Timestamp {
        value: String,
    },
    Timestamptz {
        value: String,
    },
    Interval {
        value: String,
    },
    Uuid {
        value: String,
    },
    Json {
        value: serde_json::Value,
    },
    Array {
        value: Vec<Value>,
    },
    /// A type the driver cannot decode natively: its text form plus the type name. Read-only.
    Other {
        value: String,
        type_name: String,
    },
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Coarse kind of a column's values, for grid rendering and editing decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueKind {
    Bool,
    Int,
    Bigint,
    Float,
    Decimal,
    Text,
    Bytes,
    Date,
    Time,
    Timestamp,
    Timestamptz,
    Interval,
    Uuid,
    Json,
    Array,
    Other,
}
