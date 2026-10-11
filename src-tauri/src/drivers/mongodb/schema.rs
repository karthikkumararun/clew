//! Schema inference by sampling: which paths exist, with which types, how often.

use std::collections::{BTreeMap, BTreeSet};

use mongodb::bson::{Bson, Document};

use super::ejson::type_name;
use crate::drivers::nosql::{SchemaField, TypeShare};

#[derive(Default)]
struct Acc {
    docs_with: u64,
    types: BTreeMap<&'static str, u64>,
}

fn walk(prefix: &str, value: &Bson, seen: &mut BTreeSet<String>, acc: &mut BTreeMap<String, Acc>) {
    let ty = type_name(value);
    acc.entry(prefix.to_string())
        .or_default()
        .types
        .entry(ty)
        .and_modify(|n| *n += 1)
        .or_insert(1);
    seen.insert(prefix.to_string());
    match value {
        Bson::Document(d) => {
            for (k, v) in d {
                walk(&format!("{prefix}.{k}"), v, seen, acc);
            }
        }
        Bson::Array(items) => {
            for v in items {
                walk(&format!("{prefix}.[]"), v, seen, acc);
            }
        }
        _ => {}
    }
}

pub fn infer(docs: &[Document]) -> Vec<SchemaField> {
    let mut acc: BTreeMap<String, Acc> = BTreeMap::new();
    for d in docs {
        let mut seen = BTreeSet::new();
        for (k, v) in d {
            walk(k, v, &mut seen, &mut acc);
        }
        for p in seen {
            acc.entry(p).or_default().docs_with += 1;
        }
    }
    let total = docs.len().max(1) as f64;
    let mut out: Vec<SchemaField> = acc
        .into_iter()
        .map(|(path, a)| {
            let occurrences: u64 = a.types.values().sum();
            let mut types: Vec<TypeShare> = a
                .types
                .into_iter()
                .map(|(t, n)| TypeShare {
                    type_name: t.to_string(),
                    percent: round1(n as f64 * 100.0 / occurrences.max(1) as f64),
                })
                .collect();
            types.sort_by(|a, b| {
                b.percent
                    .total_cmp(&a.percent)
                    .then(a.type_name.cmp(&b.type_name))
            });
            SchemaField {
                path,
                types,
                present_percent: round1(a.docs_with as f64 * 100.0 / total),
            }
        })
        .collect();
    // `_id` first, then document order by path, which keeps children under their parents.
    out.sort_by(|a, b| (a.path != "_id", &a.path).cmp(&(b.path != "_id", &b.path)));
    out
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[test]
    fn counts_types_and_presence() {
        let docs = vec![
            doc! {"_id": 1, "a": "x", "tags": ["p", "q"], "o": {"k": 1}},
            doc! {"_id": 2, "a": 5, "o": {"k": null}},
            doc! {"_id": 3, "a": "y"},
            doc! {"_id": 4, "a": "z"},
        ];
        let f = infer(&docs);
        assert_eq!(f[0].path, "_id");
        let a = f.iter().find(|f| f.path == "a").unwrap();
        assert_eq!(a.present_percent, 100.0);
        assert_eq!(a.types[0].type_name, "string");
        assert_eq!(a.types[0].percent, 75.0);
        assert_eq!(a.types[1].type_name, "int");
        let k = f.iter().find(|f| f.path == "o.k").unwrap();
        assert_eq!(k.present_percent, 50.0);
        assert_eq!(k.types.len(), 2);
        let t = f.iter().find(|f| f.path == "tags.[]").unwrap();
        assert_eq!(t.types[0].type_name, "string");
        assert_eq!(t.present_percent, 25.0);
        assert_eq!(
            f.iter().find(|f| f.path == "tags").unwrap().types[0].type_name,
            "array"
        );
    }
}
