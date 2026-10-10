use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Offset, SecondsFormat, TimeZone};
use serde::{Deserialize, Serialize};

/// The uniform value model. Every driver converts to and from this.
///
/// Serialized as `{ "kind": "...", ... }`. Integers outside ±2^53 would lose precision in
/// JavaScript, so constructors (`Value::from_i64`) emit `bigint` strings for those.
#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Value {
    Null,
    Bool {
        value: bool,
    },
    Int {
        #[ts(type = "number")]
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
        #[ts(type = "number")]
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
#[derive(ts_rs::TS)]
#[ts(export)]
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

/// Values larger than this are truncated for the grid (full value fetched on demand).
pub const TRUNCATE_THRESHOLD: usize = 1024 * 1024;
/// How much of a truncated value is kept.
pub const TRUNCATE_KEEP: usize = 64 * 1024;
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const JS_SAFE_INT: i64 = (1 << 53) - 1;

impl Value {
    /// Integers beyond ±2^53 become `bigint` strings so the WebView never rounds them.
    pub fn from_i64(v: i64) -> Self {
        if (-JS_SAFE_INT..=JS_SAFE_INT).contains(&v) {
            Value::Int { value: v }
        } else {
            Value::Bigint {
                value: v.to_string(),
            }
        }
    }

    pub fn from_u64(v: u64) -> Self {
        match i64::try_from(v) {
            Ok(i) => Self::from_i64(i),
            Err(_) => Value::Bigint {
                value: v.to_string(),
            },
        }
    }

    pub fn from_i128(v: i128) -> Self {
        match i64::try_from(v) {
            Ok(i) => Self::from_i64(i),
            Err(_) => Value::Bigint {
                value: v.to_string(),
            },
        }
    }

    pub fn from_f64(v: f64) -> Self {
        Value::Float { value: v }
    }

    /// Exact decimal, passed through as the server's own text.
    pub fn decimal(text: impl Into<String>) -> Self {
        Value::Decimal { value: text.into() }
    }

    pub fn from_rust_decimal(d: rust_decimal::Decimal) -> Self {
        Value::Decimal {
            value: d.to_string(),
        }
    }

    /// Text; anything over [`TRUNCATE_THRESHOLD`] keeps its first [`TRUNCATE_KEEP`] bytes
    /// (cut on a character boundary) and sets `truncated`.
    pub fn text(s: impl Into<String>) -> Self {
        let mut s = s.into();
        if s.len() <= TRUNCATE_THRESHOLD {
            return Value::Text {
                value: s,
                truncated: false,
            };
        }
        let mut cut = TRUNCATE_KEEP;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        Value::Text {
            value: s,
            truncated: true,
        }
    }

    /// Text without truncation (used when the full value is fetched on demand).
    pub fn text_full(s: impl Into<String>) -> Self {
        Value::Text {
            value: s.into(),
            truncated: false,
        }
    }

    /// Bytes without truncation.
    pub fn bytes_full(b: &[u8]) -> Self {
        Value::Bytes {
            value: hex(b),
            len: b.len() as u64,
            truncated: false,
        }
    }

    /// Bytes as lowercase hex, with the same truncation rule. `len` is always the full length.
    pub fn bytes(b: &[u8]) -> Self {
        let truncated = b.len() > TRUNCATE_THRESHOLD;
        let kept = if truncated { &b[..TRUNCATE_KEEP] } else { b };
        Value::Bytes {
            value: hex(kept),
            len: b.len() as u64,
            truncated,
        }
    }

    pub fn date(d: NaiveDate) -> Self {
        Value::Date {
            value: d.format("%Y-%m-%d").to_string(),
        }
    }

    pub fn time(t: NaiveTime) -> Self {
        Value::Time {
            value: format_time(t),
        }
    }

    pub fn timestamp(t: NaiveDateTime) -> Self {
        Value::Timestamp {
            value: format!("{}T{}", t.date().format("%Y-%m-%d"), format_time(t.time())),
        }
    }

    /// ISO 8601 with offset (`Z` for UTC).
    pub fn timestamptz<Tz: TimeZone>(t: DateTime<Tz>) -> Self {
        let utc = t.offset().fix().local_minus_utc() == 0;
        Value::Timestamptz {
            value: t.to_rfc3339_opts(SecondsFormat::AutoSi, utc),
        }
    }

    pub fn uuid(u: uuid::Uuid) -> Self {
        Value::Uuid {
            value: u.hyphenated().to_string(),
        }
    }

    pub fn json(v: serde_json::Value) -> Self {
        Value::Json { value: v }
    }

    /// Fallback for types the driver cannot decode natively. Read-only in the grid.
    pub fn other(text: impl Into<String>, type_name: impl Into<String>) -> Self {
        Value::Other {
            value: text.into(),
            type_name: type_name.into(),
        }
    }

    /// Plain text form, for binding as a string parameter. `None` for NULL and arrays.
    pub fn sql_text(&self) -> Option<String> {
        Some(match self {
            Value::Null | Value::Array { .. } => return None,
            Value::Bool { value } => (*value as u8).to_string(),
            Value::Int { value } => value.to_string(),
            Value::Float { value } => value.to_string(),
            Value::Bigint { value }
            | Value::Decimal { value }
            | Value::Text { value, .. }
            | Value::Date { value }
            | Value::Time { value }
            | Value::Timestamp { value }
            | Value::Timestamptz { value }
            | Value::Interval { value }
            | Value::Uuid { value }
            | Value::Other { value, .. } => value.clone(),
            Value::Bytes { value, .. } => value.clone(),
            Value::Json { value } => value.to_string(),
        })
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// True when the grid must not allow editing this value.
    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            Value::Other { .. }
                | Value::Text {
                    truncated: true,
                    ..
                }
                | Value::Bytes {
                    truncated: true,
                    ..
                }
        )
    }
}

fn format_time(t: NaiveTime) -> String {
    use chrono::Timelike;
    if t.nanosecond() == 0 {
        t.format("%H:%M:%S").to_string()
    } else {
        // microsecond precision, trailing zeros trimmed
        let s = t.format("%H:%M:%S%.6f").to_string();
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Utc};

    fn json(v: &Value) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn decimals_keep_every_digit() {
        let text = "12345678901234567890.0123456789";
        let v = Value::decimal(text);
        assert_eq!(
            json(&v),
            serde_json::json!({"kind": "decimal", "value": text})
        );
        let d: rust_decimal::Decimal = "1234567890.0123456789".parse().unwrap();
        assert_eq!(
            Value::from_rust_decimal(d),
            Value::decimal("1234567890.0123456789")
        );
    }

    #[test]
    fn trailing_zeros_survive_a_decimal_round_trip() {
        let d: rust_decimal::Decimal = "1.500".parse().unwrap();
        assert_eq!(Value::from_rust_decimal(d), Value::decimal("1.500"));
    }

    #[test]
    fn integers_beyond_js_safe_range_become_bigint_strings() {
        assert_eq!(Value::from_i64(42), Value::Int { value: 42 });
        assert_eq!(
            Value::from_i64(9_007_199_254_740_991),
            Value::Int {
                value: 9_007_199_254_740_991
            }
        );
        assert_eq!(
            Value::from_i64(9_007_199_254_740_992),
            Value::Bigint {
                value: "9007199254740992".into()
            }
        );
        assert_eq!(
            Value::from_i64(i64::MIN),
            Value::Bigint {
                value: i64::MIN.to_string()
            }
        );
    }

    #[test]
    fn bigint_beyond_i64_keeps_all_digits() {
        assert_eq!(
            Value::from_u64(u64::MAX),
            Value::Bigint {
                value: "18446744073709551615".into()
            }
        );
        let big = i128::from(i64::MAX) * 4;
        assert_eq!(
            Value::from_i128(big),
            Value::Bigint {
                value: big.to_string()
            }
        );
        assert_eq!(Value::from_i128(7), Value::Int { value: 7 });
    }

    #[test]
    fn timestamptz_is_iso_8601() {
        let t = Utc.with_ymd_and_hms(2026, 10, 8, 21, 14, 7).unwrap();
        assert_eq!(
            Value::timestamptz(t),
            Value::Timestamptz {
                value: "2026-10-08T21:14:07Z".into()
            }
        );
        let plus2 = FixedOffset::east_opt(2 * 3600).unwrap();
        let t = plus2.with_ymd_and_hms(2026, 10, 8, 23, 14, 7).unwrap();
        assert_eq!(
            Value::timestamptz(t),
            Value::Timestamptz {
                value: "2026-10-08T23:14:07+02:00".into()
            }
        );
    }

    #[test]
    fn timestamptz_keeps_fractional_seconds() {
        let t = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap()
            + chrono::Duration::microseconds(123_456);
        assert_eq!(
            Value::timestamptz(t),
            Value::Timestamptz {
                value: "2026-01-02T03:04:05.123456Z".into()
            }
        );
    }

    #[test]
    fn date_time_and_timestamp_formats() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 8).unwrap();
        assert_eq!(
            Value::date(d),
            Value::Date {
                value: "2026-10-08".into()
            }
        );
        let t = NaiveTime::from_hms_opt(9, 5, 3).unwrap();
        assert_eq!(
            Value::time(t),
            Value::Time {
                value: "09:05:03".into()
            }
        );
        let t = NaiveTime::from_hms_micro_opt(9, 5, 3, 120_000).unwrap();
        assert_eq!(
            Value::time(t),
            Value::Time {
                value: "09:05:03.12".into()
            }
        );
        let ts = d.and_hms_opt(9, 5, 3).unwrap();
        assert_eq!(
            Value::timestamp(ts),
            Value::Timestamp {
                value: "2026-10-08T09:05:03".into()
            }
        );
    }

    #[test]
    fn unknown_types_fall_back_to_other_and_are_read_only() {
        let v = Value::other("POINT(1 2)", "geometry");
        assert_eq!(
            json(&v),
            serde_json::json!({"kind": "other", "value": "POINT(1 2)", "type_name": "geometry"})
        );
        assert!(v.is_read_only());
        assert!(!Value::Int { value: 1 }.is_read_only());
    }

    #[test]
    fn small_text_is_not_truncated() {
        let v = Value::text("x".repeat(TRUNCATE_THRESHOLD));
        let Value::Text { value, truncated } = v else {
            panic!()
        };
        assert_eq!(value.len(), TRUNCATE_THRESHOLD);
        assert!(!truncated);
    }

    #[test]
    fn large_text_keeps_64_kb_and_flags_truncation() {
        let v = Value::text("x".repeat(TRUNCATE_THRESHOLD + 1));
        assert!(v.is_read_only());
        let Value::Text { value, truncated } = v else {
            panic!()
        };
        assert_eq!(value.len(), TRUNCATE_KEEP);
        assert!(truncated);
    }

    #[test]
    fn truncation_never_splits_a_character() {
        // 'é' is two bytes; make the 64 KiB cut land mid-character.
        let s = format!("a{}", "é".repeat(TRUNCATE_THRESHOLD));
        let Value::Text { value, truncated } = Value::text(s) else {
            panic!()
        };
        assert!(truncated);
        assert!(value.len() <= TRUNCATE_KEEP);
        assert!(value.chars().all(|c| c == 'a' || c == 'é'));
    }

    #[test]
    fn bytes_are_hex_with_full_length() {
        let v = Value::bytes(&[0xde, 0xad, 0xbe, 0xef, 0x00]);
        assert_eq!(
            json(&v),
            serde_json::json!({"kind": "bytes", "value": "deadbeef00", "len": 5})
        );
    }

    #[test]
    fn large_bytes_are_truncated_but_report_the_real_length() {
        let data = vec![0xab_u8; TRUNCATE_THRESHOLD + 10];
        let Value::Bytes {
            value,
            len,
            truncated,
        } = Value::bytes(&data)
        else {
            panic!()
        };
        assert!(truncated);
        assert_eq!(len as usize, TRUNCATE_THRESHOLD + 10);
        assert_eq!(value.len(), TRUNCATE_KEEP * 2);
    }

    #[test]
    fn uuid_is_hyphenated_lowercase() {
        let u = uuid::Uuid::parse_str("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11").unwrap();
        assert_eq!(
            Value::uuid(u),
            Value::Uuid {
                value: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into()
            }
        );
    }

    #[test]
    fn every_variant_round_trips_through_json() {
        let values = vec![
            Value::Null,
            Value::Bool { value: true },
            Value::from_i64(-5),
            Value::from_u64(u64::MAX),
            Value::from_f64(1.5),
            Value::decimal("0.10"),
            Value::text("héllo"),
            Value::bytes(&[1, 2, 3]),
            Value::Date {
                value: "2026-01-01".into(),
            },
            Value::Time {
                value: "01:02:03".into(),
            },
            Value::Timestamp {
                value: "2026-01-01T01:02:03".into(),
            },
            Value::Timestamptz {
                value: "2026-01-01T01:02:03Z".into(),
            },
            Value::Interval {
                value: "P1DT2H".into(),
            },
            Value::uuid(uuid::Uuid::nil()),
            Value::json(serde_json::json!({"a": [1, null, "x"]})),
            Value::Array {
                value: vec![Value::from_i64(1), Value::Null],
            },
            Value::other("x", "citext"),
        ];
        for v in values {
            let back: Value = serde_json::from_str(&serde_json::to_string(&v).unwrap()).unwrap();
            assert_eq!(back, v);
        }
    }

    #[test]
    fn null_serializes_as_a_bare_kind() {
        assert_eq!(json(&Value::Null), serde_json::json!({"kind": "null"}));
    }
}
