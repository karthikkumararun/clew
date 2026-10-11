//! Mapping Oracle's types to the value model.

use oracle::sql_type::{OracleType, Timestamp};
use oracle::SqlValue;

use crate::drivers::{Value, ValueKind};

pub fn kind_of(t: &OracleType) -> ValueKind {
    match t {
        OracleType::Number(_, 0) if matches!(t, OracleType::Number(p, _) if *p > 0 && *p <= 18) => {
            ValueKind::Int
        }
        OracleType::Number(..) => ValueKind::Decimal,
        OracleType::Float(_) | OracleType::BinaryFloat | OracleType::BinaryDouble => {
            ValueKind::Float
        }
        OracleType::Varchar2(_)
        | OracleType::NVarchar2(_)
        | OracleType::Char(_)
        | OracleType::NChar(_)
        | OracleType::CLOB
        | OracleType::NCLOB
        | OracleType::Long
        | OracleType::Rowid => ValueKind::Text,
        OracleType::Date | OracleType::Timestamp(_) | OracleType::TimestampLTZ(_) => {
            ValueKind::Timestamp
        }
        OracleType::TimestampTZ(_) => ValueKind::Timestamptz,
        OracleType::IntervalDS(..) | OracleType::IntervalYM(_) => ValueKind::Interval,
        OracleType::Raw(_) | OracleType::LongRaw | OracleType::BLOB | OracleType::BFILE => {
            ValueKind::Bytes
        }
        OracleType::Boolean => ValueKind::Bool,
        OracleType::Json => ValueKind::Json,
        _ => ValueKind::Other,
    }
}

/// `2026-01-02T03:04:05.123` (the fraction only when there is one).
pub fn timestamp_text(t: &Timestamp) -> String {
    let mut s = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        t.year(),
        t.month(),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    );
    let ns = t.nanosecond();
    if ns != 0 {
        s.push('.');
        s.push_str(format!("{ns:09}").trim_end_matches('0'));
    }
    s
}

fn offset_text(t: &Timestamp) -> String {
    let (h, m) = (t.tz_hour_offset(), t.tz_minute_offset());
    if h == 0 && m == 0 {
        "Z".to_string()
    } else {
        let sign = if h < 0 || m < 0 { '-' } else { '+' };
        format!("{sign}{:02}:{:02}", h.abs(), m.abs())
    }
}

pub fn to_value(v: &SqlValue, t: &OracleType) -> Value {
    if v.is_null().unwrap_or(true) {
        return Value::Null;
    }
    let text = || v.get::<String>().unwrap_or_default();
    match t {
        OracleType::Number(..) => {
            let s = text();
            match kind_of(t) {
                ValueKind::Int => s
                    .parse::<i64>()
                    .map_or_else(|_| Value::decimal(s.clone()), Value::from_i64),
                _ => Value::decimal(s),
            }
        }
        OracleType::Float(_) | OracleType::BinaryFloat | OracleType::BinaryDouble => v
            .get::<f64>()
            .map_or_else(|_| Value::decimal(text()), Value::from_f64),
        OracleType::Date | OracleType::Timestamp(_) | OracleType::TimestampLTZ(_) => v
            .get::<Timestamp>()
            .map_or(Value::Null, |t| Value::Timestamp {
                value: timestamp_text(&t),
            }),
        OracleType::TimestampTZ(_) => {
            v.get::<Timestamp>()
                .map_or(Value::Null, |t| Value::Timestamptz {
                    value: format!("{}{}", timestamp_text(&t), offset_text(&t)),
                })
        }
        OracleType::IntervalDS(..) | OracleType::IntervalYM(_) => Value::Interval { value: text() },
        OracleType::Raw(_) | OracleType::LongRaw | OracleType::BLOB => {
            v.get::<Vec<u8>>().map_or(Value::Null, |b| Value::bytes(&b))
        }
        OracleType::Boolean => v
            .get::<bool>()
            .map_or(Value::Null, |b| Value::Bool { value: b }),
        OracleType::Varchar2(_)
        | OracleType::NVarchar2(_)
        | OracleType::Char(_)
        | OracleType::NChar(_)
        | OracleType::CLOB
        | OracleType::NCLOB
        | OracleType::Long
        | OracleType::Rowid => Value::text(text()),
        other => Value::other(text(), other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of(&OracleType::Number(10, 0)), ValueKind::Int);
        assert_eq!(kind_of(&OracleType::Number(0, -127)), ValueKind::Decimal);
        assert_eq!(kind_of(&OracleType::Number(10, 2)), ValueKind::Decimal);
        assert_eq!(kind_of(&OracleType::Number(30, 0)), ValueKind::Decimal);
        assert_eq!(kind_of(&OracleType::Varchar2(50)), ValueKind::Text);
        assert_eq!(kind_of(&OracleType::Date), ValueKind::Timestamp);
        assert_eq!(kind_of(&OracleType::TimestampTZ(6)), ValueKind::Timestamptz);
        assert_eq!(kind_of(&OracleType::Raw(16)), ValueKind::Bytes);
        assert_eq!(kind_of(&OracleType::BLOB), ValueKind::Bytes);
        assert_eq!(kind_of(&OracleType::CLOB), ValueKind::Text);
        assert_eq!(kind_of(&OracleType::Rowid), ValueKind::Text);
    }

    #[test]
    fn timestamps_print_their_fraction_only_when_present() {
        let t = Timestamp::new(2026, 1, 2, 3, 4, 5, 123_000_000).unwrap();
        assert_eq!(timestamp_text(&t), "2026-01-02T03:04:05.123");
        let t = Timestamp::new(2026, 1, 2, 3, 4, 5, 0).unwrap();
        assert_eq!(timestamp_text(&t), "2026-01-02T03:04:05");
        let t = Timestamp::new(2026, 1, 2, 3, 4, 5, 0)
            .unwrap()
            .and_tz_hm_offset(2, 0)
            .unwrap();
        assert_eq!(offset_text(&t), "+02:00");
        let t = Timestamp::new(2026, 1, 2, 3, 4, 5, 0)
            .unwrap()
            .and_tz_hm_offset(-1, -30)
            .unwrap();
        assert_eq!(offset_text(&t), "-01:30");
        let t = Timestamp::new(2026, 1, 2, 3, 4, 5, 0)
            .unwrap()
            .and_tz_hm_offset(0, 0)
            .unwrap();
        assert_eq!(offset_text(&t), "Z");
    }
}
