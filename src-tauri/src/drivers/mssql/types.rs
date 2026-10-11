//! Mapping SQL Server's column types and values to the value model.

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use tiberius::numeric::Numeric;
use tiberius::{ColumnData, ColumnType, FromSql};

use crate::drivers::{Value, ValueKind};

pub fn type_name(t: ColumnType) -> &'static str {
    use ColumnType::*;
    match t {
        Null => "NULL",
        Bit | Bitn => "BIT",
        Int1 => "TINYINT",
        Int2 => "SMALLINT",
        Int4 => "INT",
        Int8 => "BIGINT",
        Intn => "INT",
        Datetime4 => "SMALLDATETIME",
        Datetime | Datetimen => "DATETIME",
        Float4 => "REAL",
        Float8 | Floatn => "FLOAT",
        Money => "MONEY",
        Money4 => "SMALLMONEY",
        Guid => "UNIQUEIDENTIFIER",
        Decimaln | Numericn => "DECIMAL",
        Daten => "DATE",
        Timen => "TIME",
        Datetime2 => "DATETIME2",
        DatetimeOffsetn => "DATETIMEOFFSET",
        BigVarBin => "VARBINARY",
        BigBinary => "BINARY",
        BigVarChar => "VARCHAR",
        BigChar => "CHAR",
        NVarchar => "NVARCHAR",
        NChar => "NCHAR",
        Xml => "XML",
        Udt => "UDT",
        Text => "TEXT",
        NText => "NTEXT",
        Image => "IMAGE",
        SSVariant => "SQL_VARIANT",
    }
}

pub fn kind_of(t: ColumnType) -> ValueKind {
    use ColumnType::*;
    match t {
        Bit | Bitn => ValueKind::Bool,
        Int1 | Int2 | Int4 | Intn => ValueKind::Int,
        Int8 => ValueKind::Bigint,
        Float4 | Float8 | Floatn => ValueKind::Float,
        Money | Money4 | Decimaln | Numericn => ValueKind::Decimal,
        Datetime | Datetime4 | Datetimen | Datetime2 => ValueKind::Timestamp,
        DatetimeOffsetn => ValueKind::Timestamptz,
        Daten => ValueKind::Date,
        Timen => ValueKind::Time,
        Guid => ValueKind::Uuid,
        BigVarBin | BigBinary | Image => ValueKind::Bytes,
        BigVarChar | BigChar | NVarchar | NChar | Text | NText | Xml => ValueKind::Text,
        _ => ValueKind::Other,
    }
}

fn numeric_text(n: Numeric) -> String {
    // `Display` writes `int.frac` with the column's own scale.
    n.to_string()
}

/// A result cell. `money` marks MONEY / SMALLMONEY columns, which arrive as floats but are
/// exact to four decimals.
pub fn to_value(data: &ColumnData<'static>, money: bool) -> Value {
    match data {
        ColumnData::U8(v) => v.map_or(Value::Null, |n| Value::Int { value: n.into() }),
        ColumnData::I16(v) => v.map_or(Value::Null, |n| Value::Int { value: n.into() }),
        ColumnData::I32(v) => v.map_or(Value::Null, |n| Value::Int { value: n.into() }),
        ColumnData::I64(v) => v.map_or(Value::Null, Value::from_i64),
        ColumnData::F32(v) => v.map_or(Value::Null, |n| Value::from_f64(n.into())),
        ColumnData::F64(v) => match v {
            Some(n) if money => Value::decimal(format!("{n:.4}")),
            Some(n) => Value::from_f64(*n),
            None => Value::Null,
        },
        ColumnData::Bit(v) => v.map_or(Value::Null, |b| Value::Bool { value: b }),
        ColumnData::String(v) => v
            .as_ref()
            .map_or(Value::Null, |s| Value::text(s.to_string())),
        ColumnData::Guid(v) => v.map_or(Value::Null, Value::uuid),
        ColumnData::Binary(v) => v.as_ref().map_or(Value::Null, |b| Value::bytes(b)),
        ColumnData::Numeric(v) => v.map_or(Value::Null, |n| Value::decimal(numeric_text(n))),
        ColumnData::Xml(v) => v
            .as_ref()
            .map_or(Value::Null, |x| Value::text(x.as_ref().to_string())),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match NaiveDateTime::from_sql(data) {
                Ok(Some(t)) => Value::timestamp(t),
                _ => Value::Null,
            }
        }
        ColumnData::Date(_) => match NaiveDate::from_sql(data) {
            Ok(Some(d)) => Value::date(d),
            _ => Value::Null,
        },
        ColumnData::Time(_) => match NaiveTime::from_sql(data) {
            Ok(Some(t)) => Value::time(t),
            _ => Value::Null,
        },
        ColumnData::DateTimeOffset(_) => match DateTime::<FixedOffset>::from_sql(data) {
            Ok(Some(t)) => Value::timestamptz(t),
            _ => Value::Null,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn names_and_kinds() {
        assert_eq!(type_name(ColumnType::Int4), "INT");
        assert_eq!(type_name(ColumnType::NVarchar), "NVARCHAR");
        assert_eq!(type_name(ColumnType::DatetimeOffsetn), "DATETIMEOFFSET");
        assert_eq!(kind_of(ColumnType::Int8), ValueKind::Bigint);
        assert_eq!(kind_of(ColumnType::Money), ValueKind::Decimal);
        assert_eq!(kind_of(ColumnType::Guid), ValueKind::Uuid);
        assert_eq!(kind_of(ColumnType::DatetimeOffsetn), ValueKind::Timestamptz);
        assert_eq!(kind_of(ColumnType::BigVarBin), ValueKind::Bytes);
        assert_eq!(kind_of(ColumnType::SSVariant), ValueKind::Other);
    }

    #[test]
    fn scalars() {
        assert_eq!(
            to_value(&ColumnData::I32(Some(5)), false),
            Value::Int { value: 5 }
        );
        assert_eq!(to_value(&ColumnData::I32(None), false), Value::Null);
        assert_eq!(
            to_value(&ColumnData::I64(Some(i64::MAX)), false),
            Value::Bigint {
                value: i64::MAX.to_string()
            }
        );
        assert_eq!(
            to_value(&ColumnData::Bit(Some(true)), false),
            Value::Bool { value: true }
        );
        assert_eq!(
            to_value(&ColumnData::String(Some(Cow::Borrowed("héllo"))), false),
            Value::text("héllo")
        );
        assert_eq!(
            to_value(
                &ColumnData::Binary(Some(Cow::Owned(vec![0xde, 0xad]))),
                false
            ),
            Value::Bytes {
                value: "dead".into(),
                len: 2,
                truncated: false
            }
        );
    }

    #[test]
    fn money_is_exact_to_four_decimals() {
        assert_eq!(
            to_value(&ColumnData::F64(Some(12.5)), true),
            Value::Decimal {
                value: "12.5000".into()
            }
        );
        assert_eq!(
            to_value(&ColumnData::F64(Some(12.5)), false),
            Value::Float { value: 12.5 }
        );
    }

    #[test]
    fn numerics_keep_their_scale() {
        let n = Numeric::new_with_scale(1250, 2);
        assert_eq!(
            to_value(&ColumnData::Numeric(Some(n)), false),
            Value::Decimal {
                value: "12.50".into()
            }
        );
    }
}
