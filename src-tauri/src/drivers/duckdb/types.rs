//! Mapping DuckDB's types to the value model.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime};
use duckdb::core::LogicalTypeId as Id;
use duckdb::types::{TimeUnit, Value as D};

use crate::drivers::{Value, ValueKind};

/// How a column's values are drawn and edited.
pub fn kind_of(id: Id) -> ValueKind {
    match id {
        Id::Boolean => ValueKind::Bool,
        Id::Tinyint | Id::Smallint | Id::Integer | Id::UTinyint | Id::USmallint | Id::UInteger => {
            ValueKind::Int
        }
        Id::Bigint | Id::UBigint | Id::Hugeint | Id::UHugeint | Id::Bignum => ValueKind::Bigint,
        Id::Float | Id::Double => ValueKind::Float,
        Id::Decimal => ValueKind::Decimal,
        Id::Varchar | Id::Enum | Id::StringLiteral => ValueKind::Text,
        Id::Blob | Id::Bit | Id::Geometry => ValueKind::Bytes,
        Id::Date => ValueKind::Date,
        Id::Time | Id::TimeTZ | Id::TimeNs => ValueKind::Time,
        Id::Timestamp | Id::TimestampS | Id::TimestampMs | Id::TimestampNs => ValueKind::Timestamp,
        Id::TimestampTZ => ValueKind::Timestamptz,
        Id::Interval => ValueKind::Interval,
        Id::Uuid => ValueKind::Uuid,
        Id::List | Id::Array => ValueKind::Array,
        Id::Struct | Id::Map => ValueKind::Json,
        _ => ValueKind::Other,
    }
}

/// DuckDB's own name for the type (`BIGINT`, `TIMESTAMP WITH TIME ZONE`, ...).
pub fn type_name(id: Id, decimal: Option<(u8, u8)>) -> String {
    match id {
        Id::Decimal => match decimal {
            Some((w, s)) => format!("DECIMAL({w},{s})"),
            None => "DECIMAL".into(),
        },
        Id::UTinyint => "UTINYINT".into(),
        Id::USmallint => "USMALLINT".into(),
        Id::UInteger => "UINTEGER".into(),
        Id::UBigint => "UBIGINT".into(),
        Id::UHugeint => "UHUGEINT".into(),
        Id::TimestampS => "TIMESTAMP_S".into(),
        Id::TimestampMs => "TIMESTAMP_MS".into(),
        Id::TimestampNs => "TIMESTAMP_NS".into(),
        Id::TimestampTZ => "TIMESTAMP WITH TIME ZONE".into(),
        Id::TimeTZ => "TIME WITH TIME ZONE".into(),
        other => format!("{other:?}").to_ascii_uppercase(),
    }
}

fn epoch() -> NaiveDateTime {
    DateTime::from_timestamp(0, 0).expect("epoch").naive_utc()
}

fn at_unit(unit: TimeUnit, v: i64) -> Duration {
    match unit {
        TimeUnit::Second => Duration::seconds(v),
        TimeUnit::Millisecond => Duration::milliseconds(v),
        TimeUnit::Microsecond => Duration::microseconds(v),
        TimeUnit::Nanosecond => Duration::nanoseconds(v),
    }
}

fn interval_text(months: i32, days: i32, nanos: i64) -> String {
    let mut parts = Vec::new();
    if months != 0 {
        let (y, m) = (months / 12, months % 12);
        if y != 0 {
            parts.push(format!(
                "{y} {}",
                if y.abs() == 1 { "year" } else { "years" }
            ));
        }
        if m != 0 {
            parts.push(format!("{m} {}", if m.abs() == 1 { "mon" } else { "mons" }));
        }
    }
    if days != 0 {
        parts.push(format!(
            "{days} {}",
            if days.abs() == 1 { "day" } else { "days" }
        ));
    }
    if nanos != 0 || parts.is_empty() {
        let sign = if nanos < 0 { "-" } else { "" };
        let n = nanos.unsigned_abs();
        let secs = n / 1_000_000_000;
        let frac = n % 1_000_000_000;
        let mut t = format!(
            "{sign}{:02}:{:02}:{:02}",
            secs / 3600,
            (secs / 60) % 60,
            secs % 60
        );
        if frac != 0 {
            let digits = format!("{frac:09}");
            t.push('.');
            t.push_str(digits.trim_end_matches('0'));
        }
        parts.push(t);
    }
    parts.join(" ")
}

/// A JSON form for nested values (struct, map), where the grid shows text.
fn json_of(v: &D) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        D::Null => J::Null,
        D::Boolean(b) => J::Bool(*b),
        D::TinyInt(n) => J::from(*n),
        D::SmallInt(n) => J::from(*n),
        D::Int(n) => J::from(*n),
        D::BigInt(n) => J::from(*n),
        D::UTinyInt(n) => J::from(*n),
        D::USmallInt(n) => J::from(*n),
        D::UInt(n) => J::from(*n),
        D::UBigInt(n) => J::from(*n),
        D::HugeInt(n) => J::String(n.to_string()),
        D::UHugeInt(n) => J::String(n.to_string()),
        D::Float(f) => serde_json::Number::from_f64(*f as f64).map_or(J::Null, J::Number),
        D::Double(f) => serde_json::Number::from_f64(*f).map_or(J::Null, J::Number),
        D::Decimal(d) => J::String(d.to_string()),
        D::Text(s) | D::Enum(s) => J::String(s.clone()),
        D::List(items) | D::Array(items) => J::Array(items.iter().map(json_of).collect()),
        D::Struct(map) => J::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), json_of(v)))
                .collect::<serde_json::Map<_, _>>(),
        ),
        D::Map(map) => J::Object(
            map.iter()
                .map(|(k, v)| {
                    let key = match json_of(k) {
                        J::String(s) => s,
                        other => other.to_string(),
                    };
                    (key, json_of(v))
                })
                .collect::<serde_json::Map<_, _>>(),
        ),
        D::Union(inner) => json_of(inner),
        other => match to_value(other.clone(), None) {
            Value::Text { value, .. }
            | Value::Date { value }
            | Value::Time { value }
            | Value::Timestamp { value }
            | Value::Timestamptz { value }
            | Value::Interval { value } => J::String(value),
            _ => J::Null,
        },
    }
}

/// A result cell. `id` is the column's logical type, which tells apart values that arrive in the
/// same shape (a TIMESTAMPTZ and a TIMESTAMP are both microseconds; a UUID is text).
pub fn to_value(v: D, id: Option<Id>) -> Value {
    match v {
        D::Null => Value::Null,
        D::Boolean(b) => Value::Bool { value: b },
        D::TinyInt(n) => Value::from_i64(n.into()),
        D::SmallInt(n) => Value::from_i64(n.into()),
        D::Int(n) => Value::from_i64(n.into()),
        D::BigInt(n) => Value::from_i64(n),
        D::HugeInt(n) => Value::from_i128(n),
        D::UHugeInt(n) => match i64::try_from(n) {
            Ok(i) => Value::from_i64(i),
            Err(_) => Value::Bigint {
                value: n.to_string(),
            },
        },
        D::UTinyInt(n) => Value::from_i64(n.into()),
        D::USmallInt(n) => Value::from_i64(n.into()),
        D::UInt(n) => Value::from_i64(n.into()),
        D::UBigInt(n) => Value::from_u64(n),
        D::Float(f) => Value::from_f64(f as f64),
        D::Double(f) => Value::from_f64(f),
        D::Decimal(d) => Value::decimal(d.to_string()),
        D::Timestamp(unit, v) => {
            let t = epoch() + at_unit(unit, v);
            if id == Some(Id::TimestampTZ) {
                Value::timestamptz(t.and_utc())
            } else {
                Value::timestamp(t)
            }
        }
        D::Text(s) => match id {
            Some(Id::Uuid) => Value::Uuid { value: s },
            _ => Value::text(s),
        },
        D::Enum(s) => Value::text(s),
        D::Blob(b) | D::Geometry(b) => Value::bytes(&b),
        D::Date32(days) => {
            let d =
                NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch") + Duration::days(days.into());
            Value::date(d)
        }
        D::Time64(unit, v) => {
            let t = NaiveTime::MIN + at_unit(unit, v);
            Value::time(t)
        }
        D::Interval {
            months,
            days,
            nanos,
        } => Value::Interval {
            value: interval_text(months, days, nanos),
        },
        D::List(items) | D::Array(items) => Value::Array {
            value: items.into_iter().map(|i| to_value(i, None)).collect(),
        },
        D::Struct(_) | D::Map(_) => Value::json(json_of(&v)),
        D::Union(inner) => to_value(*inner, None),
        other => Value::other(format!("{other:?}"), "duckdb"),
    }
}

/// A value the table editor wants to write, as DuckDB binds it.
pub fn to_param(v: &Value) -> D {
    match v {
        Value::Null => D::Null,
        Value::Bool { value } => D::Boolean(*value),
        Value::Int { value } => D::BigInt(*value),
        Value::Float { value } => D::Double(*value),
        Value::Bytes { value, .. } => D::Blob(crate::drivers::value::unhex(value)),
        other => other.sql_text().map_or(D::Null, D::Text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_beyond_js_range_become_bigint_strings() {
        assert_eq!(to_value(D::BigInt(5), None), Value::Int { value: 5 });
        assert_eq!(
            to_value(
                D::HugeInt(170141183460469231731687303715884105727),
                Some(Id::Hugeint)
            ),
            Value::Bigint {
                value: "170141183460469231731687303715884105727".into()
            }
        );
        assert_eq!(
            to_value(D::UBigInt(u64::MAX), None),
            Value::Bigint {
                value: u64::MAX.to_string()
            }
        );
        assert_eq!(
            to_value(D::UHugeInt(u128::MAX), None),
            Value::Bigint {
                value: u128::MAX.to_string()
            }
        );
    }

    #[test]
    fn timestamps_dates_and_times() {
        assert_eq!(
            to_value(
                D::Timestamp(TimeUnit::Microsecond, 1_767_323_045_000_000),
                Some(Id::Timestamp)
            ),
            Value::Timestamp {
                value: "2026-01-02T03:04:05".into()
            }
        );
        assert_eq!(
            to_value(
                D::Timestamp(TimeUnit::Microsecond, 1_767_323_045_000_000),
                Some(Id::TimestampTZ)
            ),
            Value::Timestamptz {
                value: "2026-01-02T03:04:05Z".into()
            }
        );
        assert_eq!(
            to_value(
                D::Timestamp(TimeUnit::Millisecond, 1_000),
                Some(Id::TimestampMs)
            ),
            Value::Timestamp {
                value: "1970-01-01T00:00:01".into()
            }
        );
        assert_eq!(
            to_value(D::Date32(20455), None),
            Value::Date {
                value: "2026-01-02".into()
            }
        );
        assert_eq!(
            to_value(D::Time64(TimeUnit::Microsecond, 11_045_000_000), None),
            Value::Time {
                value: "03:04:05".into()
            }
        );
    }

    #[test]
    fn intervals_read_like_text() {
        let i = |months, days, nanos| match to_value(
            D::Interval {
                months,
                days,
                nanos,
            },
            None,
        ) {
            Value::Interval { value } => value,
            other => panic!("{other:?}"),
        };
        assert_eq!(i(0, 3, 0), "3 days");
        assert_eq!(i(14, 1, 0), "1 year 2 mons 1 day");
        assert_eq!(i(0, 0, 3_723_000_000_000), "01:02:03");
        assert_eq!(i(0, 0, 1_500_000_000), "00:00:01.5");
        assert_eq!(i(0, 0, 0), "00:00:00");
    }

    #[test]
    fn uuids_lists_structs_and_maps() {
        assert_eq!(
            to_value(
                D::Text("123e4567-e89b-12d3-a456-426614174000".into()),
                Some(Id::Uuid)
            ),
            Value::Uuid {
                value: "123e4567-e89b-12d3-a456-426614174000".into()
            }
        );
        assert_eq!(
            to_value(D::List(vec![D::Int(1), D::Null]), Some(Id::List)),
            Value::Array {
                value: vec![Value::Int { value: 1 }, Value::Null]
            }
        );
        let s = D::Struct(
            vec![
                ("a".to_string(), D::Int(1)),
                ("b".to_string(), D::Text("x".into())),
            ]
            .into(),
        );
        assert_eq!(
            to_value(s, Some(Id::Struct)),
            Value::json(serde_json::json!({"a": 1, "b": "x"}))
        );
        let m = D::Map(vec![(D::Text("k".into()), D::Int(1))].into());
        assert_eq!(
            to_value(m, Some(Id::Map)),
            Value::json(serde_json::json!({"k": 1}))
        );
    }

    #[test]
    fn decimals_stay_exact_and_blobs_are_hex() {
        let d = duckdb::types::Decimal::new(10, 2, 1250).unwrap();
        assert_eq!(
            to_value(D::Decimal(d), None),
            Value::Decimal {
                value: "12.50".into()
            }
        );
        assert_eq!(
            to_value(D::Blob(vec![0xde, 0xad]), None),
            Value::Bytes {
                value: "dead".into(),
                len: 2,
                truncated: false
            }
        );
    }

    #[test]
    fn kinds_and_names() {
        assert_eq!(kind_of(Id::Hugeint), ValueKind::Bigint);
        assert_eq!(kind_of(Id::Uuid), ValueKind::Uuid);
        assert_eq!(kind_of(Id::TimestampTZ), ValueKind::Timestamptz);
        assert_eq!(kind_of(Id::Map), ValueKind::Json);
        assert_eq!(type_name(Id::Bigint, None), "BIGINT");
        assert_eq!(type_name(Id::Decimal, Some((10, 2))), "DECIMAL(10,2)");
        assert_eq!(type_name(Id::TimestampTZ, None), "TIMESTAMP WITH TIME ZONE");
    }
}
