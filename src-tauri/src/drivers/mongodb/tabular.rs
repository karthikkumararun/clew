//! Documents as grid rows, for console results: the same top-level-keys-as-columns view the
//! Table mode of the collection tab shows, so a console result can be sorted, copied and exported
//! like any other result.

use mongodb::bson::{Bson, Document};

use crate::drivers::{ColumnMeta, Value, ValueKind};

/// Column names: the union of the documents' top-level keys, `_id` first.
pub fn column_names(docs: &[Document]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for d in docs {
        for k in d.keys() {
            if !names.iter().any(|n| n == k) {
                names.push(k.clone());
            }
        }
    }
    if let Some(i) = names.iter().position(|n| n == "_id") {
        let id = names.remove(i);
        names.insert(0, id);
    }
    names
}

pub fn value_of(b: &Bson) -> Value {
    match b {
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::Boolean(v) => Value::Bool { value: *v },
        Bson::Int32(v) => Value::Int { value: *v as i64 },
        Bson::Int64(v) => Value::from_i64(*v),
        Bson::Double(v) => Value::from_f64(*v),
        Bson::Decimal128(v) => Value::decimal(v.to_string()),
        Bson::String(v) => Value::text(v.clone()),
        Bson::ObjectId(v) => Value::text(v.to_hex()),
        Bson::DateTime(v) => v
            .try_to_rfc3339_string()
            .map(|s| Value::Timestamptz { value: s })
            .unwrap_or_else(|_| Value::text(v.to_string())),
        Bson::Document(_) | Bson::Array(_) => Value::json(b.clone().into_relaxed_extjson()),
        other => Value::text(other.clone().into_relaxed_extjson().to_string()),
    }
}

fn kind_of(v: &Value) -> ValueKind {
    match v {
        Value::Bool { .. } => ValueKind::Bool,
        Value::Int { .. } => ValueKind::Int,
        Value::Bigint { .. } => ValueKind::Bigint,
        Value::Float { .. } => ValueKind::Float,
        Value::Decimal { .. } => ValueKind::Decimal,
        Value::Timestamptz { .. } => ValueKind::Timestamptz,
        Value::Json { .. } => ValueKind::Json,
        _ => ValueKind::Text,
    }
}

fn type_name(b: &Bson) -> &'static str {
    super::ejson::type_name(b)
}

/// Column descriptions for `names`: the type is the one the values share, else `mixed`.
pub fn columns(names: &[String], docs: &[Document]) -> Vec<ColumnMeta> {
    names
        .iter()
        .map(|name| {
            let mut types: Vec<&'static str> = Vec::new();
            let mut kind = None;
            for d in docs {
                if let Some(b) = d.get(name) {
                    let t = type_name(b);
                    if !types.contains(&t) {
                        types.push(t);
                    }
                    kind.get_or_insert(kind_of(&value_of(b)));
                }
            }
            let shared = types.len() == 1;
            ColumnMeta {
                name: name.clone(),
                type_name: match types.as_slice() {
                    [] => "null".into(),
                    [one] => (*one).into(),
                    _ => "mixed".into(),
                },
                kind: if shared {
                    kind.unwrap_or(ValueKind::Text)
                } else {
                    ValueKind::Text
                },
                nullable: Some(true),
                source_table: None,
                source_column: None,
                source_schema: None,
                source_updatable: None,
            }
        })
        .collect()
}

pub fn rows(names: &[String], docs: &[Document]) -> Vec<Vec<Value>> {
    docs.iter()
        .map(|d| {
            names
                .iter()
                .map(|n| d.get(n).map_or(Value::Null, value_of))
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, oid::ObjectId};

    #[test]
    fn id_comes_first_then_first_seen_order() {
        let docs = vec![doc! {"a": 1, "_id": 1}, doc! {"b": 2, "a": 1, "_id": 2}];
        assert_eq!(column_names(&docs), ["_id", "a", "b"]);
    }

    #[test]
    fn values_map_to_grid_values() {
        let id = ObjectId::parse_str("6703f1c2a9e41d7c2e0fb812").unwrap();
        let docs = vec![
            doc! {"_id": id, "n": 5_i32, "big": 9_007_199_254_740_993_i64,
            "tags": ["a"], "o": {"k": 1}, "gone": Bson::Null},
        ];
        let names = column_names(&docs);
        let r = &rows(&names, &docs)[0];
        assert_eq!(r[0], Value::text("6703f1c2a9e41d7c2e0fb812"));
        assert_eq!(r[1], Value::Int { value: 5 });
        assert!(matches!(r[2], Value::Bigint { .. }));
        assert!(matches!(r[3], Value::Json { .. }));
        assert!(matches!(r[4], Value::Json { .. }));
        assert_eq!(r[5], Value::Null);
    }

    #[test]
    fn columns_are_typed_by_their_values() {
        let docs = vec![
            doc! {"a": 1, "m": 1},
            doc! {"a": 2, "m": "x"},
            doc! {"a": 3},
        ];
        let names = column_names(&docs);
        let cols = columns(&names, &docs);
        assert_eq!(
            (cols[0].type_name.as_str(), cols[0].kind),
            ("int", ValueKind::Int)
        );
        assert_eq!(
            (cols[1].type_name.as_str(), cols[1].kind),
            ("mixed", ValueKind::Text)
        );
    }
}
