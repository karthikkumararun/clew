//! SQLite values are dynamically typed: each value carries its own storage class
//! (INTEGER, REAL, TEXT, BLOB, NULL), so decoding follows the value, not the column.

use crate::drivers::{Value, ValueKind};

/// Storage class names as reported by sqlx for a value.
pub fn decode_by_class(
    class: &str,
    int: Option<i64>,
    real: Option<f64>,
    bytes: Option<&[u8]>,
    declared: &str,
    truncate: bool,
) -> Value {
    match class {
        "NULL" => Value::Null,
        "INTEGER" | "INT4" | "INT8" | "BOOLEAN" => match int {
            Some(v) if declared.eq_ignore_ascii_case("BOOLEAN") && (v == 0 || v == 1) => {
                Value::Bool { value: v == 1 }
            }
            Some(v) => Value::from_i64(v),
            None => Value::Null,
        },
        "REAL" => match real {
            Some(f) if f.is_finite() => Value::from_f64(f),
            Some(f) if f.is_nan() => Value::other("NaN", "REAL"),
            Some(f) if f > 0.0 => Value::other("Infinity", "REAL"),
            Some(_) => Value::other("-Infinity", "REAL"),
            None => Value::Null,
        },
        "BLOB" => match bytes {
            Some(b) if truncate => Value::bytes(b),
            Some(b) => Value::bytes_full(b),
            None => Value::Null,
        },
        // TEXT, DATE/TIME/DATETIME stored as text, NUMERIC stored as text, ...
        _ => match bytes {
            Some(b) => {
                let t = String::from_utf8_lossy(b).into_owned();
                if truncate {
                    Value::text(t)
                } else {
                    Value::text_full(t)
                }
            }
            None => Value::Null,
        },
    }
}

/// Coarse kind from the column's declared type (what the grid knows before any row arrives).
pub fn kind_for_declared(declared: &str) -> ValueKind {
    match declared.to_ascii_uppercase().as_str() {
        "BOOLEAN" | "BOOL" => ValueKind::Bool,
        "INTEGER" | "INT" | "INT4" | "INT8" | "SMALLINT" | "TINYINT" | "MEDIUMINT" => {
            ValueKind::Int
        }
        "BIGINT" => ValueKind::Bigint,
        "REAL" | "FLOAT" | "DOUBLE" => ValueKind::Float,
        "NUMERIC" | "DECIMAL" => ValueKind::Decimal,
        "TEXT" | "CLOB" | "VARCHAR" | "CHAR" => ValueKind::Text,
        "BLOB" => ValueKind::Bytes,
        "DATE" => ValueKind::Date,
        "TIME" => ValueKind::Time,
        "DATETIME" | "TIMESTAMP" => ValueKind::Timestamp,
        _ => ValueKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn int(v: i64) -> Value {
        decode_by_class("INTEGER", Some(v), None, None, "INTEGER", true)
    }

    #[test]
    fn the_storage_class_of_each_value_decides() {
        assert_eq!(int(42), Value::Int { value: 42 });
        assert_eq!(
            decode_by_class("REAL", None, Some(1.5), None, "REAL", true),
            Value::Float { value: 1.5 }
        );
        assert_eq!(
            decode_by_class("TEXT", None, None, Some(b"h\xc3\xa9llo"), "TEXT", true),
            Value::text("héllo")
        );
        assert_eq!(
            decode_by_class("BLOB", None, None, Some(&[0xde, 0xad]), "BLOB", true),
            Value::bytes(&[0xde, 0xad])
        );
        assert_eq!(
            decode_by_class("NULL", None, None, None, "", true),
            Value::Null
        );
    }

    #[test]
    fn a_column_can_hold_mixed_types_and_each_value_keeps_its_own() {
        // SQLite does not enforce declared types
        assert_eq!(
            decode_by_class("TEXT", None, None, Some(b"abc"), "INTEGER", true),
            Value::text("abc")
        );
        assert_eq!(
            decode_by_class("INTEGER", Some(7), None, None, "TEXT", true),
            Value::Int { value: 7 }
        );
    }

    #[test]
    fn integers_beyond_js_safe_range_become_bigint_strings() {
        assert_eq!(
            int(9_007_199_254_740_993),
            Value::Bigint {
                value: "9007199254740993".into()
            }
        );
        assert_eq!(
            int(i64::MIN),
            Value::Bigint {
                value: i64::MIN.to_string()
            }
        );
    }

    #[test]
    fn declared_booleans_hold_0_and_1() {
        assert_eq!(
            decode_by_class("INTEGER", Some(1), None, None, "BOOLEAN", true),
            Value::Bool { value: true }
        );
        assert_eq!(
            decode_by_class("INTEGER", Some(0), None, None, "boolean", true),
            Value::Bool { value: false }
        );
        // anything else in a BOOLEAN column stays an integer
        assert_eq!(
            decode_by_class("INTEGER", Some(2), None, None, "BOOLEAN", true),
            Value::Int { value: 2 }
        );
    }

    #[test]
    fn non_finite_reals_become_other() {
        assert_eq!(
            decode_by_class("REAL", None, Some(f64::INFINITY), None, "REAL", true),
            Value::other("Infinity", "REAL")
        );
        assert_eq!(
            decode_by_class("REAL", None, Some(f64::NEG_INFINITY), None, "REAL", true),
            Value::other("-Infinity", "REAL")
        );
    }

    #[test]
    fn large_values_truncate_unless_asked_not_to() {
        let big = vec![b'x'; 2 * 1024 * 1024];
        assert!(decode_by_class("TEXT", None, None, Some(&big), "TEXT", true).is_read_only());
        let Value::Text { value, truncated } =
            decode_by_class("TEXT", None, None, Some(&big), "TEXT", false)
        else {
            panic!()
        };
        assert!(!truncated);
        assert_eq!(value.len(), big.len());
    }

    #[test]
    fn declared_types_give_kinds() {
        assert_eq!(kind_for_declared("integer"), ValueKind::Int);
        assert_eq!(kind_for_declared("BIGINT"), ValueKind::Bigint);
        assert_eq!(kind_for_declared("DATETIME"), ValueKind::Timestamp);
        assert_eq!(kind_for_declared(""), ValueKind::Other);
    }
}
