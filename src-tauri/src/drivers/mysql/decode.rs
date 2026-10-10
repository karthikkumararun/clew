//! Decoding MySQL/MariaDB values. Results are fetched over the text protocol, so every value
//! arrives as the server's own text (or raw bytes for binary columns); that keeps decimals exact
//! and lets zero dates through as text instead of failing.

use crate::drivers::{Value, ValueKind};

/// Coarse kind from the sqlx type name (`BIGINT UNSIGNED`, `DATETIME`, ...).
pub fn kind_for_type(name: &str) -> ValueKind {
    let n = name.to_ascii_uppercase();
    match n.as_str() {
        "BOOLEAN" => ValueKind::Bool,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "TINYINT UNSIGNED" | "SMALLINT UNSIGNED"
        | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "YEAR" | "BIT" => ValueKind::Int,
        "BIGINT" | "BIGINT UNSIGNED" => ValueKind::Bigint,
        "FLOAT" | "DOUBLE" => ValueKind::Float,
        "DECIMAL" => ValueKind::Decimal,
        "DATE" => ValueKind::Date,
        "TIME" => ValueKind::Time,
        "DATETIME" => ValueKind::Timestamp,
        "TIMESTAMP" => ValueKind::Timestamptz,
        "JSON" => ValueKind::Json,
        "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            ValueKind::Text
        }
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            ValueKind::Bytes
        }
        _ => ValueKind::Other,
    }
}

/// The collation number sqlx keeps privately, read from the type info's `Debug` output
/// (`... collation: Collation(63) ...`). 63 is the `binary` charset, i.e. real binary data.
pub fn collation_number(debug: &str) -> Option<u16> {
    let start = debug.find("collation: Collation(")? + "collation: Collation(".len();
    let rest = &debug[start..];
    rest[..rest.find(')')?].trim().parse().ok()
}

/// sqlx names a column `BLOB`/`VARBINARY`/... whenever the BINARY flag is set, but the flag is also
/// set for text columns with a `_bin` collation (and MariaDB's JSON). Only charset 63 is truly
/// binary, so rename the others to their text counterparts.
pub fn effective_type_name(sqlx_name: &str, debug: &str) -> String {
    let text_name = match sqlx_name {
        "BINARY" => "CHAR",
        "VARBINARY" => "VARCHAR",
        "TINYBLOB" => "TINYTEXT",
        "BLOB" => "TEXT",
        "MEDIUMBLOB" => "MEDIUMTEXT",
        "LONGBLOB" => "LONGTEXT",
        other => return other.to_string(),
    };
    match collation_number(debug) {
        Some(63) | None => sqlx_name.to_string(),
        Some(_) => text_name.to_string(),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::from("0x");
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

fn other(text: impl Into<String>, type_name: &str) -> Value {
    Value::other(text, type_name)
}

/// `0000-00-00`, `2020-00-15` and friends cannot be represented as real dates.
fn is_invalid_date(date: &str) -> bool {
    let mut parts = date.split('-');
    let (y, m, d) = (parts.next(), parts.next(), parts.next());
    match (y, m, d) {
        (Some(y), Some(m), Some(d)) => y == "0000" || m == "00" || d == "00",
        _ => true,
    }
}

fn integer(text: &str, type_name: &str) -> Value {
    if let Ok(v) = text.parse::<i64>() {
        Value::from_i64(v)
    } else if let Ok(v) = text.parse::<u64>() {
        Value::from_u64(v)
    } else {
        other(text, type_name)
    }
}

/// Decode a value fetched over the text protocol. `truncate = false` keeps large text and blob
/// values whole (used when fetching one cell on demand).
pub fn decode_text(type_name: &str, bytes: &[u8], truncate: bool) -> Value {
    let name = type_name.to_ascii_uppercase();
    let lossy = || String::from_utf8_lossy(bytes).into_owned();
    match name.as_str() {
        "BOOLEAN" => match bytes {
            b"0" => Value::Bool { value: false },
            b"1" => Value::Bool { value: true },
            _ => integer(&lossy(), type_name),
        },
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "TINYINT UNSIGNED"
        | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED"
        | "YEAR" => integer(&lossy(), type_name),
        // BIT arrives as raw big-endian bytes
        "BIT" => {
            if bytes.len() > 8 {
                other(hex(bytes), type_name)
            } else {
                Value::from_u64(bytes.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64))
            }
        }
        "FLOAT" | "DOUBLE" => match lossy().parse::<f64>() {
            Ok(f) if f.is_finite() => Value::from_f64(f),
            _ => other(lossy(), type_name),
        },
        "DECIMAL" => Value::decimal(lossy()),
        "DATE" => {
            let t = lossy();
            if is_invalid_date(&t) {
                other(t, type_name)
            } else {
                Value::Date { value: t }
            }
        }
        "DATETIME" | "TIMESTAMP" => {
            let t = lossy();
            let (date, time) = t.split_once(' ').unwrap_or((t.as_str(), ""));
            if is_invalid_date(date) {
                other(t, type_name)
            } else if name == "TIMESTAMP" {
                // sessions run in UTC
                Value::Timestamptz {
                    value: format!(
                        "{date}T{}Z",
                        if time.is_empty() { "00:00:00" } else { time }
                    ),
                }
            } else {
                Value::Timestamp {
                    value: format!("{date}T{}", if time.is_empty() { "00:00:00" } else { time }),
                }
            }
        }
        "TIME" => {
            let t = lossy();
            // TIME can be negative or exceed 24h; those are durations, not times of day
            let hours = t
                .trim_start_matches('-')
                .split(':')
                .next()
                .and_then(|h| h.parse::<u32>().ok());
            match hours {
                Some(h) if !t.starts_with('-') && h < 24 => Value::Time { value: t },
                _ => other(t, type_name),
            }
        }
        "JSON" => serde_json::from_slice(bytes)
            .map(Value::json)
            .unwrap_or_else(|_| Value::text(lossy())),
        "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            if truncate {
                Value::text(lossy())
            } else {
                Value::text_full(lossy())
            }
        }
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            if truncate {
                Value::bytes(bytes)
            } else {
                Value::bytes_full(bytes)
            }
        }
        // GEOMETRY and anything new: keep the bytes, read-only
        _ => other(hex(bytes), type_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(ty: &str, text: &str) -> Value {
        decode_text(ty, text.as_bytes(), true)
    }

    #[test]
    fn integers_including_unsigned_bigint() {
        assert_eq!(d("INT", "-5"), Value::Int { value: -5 });
        assert_eq!(d("TINYINT UNSIGNED", "255"), Value::Int { value: 255 });
        assert_eq!(
            d("BIGINT UNSIGNED", "18446744073709551615"),
            Value::Bigint {
                value: "18446744073709551615".into()
            }
        );
        assert_eq!(
            d("BIGINT", "9007199254740993"),
            Value::Bigint {
                value: "9007199254740993".into()
            }
        );
        assert_eq!(d("YEAR", "2026"), Value::Int { value: 2026 });
    }

    #[test]
    fn booleans() {
        assert_eq!(d("BOOLEAN", "1"), Value::Bool { value: true });
        assert_eq!(d("BOOLEAN", "0"), Value::Bool { value: false });
    }

    #[test]
    fn decimals_are_exact_text() {
        assert_eq!(
            d("DECIMAL", "12345678901234567890.0123456789"),
            Value::decimal("12345678901234567890.0123456789")
        );
        assert_eq!(d("DECIMAL", "1.50"), Value::decimal("1.50"));
    }

    #[test]
    fn floats() {
        assert_eq!(d("DOUBLE", "1.5"), Value::Float { value: 1.5 });
        assert_eq!(d("FLOAT", "0.1"), Value::Float { value: 0.1 });
    }

    #[test]
    fn dates_and_times() {
        assert_eq!(
            d("DATE", "2026-10-08"),
            Value::Date {
                value: "2026-10-08".into()
            }
        );
        assert_eq!(
            d("DATETIME", "2026-10-08 21:14:07.5"),
            Value::Timestamp {
                value: "2026-10-08T21:14:07.5".into()
            }
        );
        assert_eq!(
            d("TIMESTAMP", "2026-10-08 21:14:07"),
            Value::Timestamptz {
                value: "2026-10-08T21:14:07Z".into()
            }
        );
        assert_eq!(
            d("TIME", "21:14:07"),
            Value::Time {
                value: "21:14:07".into()
            }
        );
    }

    #[test]
    fn zero_dates_arrive_as_other_not_as_errors() {
        assert_eq!(
            d("DATETIME", "0000-00-00 00:00:00"),
            Value::other("0000-00-00 00:00:00", "DATETIME")
        );
        assert_eq!(d("DATE", "0000-00-00"), Value::other("0000-00-00", "DATE"));
        assert_eq!(d("DATE", "2020-00-15"), Value::other("2020-00-15", "DATE"));
        assert_eq!(
            d("TIMESTAMP", "0000-00-00 00:00:00"),
            Value::other("0000-00-00 00:00:00", "TIMESTAMP")
        );
        assert!(d("DATETIME", "0000-00-00 00:00:00").is_read_only());
    }

    #[test]
    fn durations_are_not_times_of_day() {
        assert_eq!(d("TIME", "838:59:59"), Value::other("838:59:59", "TIME"));
        assert_eq!(d("TIME", "-01:00:00"), Value::other("-01:00:00", "TIME"));
    }

    #[test]
    fn json_and_text_and_enum_set() {
        assert_eq!(
            d("JSON", r#"{"a":[1,2]}"#),
            Value::json(serde_json::json!({"a": [1, 2]}))
        );
        assert_eq!(d("JSON", "not json"), Value::text("not json"));
        assert_eq!(d("ENUM", "paid"), Value::text("paid"));
        assert_eq!(d("SET", "a,b"), Value::text("a,b"));
        assert_eq!(d("VARCHAR", "héllo"), Value::text("héllo"));
    }

    #[test]
    fn bit_is_an_unsigned_integer() {
        assert_eq!(decode_text("BIT", &[0x05], true), Value::Int { value: 5 });
        assert_eq!(
            decode_text("BIT", &[0x01, 0x00], true),
            Value::Int { value: 256 }
        );
        assert_eq!(
            decode_text("BIT", &[0xff; 8], true),
            Value::Bigint {
                value: u64::MAX.to_string()
            }
        );
        assert!(matches!(
            decode_text("BIT", &[1; 9], true),
            Value::Other { .. }
        ));
    }

    #[test]
    fn blobs_and_geometry() {
        assert_eq!(
            decode_text("BLOB", &[0xde, 0xad], true),
            Value::bytes(&[0xde, 0xad])
        );
        assert_eq!(decode_text("VARBINARY", &[1], true), Value::bytes(&[1]));
        assert_eq!(
            decode_text("GEOMETRY", &[0x01, 0xab], true),
            Value::other("0x01AB", "GEOMETRY")
        );
    }

    #[test]
    fn large_text_truncates_unless_asked_not_to() {
        let big = "x".repeat(2 * 1024 * 1024);
        assert!(decode_text("LONGTEXT", big.as_bytes(), true).is_read_only());
        let Value::Text { value, truncated } = decode_text("LONGTEXT", big.as_bytes(), false)
        else {
            panic!()
        };
        assert!(!truncated);
        assert_eq!(value.len(), big.len());
    }

    #[test]
    fn binary_collations_on_text_columns_are_still_text() {
        let text_bin = "MySqlTypeInfo { type: VarChar, flags: ColumnFlags(BINARY), collation: Collation(46), max_size: None }";
        let real_blob = "MySqlTypeInfo { type: Blob, flags: ColumnFlags(BINARY), collation: Collation(63), max_size: None }";
        assert_eq!(collation_number(text_bin), Some(46));
        assert_eq!(collation_number(real_blob), Some(63));
        assert_eq!(effective_type_name("VARBINARY", text_bin), "VARCHAR");
        assert_eq!(effective_type_name("LONGBLOB", text_bin), "LONGTEXT");
        assert_eq!(effective_type_name("BLOB", real_blob), "BLOB");
        assert_eq!(effective_type_name("INT", text_bin), "INT");
        // if sqlx ever changes its Debug output, keep the old behaviour rather than guessing
        assert_eq!(effective_type_name("BLOB", "something else"), "BLOB");
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_for_type("BIGINT UNSIGNED"), ValueKind::Bigint);
        assert_eq!(kind_for_type("DATETIME"), ValueKind::Timestamp);
        assert_eq!(kind_for_type("TIMESTAMP"), ValueKind::Timestamptz);
        assert_eq!(kind_for_type("GEOMETRY"), ValueKind::Other);
    }
}
