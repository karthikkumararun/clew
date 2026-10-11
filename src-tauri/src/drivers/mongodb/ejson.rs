//! BSON ⇄ canonical Extended JSON. Canonical keeps every type exact on the wire
//! (`{"$numberInt":"5"}`, `{"$oid":"…"}`, `{"$date":{"$numberLong":"…"}}`), so a document survives
//! a trip through the WebView and back unchanged.

use mongodb::bson::{Bson, Document};
use serde_json::Value as Json;

use crate::drivers::{DriverError, DriverResult, ErrorCode};

pub fn to_json(b: Bson) -> Json {
    b.into_canonical_extjson()
}

pub fn doc_to_json(d: Document) -> Json {
    to_json(Bson::Document(d))
}

pub fn from_json(j: &Json) -> DriverResult<Bson> {
    Bson::try_from(j.clone()).map_err(|e| {
        DriverError::new(
            ErrorCode::QueryFailed,
            format!("Not valid Extended JSON: {e}"),
        )
    })
}

pub fn doc_from_json(j: &Json) -> DriverResult<Document> {
    match from_json(j)? {
        Bson::Document(d) => Ok(d),
        _ => Err(DriverError::new(
            ErrorCode::QueryFailed,
            "Expected a document",
        )),
    }
}

/// The name of a BSON value's type, as shown in the inferred schema.
pub fn type_name(b: &Bson) -> &'static str {
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, oid::ObjectId};

    #[test]
    fn numeric_types_survive_a_round_trip() {
        let d = doc! {
            "_id": ObjectId::parse_str("6703f1c2a9e41d7c2e0fb812").unwrap(),
            "i": 5_i32, "l": 5_i64, "d": 5.0_f64,
            "when": mongodb::bson::DateTime::from_millis(1_700_000_000_000),
            "nested": { "a": [1_i32, "x", null] },
        };
        let j = doc_to_json(d.clone());
        assert_eq!(j["i"], serde_json::json!({"$numberInt": "5"}));
        assert_eq!(j["l"], serde_json::json!({"$numberLong": "5"}));
        assert_eq!(j["d"], serde_json::json!({"$numberDouble": "5.0"}));
        assert_eq!(
            j["_id"],
            serde_json::json!({"$oid": "6703f1c2a9e41d7c2e0fb812"})
        );
        assert_eq!(doc_from_json(&j).unwrap(), d);
    }

    #[test]
    fn rejects_non_documents() {
        assert!(doc_from_json(&serde_json::json!([1])).is_err());
    }
}
