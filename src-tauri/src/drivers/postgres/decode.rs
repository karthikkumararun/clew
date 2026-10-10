//! Decoding PostgreSQL binary-format values into the uniform value model.
//!
//! sqlx requests binary results for prepared statements, so every column arrives as the type's
//! binary wire format. The decoders below work on `(type oid, bytes)` so they can be tested
//! without a server. Types that have no decoder fall back to `Value::Other` (read-only).

use std::fmt::Write;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::postgres::{PgTypeKind, PgValueFormat, PgValueRef};
use sqlx::{TypeInfo, ValueRef};

use crate::drivers::{Value, ValueKind};

pub mod oid {
    pub const BOOL: u32 = 16;
    pub const BYTEA: u32 = 17;
    pub const CHAR: u32 = 18;
    pub const NAME: u32 = 19;
    pub const INT8: u32 = 20;
    pub const INT2: u32 = 21;
    pub const INT4: u32 = 23;
    pub const TEXT: u32 = 25;
    pub const OID: u32 = 26;
    pub const JSON: u32 = 114;
    pub const XML: u32 = 142;
    pub const POINT: u32 = 600;
    pub const CIDR: u32 = 650;
    pub const FLOAT4: u32 = 700;
    pub const FLOAT8: u32 = 701;
    pub const MONEY: u32 = 790;
    pub const MACADDR: u32 = 829;
    pub const INET: u32 = 869;
    pub const BPCHAR: u32 = 1042;
    pub const VARCHAR: u32 = 1043;
    pub const DATE: u32 = 1082;
    pub const TIME: u32 = 1083;
    pub const TIMESTAMP: u32 = 1114;
    pub const TIMESTAMPTZ: u32 = 1184;
    pub const INTERVAL: u32 = 1186;
    pub const TIMETZ: u32 = 1266;
    pub const BIT: u32 = 1560;
    pub const VARBIT: u32 = 1562;
    pub const NUMERIC: u32 = 1700;
    pub const UUID: u32 = 2950;
    pub const JSONB: u32 = 3802;
}

/// Days from 0001-01-01 (chrono's CE day 1) to 2000-01-01, PostgreSQL's epoch.
const PG_EPOCH_DAYS_FROM_CE: i32 = 730_120;

fn pg_epoch() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2000, 1, 1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .expect("valid epoch")
}

/// The coarse value kind for a type oid (used for column metadata before any row arrives).
pub fn kind_for_oid(oid: u32) -> ValueKind {
    use oid::*;
    match oid {
        BOOL => ValueKind::Bool,
        INT2 | INT4 | OID => ValueKind::Int,
        INT8 => ValueKind::Bigint,
        FLOAT4 | FLOAT8 => ValueKind::Float,
        NUMERIC => ValueKind::Decimal,
        TEXT | VARCHAR | BPCHAR | NAME | CHAR | XML => ValueKind::Text,
        BYTEA => ValueKind::Bytes,
        DATE => ValueKind::Date,
        TIME | TIMETZ => ValueKind::Time,
        TIMESTAMP => ValueKind::Timestamp,
        TIMESTAMPTZ => ValueKind::Timestamptz,
        INTERVAL => ValueKind::Interval,
        UUID => ValueKind::Uuid,
        JSON | JSONB => ValueKind::Json,
        _ => ValueKind::Other,
    }
}

fn other(text: impl Into<String>, type_name: &str) -> Value {
    Value::other(text, type_name)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::from("\\x");
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn be_i16(b: &[u8]) -> Option<i16> {
    Some(i16::from_be_bytes(b.get(..2)?.try_into().ok()?))
}

fn be_i32(b: &[u8]) -> Option<i32> {
    Some(i32::from_be_bytes(b.get(..4)?.try_into().ok()?))
}

fn be_i64(b: &[u8]) -> Option<i64> {
    Some(i64::from_be_bytes(b.get(..8)?.try_into().ok()?))
}

/// Exact decimal text for a binary `numeric`. `NaN`, `Infinity` and `-Infinity` are returned as
/// their text (callers turn them into `Other`).
pub fn numeric_to_string(b: &[u8]) -> Option<String> {
    let ndigits = be_i16(b)? as usize;
    let weight = be_i16(&b[2..])? as i32;
    let sign = u16::from_be_bytes(b.get(4..6)?.try_into().ok()?);
    let dscale = u16::from_be_bytes(b.get(6..8)?.try_into().ok()?) as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        0x0000 | 0x4000 => {}
        _ => return None,
    }
    let mut digits = Vec::with_capacity(ndigits);
    for i in 0..ndigits {
        digits.push(be_i16(b.get(8 + i * 2..)?)? as i32);
    }

    let mut out = String::new();
    if sign == 0x4000 {
        out.push('-');
    }
    // integer part: weights `weight ..= 0`
    if weight >= 0 {
        for i in 0..=weight {
            let d = digits.get(i as usize).copied().unwrap_or(0);
            if i == 0 {
                let _ = write!(out, "{d}");
            } else {
                let _ = write!(out, "{d:04}");
            }
        }
    } else {
        out.push('0');
    }
    // fractional part: weights -1, -2, ... until dscale digits exist
    if dscale > 0 {
        let mut frac = String::new();
        let mut w = -1;
        while frac.len() < dscale {
            let idx = weight - w;
            let d = if idx >= 0 {
                digits.get(idx as usize).copied().unwrap_or(0)
            } else {
                0
            };
            let _ = write!(frac, "{d:04}");
            w -= 1;
        }
        frac.truncate(dscale);
        out.push('.');
        out.push_str(&frac);
    }
    Some(out)
}

fn interval_to_iso(b: &[u8]) -> Option<String> {
    let micros = be_i64(b)?;
    let days = be_i32(b.get(8..)?)?;
    let months = be_i32(b.get(12..)?)?;
    let (years, months) = (months / 12, months % 12);

    let mut s = String::from("P");
    let mut unit = |value: i64, suffix: char| {
        if value != 0 {
            let _ = write!(s, "{value}{suffix}");
        }
    };
    unit(years as i64, 'Y');
    unit(months as i64, 'M');
    unit(days as i64, 'D');

    if micros != 0 {
        s.push('T');
        let neg = micros < 0;
        let m = micros.unsigned_abs();
        let (hours, rem) = (m / 3_600_000_000, m % 3_600_000_000);
        let (mins, rem) = (rem / 60_000_000, rem % 60_000_000);
        let (secs, frac) = (rem / 1_000_000, rem % 1_000_000);
        let sign = if neg { "-" } else { "" };
        if hours > 0 {
            let _ = write!(s, "{sign}{hours}H");
        }
        if mins > 0 {
            let _ = write!(s, "{sign}{mins}M");
        }
        if secs > 0 || frac > 0 {
            if frac > 0 {
                let f = format!("{frac:06}");
                let _ = write!(s, "{sign}{secs}.{}S", f.trim_end_matches('0'));
            } else {
                let _ = write!(s, "{sign}{secs}S");
            }
        }
    } else if s == "P" {
        s.push_str("T0S");
    }
    Some(s)
}

fn float(v: f64, type_name: &str) -> Value {
    if v.is_finite() {
        Value::from_f64(v)
    } else if v.is_nan() {
        other("NaN", type_name)
    } else if v > 0.0 {
        other("Infinity", type_name)
    } else {
        other("-Infinity", type_name)
    }
}

fn time_of_day(micros: i64) -> Option<NaiveTime> {
    let secs = u32::try_from(micros / 1_000_000).ok()?;
    let nanos = u32::try_from((micros % 1_000_000) * 1000).ok()?;
    NaiveTime::from_num_seconds_from_midnight_opt(secs, nanos)
}

/// Decode one value in binary format given its type oid. Large text and bytea values are
/// truncated for display (see [`Value::text`]).
pub fn decode_binary(type_oid: u32, b: &[u8], type_name: &str) -> Value {
    decode_binary_opts(type_oid, b, type_name, true)
}

/// Like [`decode_binary`]; `truncate = false` keeps large text and bytea values whole.
pub fn decode_binary_opts(type_oid: u32, b: &[u8], type_name: &str, truncate: bool) -> Value {
    use oid::*;
    let fallback = || other(hex(b), type_name);
    match type_oid {
        BOOL => b
            .first()
            .map_or_else(fallback, |v| Value::Bool { value: *v != 0 }),
        INT2 => be_i16(b).map_or_else(fallback, |v| Value::from_i64(v as i64)),
        INT4 => be_i32(b).map_or_else(fallback, |v| Value::from_i64(v as i64)),
        INT8 => be_i64(b).map_or_else(fallback, Value::from_i64),
        OID => be_i32(b).map_or_else(fallback, |v| Value::from_i64(v as u32 as i64)),
        FLOAT4 => b
            .get(..4)
            .and_then(|x| x.try_into().ok())
            .map(f32::from_be_bytes)
            .map_or_else(fallback, |f| {
                // keep the shortest decimal form (0.1, not 0.10000000149011612)
                float(f.to_string().parse().unwrap_or(f as f64), type_name)
            }),
        FLOAT8 => b
            .get(..8)
            .and_then(|x| x.try_into().ok())
            .map(f64::from_be_bytes)
            .map_or_else(fallback, |f| float(f, type_name)),
        NUMERIC => match numeric_to_string(b) {
            Some(t)
                if t.chars()
                    .next()
                    .is_some_and(|c| c == '-' || c.is_ascii_digit())
                    && t != "-Infinity" =>
            {
                Value::decimal(t)
            }
            Some(t) => other(t, type_name),
            None => fallback(),
        },
        TEXT | VARCHAR | BPCHAR | NAME | XML | CHAR => {
            let t = String::from_utf8_lossy(b).into_owned();
            if truncate {
                Value::text(t)
            } else {
                Value::text_full(t)
            }
        }
        BYTEA => {
            if truncate {
                Value::bytes(b)
            } else {
                Value::bytes_full(b)
            }
        }
        UUID => uuid::Uuid::from_slice(b).map_or_else(|_| fallback(), Value::uuid),
        JSON => serde_json::from_slice(b).map_or_else(|_| fallback(), Value::json),
        JSONB => b
            .split_first()
            .filter(|(v, _)| **v == 1)
            .and_then(|(_, rest)| serde_json::from_slice(rest).ok())
            .map_or_else(fallback, Value::json),
        DATE => match be_i32(b) {
            Some(i32::MAX) => Value::Date {
                value: "infinity".into(),
            },
            Some(i32::MIN) => Value::Date {
                value: "-infinity".into(),
            },
            Some(days) => days
                .checked_add(PG_EPOCH_DAYS_FROM_CE)
                .and_then(NaiveDate::from_num_days_from_ce_opt)
                .map_or_else(fallback, Value::date),
            None => fallback(),
        },
        TIME => be_i64(b)
            .and_then(time_of_day)
            .map_or_else(fallback, Value::time),
        TIMETZ => {
            let t = be_i64(b).and_then(time_of_day);
            let zone = b.get(8..).and_then(be_i32);
            match (t, zone) {
                (Some(t), Some(west)) => {
                    // PostgreSQL stores seconds *west* of UTC.
                    let east = -west;
                    let sign = if east < 0 { '-' } else { '+' };
                    let (h, m) = (east.abs() / 3600, (east.abs() % 3600) / 60);
                    let Value::Time { value } = Value::time(t) else {
                        unreachable!()
                    };
                    Value::Time {
                        value: format!("{value}{sign}{h:02}:{m:02}"),
                    }
                }
                _ => fallback(),
            }
        }
        TIMESTAMP => match be_i64(b) {
            Some(i64::MAX) => Value::Timestamp {
                value: "infinity".into(),
            },
            Some(i64::MIN) => Value::Timestamp {
                value: "-infinity".into(),
            },
            Some(us) => pg_epoch()
                .checked_add_signed(Duration::microseconds(us))
                .map_or_else(fallback, Value::timestamp),
            None => fallback(),
        },
        TIMESTAMPTZ => match be_i64(b) {
            Some(i64::MAX) => Value::Timestamptz {
                value: "infinity".into(),
            },
            Some(i64::MIN) => Value::Timestamptz {
                value: "-infinity".into(),
            },
            Some(us) => pg_epoch()
                .checked_add_signed(Duration::microseconds(us))
                .map(|t| {
                    Value::timestamptz(DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                        t,
                        chrono::Utc,
                    ))
                })
                .unwrap_or_else(fallback),
            None => fallback(),
        },
        INTERVAL => interval_to_iso(b).map_or_else(fallback, |t| Value::Interval { value: t }),
        MONEY => be_i64(b).map_or_else(fallback, |c| {
            let sign = if c < 0 { "-" } else { "" };
            other(
                format!(
                    "{sign}{}.{:02}",
                    c.unsigned_abs() / 100,
                    c.unsigned_abs() % 100
                ),
                type_name,
            )
        }),
        INET | CIDR => decode_inet(b).map_or_else(fallback, |t| other(t, type_name)),
        MACADDR if b.len() == 6 => other(
            b.iter()
                .map(|x| format!("{x:02x}"))
                .collect::<Vec<_>>()
                .join(":"),
            type_name,
        ),
        POINT if b.len() == 16 => {
            let x = f64::from_be_bytes(b[..8].try_into().unwrap());
            let y = f64::from_be_bytes(b[8..16].try_into().unwrap());
            other(format!("({x},{y})"), type_name)
        }
        BIT | VARBIT => decode_bits(b).map_or_else(fallback, |t| other(t, type_name)),
        // PostGIS sends EWKB, whose text form *is* upper-case hex of the same bytes.
        _ if type_name.eq_ignore_ascii_case("geometry")
            || type_name.eq_ignore_ascii_case("geography") =>
        {
            other(
                b.iter().map(|x| format!("{x:02X}")).collect::<String>(),
                type_name,
            )
        }
        _ => fallback(),
    }
}

fn decode_inet(b: &[u8]) -> Option<String> {
    let family = *b.first()?;
    let bits = *b.get(1)?;
    let is_cidr = *b.get(2)? != 0;
    let len = *b.get(3)? as usize;
    let addr = b.get(4..4 + len)?;
    let text = match (family, len) {
        (2, 4) => std::net::Ipv4Addr::new(addr[0], addr[1], addr[2], addr[3]).to_string(),
        (3, 16) => {
            let mut a = [0u8; 16];
            a.copy_from_slice(addr);
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => return None,
    };
    let full = (family == 2 && bits == 32) || (family == 3 && bits == 128);
    Some(if is_cidr || !full {
        format!("{text}/{bits}")
    } else {
        text
    })
}

fn decode_bits(b: &[u8]) -> Option<String> {
    let nbits = be_i32(b)? as usize;
    let bytes = b.get(4..)?;
    let mut s = String::with_capacity(nbits);
    for i in 0..nbits {
        let byte = *bytes.get(i / 8)?;
        s.push(if byte & (0x80 >> (i % 8)) != 0 {
            '1'
        } else {
            '0'
        });
    }
    Some(s)
}

/// Decode a binary array into nested `Value::Array`s.
fn decode_array(b: &[u8], type_name: &str) -> Value {
    let fallback = || other(hex(b), type_name);
    let (Some(ndim), Some(elem_oid)) = (be_i32(b), b.get(8..).and_then(be_i32)) else {
        return fallback();
    };
    let elem_oid = elem_oid as u32;
    let ndim = ndim as usize;
    if ndim == 0 {
        return Value::Array { value: vec![] };
    }
    let mut dims = Vec::with_capacity(ndim);
    let mut pos = 12;
    for _ in 0..ndim {
        let Some(len) = b.get(pos..).and_then(be_i32) else {
            return fallback();
        };
        dims.push(len as usize);
        pos += 8; // length + lower bound
    }
    let total: usize = dims.iter().product();
    let elem_name = type_name.strip_suffix("[]").unwrap_or(type_name);
    let mut flat = Vec::with_capacity(total);
    for _ in 0..total {
        let Some(len) = b.get(pos..).and_then(be_i32) else {
            return fallback();
        };
        pos += 4;
        if len < 0 {
            flat.push(Value::Null);
        } else {
            let len = len as usize;
            let Some(bytes) = b.get(pos..pos + len) else {
                return fallback();
            };
            flat.push(decode_element(elem_oid, bytes, elem_name));
            pos += len;
        }
    }
    nest(flat, &dims)
}

fn decode_element(oid: u32, bytes: &[u8], type_name: &str) -> Value {
    match kind_for_oid(oid) {
        // unknown element types (enums, citext, ...) are sent as text in binary mode too
        ValueKind::Other if !is_known_other(oid) => match std::str::from_utf8(bytes) {
            Ok(t) => Value::text(t),
            Err(_) => other(hex(bytes), type_name),
        },
        _ => decode_binary(oid, bytes, type_name),
    }
}

fn is_known_other(oid: u32) -> bool {
    use oid::*;
    matches!(oid, MONEY | INET | CIDR | MACADDR | BIT | VARBIT | POINT)
}

fn nest(flat: Vec<Value>, dims: &[usize]) -> Value {
    if dims.len() <= 1 {
        return Value::Array { value: flat };
    }
    let chunk: usize = dims[1..].iter().product();
    if chunk == 0 {
        return Value::Array { value: vec![] };
    }
    let mut out = Vec::with_capacity(dims[0]);
    let mut it = flat.into_iter();
    for _ in 0..dims[0] {
        out.push(nest(it.by_ref().take(chunk).collect(), &dims[1..]));
    }
    Value::Array { value: out }
}

/// Decode a column value from sqlx, using the column's type info.
pub fn decode_value(v: PgValueRef<'_>) -> Value {
    decode_value_opts(v, true)
}

pub fn decode_value_opts(v: PgValueRef<'_>, truncate: bool) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    let info = v.type_info().into_owned();
    let name = info.name().to_string();
    let Ok(bytes) = v.as_bytes() else {
        return Value::Null;
    };
    if v.format() == PgValueFormat::Text {
        return Value::text(String::from_utf8_lossy(bytes).into_owned());
    }
    decode_by_info(&info, bytes, &name, truncate)
}

fn decode_by_info(
    info: &sqlx::postgres::PgTypeInfo,
    bytes: &[u8],
    name: &str,
    truncate: bool,
) -> Value {
    match info.kind() {
        PgTypeKind::Array(_) => decode_array(bytes, name),
        PgTypeKind::Enum(_) => Value::text(String::from_utf8_lossy(bytes).into_owned()),
        PgTypeKind::Domain(base) => decode_by_info(base, bytes, base.name(), truncate),
        PgTypeKind::Simple => match info.oid() {
            Some(oid) => decode_binary_opts(oid.0, bytes, name, truncate),
            None => other(hex(bytes), name),
        },
        // composite, range, pseudo: no decoder
        _ => match info.oid() {
            Some(oid) if kind_for_oid(oid.0) != ValueKind::Other => {
                decode_binary(oid.0, bytes, name)
            }
            _ => other(hex(bytes), name),
        },
    }
}

/// `ValueKind` for a column's type.
pub fn kind_for_info(info: &sqlx::postgres::PgTypeInfo) -> ValueKind {
    match info.kind() {
        PgTypeKind::Array(_) => ValueKind::Array,
        PgTypeKind::Enum(_) => ValueKind::Text,
        PgTypeKind::Domain(base) => kind_for_info(base),
        _ => match info.oid() {
            Some(oid) => kind_for_oid(oid.0),
            None => ValueKind::Other,
        },
    }
}

#[cfg(test)]
mod tests;
