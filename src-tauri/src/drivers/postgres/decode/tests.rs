use super::oid::*;
use super::*;

/// Encode a decimal string the way PostgreSQL does (reverse of `numeric_to_string`).
fn encode_numeric(s: &str) -> Vec<u8> {
    let (neg, s) = s.strip_prefix('-').map_or((false, s), |r| (true, r));
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    let dscale = frac.len();
    // pad the integer part on the left and the fraction on the right to multiples of 4
    let int = if int == "0" {
        String::new()
    } else {
        int.to_string()
    };
    let int_pad = (4 - int.len() % 4) % 4;
    let int = format!("{}{int}", "0".repeat(int_pad));
    let frac_pad = (4 - frac.len() % 4) % 4;
    let frac = format!("{frac}{}", "0".repeat(frac_pad));
    let group = |t: &str| -> Vec<i16> {
        t.as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap().parse().unwrap())
            .collect()
    };
    let mut digits = group(&int);
    let int_groups = digits.len() as i16;
    digits.extend(group(&frac));
    let mut weight = int_groups - 1;
    // strip leading zero groups (only matters for 0.000x values)
    while digits.first() == Some(&0) {
        digits.remove(0);
        weight -= 1;
    }
    while digits.last() == Some(&0) {
        digits.pop();
    }
    if digits.is_empty() {
        weight = 0;
    }
    let mut out = Vec::new();
    out.extend((digits.len() as i16).to_be_bytes());
    out.extend(weight.to_be_bytes());
    out.extend((if neg { 0x4000u16 } else { 0 }).to_be_bytes());
    out.extend((dscale as u16).to_be_bytes());
    for d in digits {
        out.extend(d.to_be_bytes());
    }
    out
}

fn dec(s: &str) -> Value {
    decode_binary(NUMERIC, &encode_numeric(s), "NUMERIC")
}

#[test]
fn numeric_round_trips_exactly() {
    for s in [
        "0",
        "1",
        "-1",
        "12345678901234567890.0123456789",
        "0.0001",
        "0.00001234",
        "100",
        "100.50",
        "-0.5",
        "99999999999999999999999999999999.999999999999",
        "10000",
        "1.5000",
    ] {
        assert_eq!(dec(s), Value::decimal(s), "round trip of {s}");
    }
}

#[test]
fn numeric_special_values_become_other() {
    let nan = [0, 0, 0, 0, 0xC0, 0, 0, 0];
    assert_eq!(
        decode_binary(NUMERIC, &nan, "NUMERIC"),
        Value::other("NaN", "NUMERIC")
    );
    let inf = [0, 0, 0, 0, 0xD0, 0, 0, 0];
    assert_eq!(
        decode_binary(NUMERIC, &inf, "NUMERIC"),
        Value::other("Infinity", "NUMERIC")
    );
    let ninf = [0, 0, 0, 0, 0xF0, 0, 0, 0];
    assert_eq!(
        decode_binary(NUMERIC, &ninf, "NUMERIC"),
        Value::other("-Infinity", "NUMERIC")
    );
}

#[test]
fn integers() {
    assert_eq!(
        decode_binary(INT2, &(-5i16).to_be_bytes(), "INT2"),
        Value::Int { value: -5 }
    );
    assert_eq!(
        decode_binary(INT4, &7i32.to_be_bytes(), "INT4"),
        Value::Int { value: 7 }
    );
    assert_eq!(
        decode_binary(INT8, &i64::MAX.to_be_bytes(), "INT8"),
        Value::Bigint {
            value: i64::MAX.to_string()
        }
    );
    assert_eq!(
        decode_binary(INT8, &42i64.to_be_bytes(), "INT8"),
        Value::Int { value: 42 }
    );
    assert_eq!(
        decode_binary(OID, &u32::MAX.to_be_bytes(), "OID"),
        Value::Int {
            value: u32::MAX as i64
        }
    );
}

#[test]
fn booleans_and_floats() {
    assert_eq!(
        decode_binary(BOOL, &[1], "BOOL"),
        Value::Bool { value: true }
    );
    assert_eq!(
        decode_binary(BOOL, &[0], "BOOL"),
        Value::Bool { value: false }
    );
    assert_eq!(
        decode_binary(FLOAT8, &1.5f64.to_be_bytes(), "FLOAT8"),
        Value::Float { value: 1.5 }
    );
    // 0.1f32 keeps its short decimal form
    assert_eq!(
        decode_binary(FLOAT4, &0.1f32.to_be_bytes(), "FLOAT4"),
        Value::Float { value: 0.1 }
    );
    assert_eq!(
        decode_binary(FLOAT8, &f64::NAN.to_be_bytes(), "FLOAT8"),
        Value::other("NaN", "FLOAT8")
    );
    assert_eq!(
        decode_binary(FLOAT8, &f64::INFINITY.to_be_bytes(), "FLOAT8"),
        Value::other("Infinity", "FLOAT8")
    );
}

#[test]
fn text_bytea_and_uuid() {
    assert_eq!(
        decode_binary(TEXT, "héllo".as_bytes(), "TEXT"),
        Value::text("héllo")
    );
    assert_eq!(
        decode_binary(BYTEA, &[0xde, 0xad], "BYTEA"),
        Value::bytes(&[0xde, 0xad])
    );
    let u = uuid::Uuid::parse_str("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11").unwrap();
    assert_eq!(decode_binary(UUID, u.as_bytes(), "UUID"), Value::uuid(u));
}

#[test]
fn json_and_jsonb() {
    let v = decode_binary(JSON, br#"{"a":[1,2]}"#, "JSON");
    assert_eq!(v, Value::json(serde_json::json!({"a": [1, 2]})));
    let mut jsonb = vec![1u8];
    jsonb.extend(br#"{"b":null}"#);
    assert_eq!(
        decode_binary(JSONB, &jsonb, "JSONB"),
        Value::json(serde_json::json!({"b": null}))
    );
    // unknown jsonb version falls back instead of failing
    assert!(matches!(
        decode_binary(JSONB, &[9, b'{', b'}'], "JSONB"),
        Value::Other { .. }
    ));
}

#[test]
fn dates_and_times() {
    // 2026-10-08 is 9_777 days after 2000-01-01
    let days = (NaiveDate::from_ymd_opt(2026, 10, 8).unwrap()
        - NaiveDate::from_ymd_opt(2000, 1, 1).unwrap())
    .num_days() as i32;
    assert_eq!(
        decode_binary(DATE, &days.to_be_bytes(), "DATE"),
        Value::Date {
            value: "2026-10-08".into()
        }
    );
    assert_eq!(
        decode_binary(DATE, &i32::MAX.to_be_bytes(), "DATE"),
        Value::Date {
            value: "infinity".into()
        }
    );
    assert_eq!(
        decode_binary(DATE, &0i32.to_be_bytes(), "DATE"),
        Value::Date {
            value: "2000-01-01".into()
        }
    );

    let t = (21 * 3600 + 14 * 60 + 7) as i64 * 1_000_000 + 250_000;
    assert_eq!(
        decode_binary(TIME, &t.to_be_bytes(), "TIME"),
        Value::Time {
            value: "21:14:07.25".into()
        }
    );

    // timestamp 2026-10-08 21:14:07
    let us = (NaiveDate::from_ymd_opt(2026, 10, 8)
        .unwrap()
        .and_hms_opt(21, 14, 7)
        .unwrap()
        - pg_epoch())
    .num_microseconds()
    .unwrap();
    assert_eq!(
        decode_binary(TIMESTAMP, &us.to_be_bytes(), "TIMESTAMP"),
        Value::Timestamp {
            value: "2026-10-08T21:14:07".into()
        }
    );
    assert_eq!(
        decode_binary(TIMESTAMPTZ, &us.to_be_bytes(), "TIMESTAMPTZ"),
        Value::Timestamptz {
            value: "2026-10-08T21:14:07Z".into()
        }
    );
    assert_eq!(
        decode_binary(TIMESTAMPTZ, &i64::MIN.to_be_bytes(), "TIMESTAMPTZ"),
        Value::Timestamptz {
            value: "-infinity".into()
        }
    );
}

#[test]
fn timetz_offsets_have_the_right_sign() {
    // 12:00:00 at UTC+2: PostgreSQL stores 7200 seconds *west* as -7200
    let mut b = (12i64 * 3600 * 1_000_000).to_be_bytes().to_vec();
    b.extend((-7200i32).to_be_bytes());
    assert_eq!(
        decode_binary(TIMETZ, &b, "TIMETZ"),
        Value::Time {
            value: "12:00:00+02:00".into()
        }
    );
}

fn interval(micros: i64, days: i32, months: i32) -> Vec<u8> {
    let mut b = micros.to_be_bytes().to_vec();
    b.extend(days.to_be_bytes());
    b.extend(months.to_be_bytes());
    b
}

#[test]
fn intervals_are_iso_8601() {
    let iv = |us, d, m| decode_binary(INTERVAL, &interval(us, d, m), "INTERVAL");
    let s = |t: &str| Value::Interval { value: t.into() };
    assert_eq!(iv(0, 0, 0), s("PT0S"));
    assert_eq!(
        iv((2 * 3600 + 30 * 60) * 1_000_000, 1, 14),
        s("P1Y2M1DT2H30M")
    );
    assert_eq!(iv(1_500_000, 0, 0), s("PT1.5S"));
    assert_eq!(iv(-3_600_000_000, 0, 0), s("PT-1H"));
    assert_eq!(iv(0, -3, 0), s("P-3D"));
}

#[test]
fn network_and_bit_types_are_read_only_other() {
    let inet = [2, 24, 0, 4, 192, 168, 1, 0];
    assert_eq!(
        decode_binary(INET, &inet, "INET"),
        Value::other("192.168.1.0/24", "INET")
    );
    let host = [2, 32, 0, 4, 10, 0, 0, 1];
    assert_eq!(
        decode_binary(INET, &host, "INET"),
        Value::other("10.0.0.1", "INET")
    );
    let mac = [0x08, 0x00, 0x2b, 0x01, 0x02, 0x03];
    assert_eq!(
        decode_binary(MACADDR, &mac, "MACADDR"),
        Value::other("08:00:2b:01:02:03", "MACADDR")
    );
    let bits = [0, 0, 0, 5, 0b1010_1000];
    assert_eq!(
        decode_binary(BIT, &bits, "BIT"),
        Value::other("10101", "BIT")
    );
    assert_eq!(
        decode_binary(MONEY, &1234i64.to_be_bytes(), "MONEY"),
        Value::other("12.34", "MONEY")
    );
    assert!(decode_binary(INET, &inet, "INET").is_read_only());
}

#[test]
fn unknown_types_fall_back_to_other_with_hex() {
    let v = decode_binary(99999, &[0xde, 0xad], "mystery");
    assert_eq!(v, Value::other("\\xdead", "mystery"));
    assert!(v.is_read_only());
}

#[test]
fn truncated_input_never_panics() {
    for oid in [
        BOOL,
        INT2,
        INT4,
        INT8,
        FLOAT4,
        FLOAT8,
        NUMERIC,
        DATE,
        TIME,
        TIMETZ,
        TIMESTAMP,
        TIMESTAMPTZ,
        INTERVAL,
        UUID,
        INET,
        BIT,
        MONEY,
    ] {
        let v = decode_binary(oid, &[1], "x");
        assert!(
            matches!(v, Value::Other { .. } | Value::Bool { .. }),
            "oid {oid}: {v:?}"
        );
    }
}

/// Build a binary array of int4: `dims` with elements row-major, `None` = NULL.
fn int4_array(dims: &[i32], elems: &[Option<i32>]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend((dims.len() as i32).to_be_bytes());
    b.extend((elems.iter().any(Option::is_none) as i32).to_be_bytes());
    b.extend((INT4 as i32).to_be_bytes());
    for d in dims {
        b.extend(d.to_be_bytes());
        b.extend(1i32.to_be_bytes());
    }
    for e in elems {
        match e {
            Some(v) => {
                b.extend(4i32.to_be_bytes());
                b.extend(v.to_be_bytes());
            }
            None => b.extend((-1i32).to_be_bytes()),
        }
    }
    b
}

fn ints(values: &[i64]) -> Value {
    Value::Array {
        value: values.iter().map(|v| Value::Int { value: *v }).collect(),
    }
}

#[test]
fn arrays_decode_with_nulls_and_nesting() {
    let b = int4_array(&[3], &[Some(1), None, Some(3)]);
    assert_eq!(
        decode_array(&b, "INT4[]"),
        Value::Array {
            value: vec![
                Value::Int { value: 1 },
                Value::Null,
                Value::Int { value: 3 }
            ]
        }
    );
    let nested = int4_array(&[2, 2], &[Some(1), Some(2), Some(3), Some(4)]);
    assert_eq!(
        decode_array(&nested, "INT4[]"),
        Value::Array {
            value: vec![ints(&[1, 2]), ints(&[3, 4])]
        }
    );
    // empty array
    let mut empty = Vec::new();
    empty.extend(0i32.to_be_bytes());
    empty.extend(0i32.to_be_bytes());
    empty.extend((INT4 as i32).to_be_bytes());
    assert_eq!(
        decode_array(&empty, "INT4[]"),
        Value::Array { value: vec![] }
    );
}

#[test]
fn text_arrays_and_enum_like_elements() {
    let mut b = Vec::new();
    b.extend(1i32.to_be_bytes());
    b.extend(0i32.to_be_bytes());
    b.extend(99999i32.to_be_bytes()); // an oid we don't know: treated as text (e.g. an enum)
    b.extend(2i32.to_be_bytes());
    b.extend(1i32.to_be_bytes());
    for t in ["new", "paid"] {
        b.extend((t.len() as i32).to_be_bytes());
        b.extend(t.as_bytes());
    }
    assert_eq!(
        decode_array(&b, "order_status[]"),
        Value::Array {
            value: vec![Value::text("new"), Value::text("paid")]
        }
    );
}

#[test]
fn a_corrupt_array_falls_back() {
    assert!(matches!(
        decode_array(&[0, 0, 0, 1], "INT4[]"),
        Value::Other { .. }
    ));
}

#[test]
fn kinds_follow_the_type() {
    assert_eq!(kind_for_oid(INT8), ValueKind::Bigint);
    assert_eq!(kind_for_oid(NUMERIC), ValueKind::Decimal);
    assert_eq!(kind_for_oid(TIMESTAMPTZ), ValueKind::Timestamptz);
    assert_eq!(kind_for_oid(JSONB), ValueKind::Json);
    assert_eq!(kind_for_oid(99999), ValueKind::Other);
}

#[test]
fn points_and_postgis_have_server_style_text() {
    let mut p = 1.0f64.to_be_bytes().to_vec();
    p.extend(2.5f64.to_be_bytes());
    assert_eq!(
        decode_binary(POINT, &p, "point"),
        Value::other("(1,2.5)", "point")
    );
    assert_eq!(
        decode_binary(99999, &[0x01, 0xab], "geometry"),
        Value::other("01AB", "geometry")
    );
}
