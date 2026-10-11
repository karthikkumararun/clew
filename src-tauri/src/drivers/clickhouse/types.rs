//! Mapping ClickHouse column types and their JSON values to the value model.
//!
//! Rows arrive as `JSONCompactEachRowWithNamesAndTypes`: 64-bit integers and decimals are quoted
//! strings (so nothing is rounded on the way), everything else is a JSON scalar or container.

use serde_json::Value as J;

use crate::drivers::{Value, ValueKind};

/// `Nullable(T)` and `LowCardinality(T)` wrap a type without changing what its values are.
pub fn unwrap_type(t: &str) -> &str {
    let t = t.trim();
    for wrapper in ["Nullable(", "LowCardinality("] {
        if let Some(inner) = t.strip_prefix(wrapper).and_then(|r| r.strip_suffix(')')) {
            return unwrap_type(inner);
        }
    }
    t
}

pub fn is_nullable(t: &str) -> bool {
    let t = t.trim();
    t.starts_with("Nullable(")
        || t.strip_prefix("LowCardinality(")
            .is_some_and(|r| r.starts_with("Nullable("))
}

/// The element type of `Array(T)`.
fn array_inner(t: &str) -> Option<&str> {
    unwrap_type(t).strip_prefix("Array(")?.strip_suffix(')')
}

pub fn kind_of(t: &str) -> ValueKind {
    let t = unwrap_type(t);
    if t.starts_with("Array(") {
        return ValueKind::Array;
    }
    if t.starts_with("Decimal") {
        return ValueKind::Decimal;
    }
    if t.starts_with("DateTime64") {
        return ValueKind::Timestamp;
    }
    if t.starts_with("DateTime") {
        return ValueKind::Timestamp;
    }
    if t.starts_with("Enum") || t.starts_with("FixedString") {
        return ValueKind::Text;
    }
    if t.starts_with("Tuple(")
        || t.starts_with("Map(")
        || t.starts_with("Nested(")
        || t == "JSON"
        || t.starts_with("Object(")
    {
        return ValueKind::Json;
    }
    match t {
        "Bool" => ValueKind::Bool,
        "UInt8" | "UInt16" | "UInt32" | "Int8" | "Int16" | "Int32" => ValueKind::Int,
        "UInt64" | "Int64" | "UInt128" | "Int128" | "UInt256" | "Int256" => ValueKind::Bigint,
        "Float32" | "Float64" => ValueKind::Float,
        "String" | "IPv4" | "IPv6" => ValueKind::Text,
        "Date" | "Date32" => ValueKind::Date,
        "UUID" => ValueKind::Uuid,
        _ => ValueKind::Other,
    }
}

/// `2026-01-02 03:04:05.123` → `2026-01-02T03:04:05.123`
fn iso_timestamp(s: &str) -> String {
    s.replacen(' ', "T", 1)
}

fn number_or_string(v: &J) -> Option<String> {
    match v {
        J::String(s) => Some(s.clone()),
        J::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The scale of `Decimal(P, S)` / `Decimal64(S)`.
fn decimal_scale(t: &str) -> Option<usize> {
    let args = t.strip_prefix("Decimal")?;
    let args = args.trim_start_matches(|c: char| c.is_ascii_digit());
    let inside = args.strip_prefix('(')?.strip_suffix(')')?;
    inside.rsplit(',').next()?.trim().parse().ok()
}

/// ClickHouse prints `12.5` for a `Decimal(18, 2)`; show the digits the column stores.
fn pad_scale(text: &str, scale: Option<usize>) -> String {
    let Some(scale) = scale.filter(|s| *s > 0) else {
        return text.to_string();
    };
    match text.split_once('.') {
        Some((int, frac)) if frac.len() < scale => format!("{int}.{frac:0<scale$}"),
        None if !text.is_empty() => format!("{text}.{}", "0".repeat(scale)),
        _ => text.to_string(),
    }
}

pub fn to_value(ty: &str, v: &J) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    let t = unwrap_type(ty);
    if let Some(inner) = array_inner(ty) {
        return match v {
            J::Array(items) => Value::Array {
                value: items.iter().map(|i| to_value(inner, i)).collect(),
            },
            other => Value::json(other.clone()),
        };
    }
    match kind_of(ty) {
        ValueKind::Bool => match v {
            J::Bool(b) => Value::Bool { value: *b },
            other => Value::text(number_or_string(other).unwrap_or_default()),
        },
        ValueKind::Int => v.as_i64().map_or_else(
            || Value::text(number_or_string(v).unwrap_or_default()),
            Value::from_i64,
        ),
        ValueKind::Bigint => match number_or_string(v) {
            Some(s) => match s.parse::<i64>() {
                Ok(n) => Value::from_i64(n),
                Err(_) => Value::Bigint { value: s },
            },
            None => Value::Null,
        },
        ValueKind::Float => match v {
            J::Number(n) => Value::from_f64(n.as_f64().unwrap_or(f64::NAN)),
            // "nan", "inf" and "-inf" arrive as strings
            J::String(s) => Value::from_f64(match s.as_str() {
                "inf" => f64::INFINITY,
                "-inf" => f64::NEG_INFINITY,
                _ => s.parse().unwrap_or(f64::NAN),
            }),
            _ => Value::Null,
        },
        ValueKind::Decimal => Value::decimal(pad_scale(
            &number_or_string(v).unwrap_or_default(),
            decimal_scale(t),
        )),
        ValueKind::Date => Value::Date {
            value: number_or_string(v).unwrap_or_default(),
        },
        ValueKind::Timestamp => Value::Timestamp {
            value: iso_timestamp(&number_or_string(v).unwrap_or_default()),
        },
        ValueKind::Uuid => Value::Uuid {
            value: number_or_string(v).unwrap_or_default(),
        },
        ValueKind::Json => Value::json(v.clone()),
        ValueKind::Text => Value::text(number_or_string(v).unwrap_or_else(|| v.to_string())),
        _ => Value::other(number_or_string(v).unwrap_or_else(|| v.to_string()), t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wrappers_do_not_change_the_kind() {
        assert_eq!(unwrap_type("Nullable(Int32)"), "Int32");
        assert_eq!(unwrap_type("LowCardinality(Nullable(String))"), "String");
        assert!(is_nullable("Nullable(Int32)") && is_nullable("LowCardinality(Nullable(String))"));
        assert!(!is_nullable("Int32") && !is_nullable("LowCardinality(String)"));
        assert_eq!(kind_of("LowCardinality(String)"), ValueKind::Text);
        assert_eq!(kind_of("Nullable(DateTime64(3))"), ValueKind::Timestamp);
        assert_eq!(kind_of("Decimal(18, 2)"), ValueKind::Decimal);
        assert_eq!(kind_of("Array(Nullable(Int32))"), ValueKind::Array);
        assert_eq!(kind_of("Map(String, UInt8)"), ValueKind::Json);
        assert_eq!(kind_of("Tuple(UInt8, String)"), ValueKind::Json);
        assert_eq!(kind_of("UInt64"), ValueKind::Bigint);
        assert_eq!(kind_of("Enum8('a' = 1)"), ValueKind::Text);
        assert_eq!(kind_of("SomethingNew"), ValueKind::Other);
    }

    #[test]
    fn numbers_stay_exact() {
        assert_eq!(to_value("UInt8", &json!(5)), Value::Int { value: 5 });
        assert_eq!(to_value("Int64", &json!("42")), Value::Int { value: 42 });
        assert_eq!(
            to_value("UInt64", &json!("18446744073709551615")),
            Value::Bigint {
                value: "18446744073709551615".into()
            }
        );
        assert_eq!(
            to_value("UInt256", &json!("115792089237316195423570985008687907853269984665640564039457584007913129639935")),
            Value::Bigint { value: "115792089237316195423570985008687907853269984665640564039457584007913129639935".into() }
        );
        assert_eq!(
            to_value("Decimal(18, 2)", &json!("12.50")),
            Value::Decimal {
                value: "12.50".into()
            }
        );
        assert_eq!(
            to_value("Float64", &json!(1.5)),
            Value::Float { value: 1.5 }
        );
        assert_eq!(
            to_value("Float64", &json!("inf")),
            Value::Float {
                value: f64::INFINITY
            }
        );
        assert!(
            matches!(to_value("Float32", &json!("nan")), Value::Float { value } if value.is_nan())
        );
    }

    #[test]
    fn decimals_show_their_declared_scale() {
        let d = |ty: &str, v: &str| to_value(ty, &json!(v));
        assert_eq!(
            d("Decimal(18, 2)", "12.5"),
            Value::Decimal {
                value: "12.50".into()
            }
        );
        assert_eq!(
            d("Decimal64(3)", "7"),
            Value::Decimal {
                value: "7.000".into()
            }
        );
        assert_eq!(
            d("Decimal(9, 0)", "7"),
            Value::Decimal { value: "7".into() }
        );
        assert_eq!(
            d("Nullable(Decimal(18, 2))", "-0.1"),
            Value::Decimal {
                value: "-0.10".into()
            }
        );
    }

    #[test]
    fn nulls_and_text() {
        assert_eq!(to_value("Nullable(Int32)", &J::Null), Value::Null);
        assert_eq!(
            to_value("LowCardinality(String)", &json!("x")),
            Value::text("x")
        );
        assert_eq!(to_value("Bool", &json!(true)), Value::Bool { value: true });
        assert_eq!(to_value("Enum8('a' = 1)", &json!("a")), Value::text("a"));
    }

    #[test]
    fn dates_and_times() {
        assert_eq!(
            to_value("Date", &json!("2026-01-02")),
            Value::Date {
                value: "2026-01-02".into()
            }
        );
        assert_eq!(
            to_value("DateTime64(3)", &json!("2026-01-02 03:04:05.123")),
            Value::Timestamp {
                value: "2026-01-02T03:04:05.123".into()
            }
        );
        assert_eq!(
            to_value("DateTime('UTC')", &json!("2026-01-02 03:04:05")),
            Value::Timestamp {
                value: "2026-01-02T03:04:05".into()
            }
        );
        assert_eq!(
            to_value("UUID", &json!("123e4567-e89b-12d3-a456-426614174000")),
            Value::Uuid {
                value: "123e4567-e89b-12d3-a456-426614174000".into()
            }
        );
    }

    #[test]
    fn containers() {
        assert_eq!(
            to_value("Array(UInt8)", &json!([1, 2])),
            Value::Array {
                value: vec![Value::Int { value: 1 }, Value::Int { value: 2 }]
            }
        );
        assert_eq!(
            to_value("Array(Nullable(String))", &json!(["a", null])),
            Value::Array {
                value: vec![Value::text("a"), Value::Null]
            }
        );
        assert_eq!(
            to_value("Tuple(UInt8, String)", &json!([1, "x"])),
            Value::json(json!([1, "x"]))
        );
        assert_eq!(
            to_value("Map(String, UInt8)", &json!({"k": 1})),
            Value::json(json!({"k": 1}))
        );
    }
}
