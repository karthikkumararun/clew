//! Console-line tokenizing, reply conversion, and the checks that keep the console from hanging.

use redis::aio::MultiplexedConnection;
use redis::Value;

use super::map_err;
use crate::drivers::nosql::RedisValue;
use crate::drivers::{DriverError, DriverResult, ErrorCode};

/// Split a console line the way `redis-cli` does: whitespace separates arguments; double quotes
/// allow `\n \r \t \b \a \\ \" \xHH` escapes; single quotes are literal except `\'`.
pub fn tokenize(line: &str) -> Result<Vec<String>, String> {
    Ok(tokenize_bytes(line)?
        .into_iter()
        .map(|a| String::from_utf8_lossy(&a).into_owned())
        .collect())
}

/// Like [`tokenize`], keeping the exact bytes (`"\xff"` is one byte, not U+FFFD).
pub fn tokenize_bytes(line: &str) -> Result<Vec<Vec<u8>>, String> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let mut cur: Vec<u8> = Vec::new();
        let push = |cur: &mut Vec<u8>, c: char| {
            let mut buf = [0u8; 4];
            cur.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        };
        match chars[i] {
            '"' => {
                i += 1;
                loop {
                    let Some(&c) = chars.get(i) else {
                        return Err("Unbalanced quotes in the command".into());
                    };
                    i += 1;
                    match c {
                        '"' => break,
                        '\\' => {
                            let Some(&e) = chars.get(i) else {
                                return Err("Unbalanced quotes in the command".into());
                            };
                            i += 1;
                            match e {
                                'n' => cur.push(b'\n'),
                                'r' => cur.push(b'\r'),
                                't' => cur.push(b'\t'),
                                'b' => cur.push(8),
                                'a' => cur.push(7),
                                'x' if i + 1 < chars.len() => {
                                    let hex: String = chars[i..i + 2].iter().collect();
                                    match u8::from_str_radix(&hex, 16) {
                                        Ok(b) => {
                                            cur.push(b);
                                            i += 2;
                                        }
                                        Err(_) => cur.extend_from_slice(b"x"),
                                    }
                                }
                                other => push(&mut cur, other),
                            }
                        }
                        c => push(&mut cur, c),
                    }
                }
                if chars.get(i).is_some_and(|c| !c.is_whitespace()) {
                    return Err("Unbalanced quotes in the command".into());
                }
            }
            '\'' => {
                i += 1;
                loop {
                    let Some(&c) = chars.get(i) else {
                        return Err("Unbalanced quotes in the command".into());
                    };
                    i += 1;
                    match c {
                        '\'' => break,
                        '\\' if chars.get(i) == Some(&'\'') => {
                            cur.push(b'\'');
                            i += 1;
                        }
                        c => push(&mut cur, c),
                    }
                }
                if chars.get(i).is_some_and(|c| !c.is_whitespace()) {
                    return Err("Unbalanced quotes in the command".into());
                }
            }
            _ => {
                while chars.get(i).is_some_and(|c| !c.is_whitespace()) {
                    push(&mut cur, chars[i]);
                    i += 1;
                }
            }
        }
        out.push(cur);
    }
    Ok(out)
}

/// Commands that keep a connection busy indefinitely or switch it into a streaming mode.
/// Returns the reason shown to the user.
pub fn refuse_blocking(args: &[String]) -> Option<String> {
    let name = args.first()?.to_ascii_uppercase();
    let streaming = [
        "MONITOR",
        "SUBSCRIBE",
        "PSUBSCRIBE",
        "SSUBSCRIBE",
        "SYNC",
        "PSYNC",
    ];
    if streaming.contains(&name.as_str()) {
        return Some(format!(
            "{name} streams data until the connection closes, so it can't run in the console."
        ));
    }
    let timeout_last = [
        "BLPOP",
        "BRPOP",
        "BRPOPLPUSH",
        "BLMOVE",
        "BZPOPMIN",
        "BZPOPMAX",
        "BLMPOP",
        "BZMPOP",
    ];
    if timeout_last.contains(&name.as_str()) {
        // the timeout is the last argument, except BLMPOP / BZMPOP where it is the first
        let t = if matches!(name.as_str(), "BLMPOP" | "BZMPOP") {
            args.get(1)
        } else {
            args.last()
        };
        let infinite = t
            .and_then(|t| t.parse::<f64>().ok())
            .is_some_and(|t| t == 0.0);
        if infinite || t.is_none() {
            return Some(format!(
                "{name} with no timeout would wait forever. Give it a timeout above 0 seconds."
            ));
        }
    }
    if matches!(name.as_str(), "XREAD" | "XREADGROUP") {
        let block = args
            .iter()
            .position(|a| a.eq_ignore_ascii_case("BLOCK"))
            .and_then(|i| args.get(i + 1));
        if block.and_then(|b| b.parse::<u64>().ok()) == Some(0) {
            return Some(format!(
                "{name} BLOCK 0 would wait forever. Give BLOCK a timeout in milliseconds."
            ));
        }
    }
    None
}

fn bytes_to_value(b: Vec<u8>) -> RedisValue {
    match String::from_utf8(b) {
        Ok(value) => RedisValue::Text { value },
        Err(e) => {
            let bytes = e.into_bytes();
            let len = bytes.len() as u64;
            let hex = bytes
                .iter()
                .take(2048)
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            RedisValue::Bytes { hex, len }
        }
    }
}

pub fn convert(v: Value) -> RedisValue {
    match v {
        Value::Nil => RedisValue::Nil,
        Value::Int(value) => RedisValue::Int { value },
        Value::BulkString(b) => bytes_to_value(b),
        Value::Array(items) | Value::Set(items) => RedisValue::Array {
            items: items.into_iter().map(convert).collect(),
        },
        Value::SimpleString(value) => RedisValue::Status { value },
        Value::Okay => RedisValue::Status { value: "OK".into() },
        Value::Map(entries) => RedisValue::Map {
            entries: entries
                .into_iter()
                .map(|(k, v)| (convert(k), convert(v)))
                .collect(),
        },
        Value::Attribute { data, .. } => convert(*data),
        Value::Double(value) => RedisValue::Double { value },
        Value::Boolean(value) => RedisValue::Bool { value },
        Value::VerbatimString { text, .. } => RedisValue::Text { value: text },
        Value::BigNumber(n) => RedisValue::Text {
            value: format!("{n:?}"),
        },
        Value::ServerError(e) => RedisValue::Error {
            message: format!("{} {}", e.code(), e.details().unwrap_or_default())
                .trim()
                .to_string(),
        },
        _ => RedisValue::Nil,
    }
}

/// Plain text of a reply that is expected to be a string.
pub fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::BulkString(b) => String::from_utf8(b.clone()).ok(),
        Value::SimpleString(s) => Some(s.clone()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        Value::Int(n) => Some(n.to_string()),
        _ => None,
    }
}

/// `(db index, key count)` for every database with keys, and the number of databases.
pub async fn keyspaces(conn: &mut MultiplexedConnection) -> DriverResult<(Vec<(u32, u64)>, u32)> {
    let info: String = redis::cmd("INFO")
        .arg("keyspace")
        .query_async(conn)
        .await
        .map_err(map_err)?;
    let mut items = Vec::new();
    for line in info.lines() {
        let Some(rest) = line.strip_prefix("db") else {
            continue;
        };
        let Some((idx, fields)) = rest.split_once(':') else {
            continue;
        };
        let Ok(idx) = idx.parse::<u32>() else {
            continue;
        };
        let keys = fields
            .split(',')
            .find_map(|f| f.strip_prefix("keys="))
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        items.push((idx, keys));
    }
    // CONFIG may be disabled (managed services): fall back to the default of 16.
    let databases = redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async::<Vec<String>>(conn)
        .await
        .ok()
        .and_then(|v| v.get(1).and_then(|n| n.parse().ok()))
        .unwrap_or(16);
    Ok((items, databases))
}

pub fn invalid(message: impl Into<String>) -> DriverError {
    DriverError::new(ErrorCode::QueryFailed, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Vec<String> {
        tokenize(s).unwrap()
    }

    #[test]
    fn tokenizes_like_redis_cli() {
        assert_eq!(t("HGETALL session:42"), ["HGETALL", "session:42"]);
        assert_eq!(t("  SET  k   v  "), ["SET", "k", "v"]);
        assert_eq!(t(r#"SET k "hello world""#), ["SET", "k", "hello world"]);
        assert_eq!(t(r#"SET k "a\nb\x41\"q""#), ["SET", "k", "a\nbA\"q"]);
        assert_eq!(t(r"SET k 'it\'s $x\n'"), ["SET", "k", "it's $x\\n"]);
        assert_eq!(t(r#"SET k """#), ["SET", "k", ""]);
        assert!(tokenize(r#"SET k "open"#).is_err());
        assert!(tokenize(r#"SET k "a"b"#).is_err());
        assert!(t("   ").is_empty());
    }

    fn blocked(s: &str) -> Option<String> {
        refuse_blocking(&t(s))
    }

    #[test]
    fn blocking_commands_are_refused_with_a_reason() {
        assert!(blocked("MONITOR").unwrap().contains("MONITOR"));
        assert!(blocked("subscribe news").is_some());
        assert!(blocked("BLPOP q 0").unwrap().contains("no timeout"));
        assert!(blocked("BLPOP q1 q2 0.0").is_some());
        assert!(blocked("BLPOP q 2").is_none());
        assert!(blocked("BLMPOP 0 1 q LEFT").is_some());
        assert!(blocked("BLMPOP 5 1 q LEFT").is_none());
        assert!(blocked("XREAD BLOCK 0 STREAMS s $").is_some());
        assert!(blocked("XREAD BLOCK 100 STREAMS s $").is_none());
        assert!(blocked("XREAD STREAMS s 0").is_none());
        assert!(blocked("GET k").is_none());
    }

    #[test]
    fn replies_convert_by_type() {
        assert_eq!(convert(Value::Nil), RedisValue::Nil);
        assert_eq!(
            convert(Value::Okay),
            RedisValue::Status { value: "OK".into() }
        );
        assert_eq!(
            convert(Value::BulkString(b"hi".to_vec())),
            RedisValue::Text { value: "hi".into() }
        );
        assert!(matches!(
            convert(Value::BulkString(vec![0xff, 0x00, 0x10])),
            RedisValue::Bytes { ref hex, len: 3 } if hex == "ff0010"
        ));
        assert!(matches!(
            convert(Value::Array(vec![Value::Int(1), Value::Nil])),
            RedisValue::Array { items } if items.len() == 2
        ));
    }
}

// ---- console results as tables ---------------------------------------------------------------------

use crate::drivers::{ColumnMeta, Value as GridValue, ValueKind};

fn json_of(v: &RedisValue) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        RedisValue::Nil => J::Null,
        RedisValue::Int { value } => J::from(*value),
        RedisValue::Double { value } => {
            serde_json::Number::from_f64(*value).map_or(J::Null, J::Number)
        }
        RedisValue::Bool { value } => J::Bool(*value),
        RedisValue::Status { value } | RedisValue::Text { value } => J::String(value.clone()),
        RedisValue::Bytes { hex, .. } => J::String(format!("0x{hex}")),
        RedisValue::Array { items } => J::Array(items.iter().map(json_of).collect()),
        RedisValue::Map { entries } => J::Object(
            entries
                .iter()
                .map(|(k, v)| {
                    let key = match k {
                        RedisValue::Text { value } | RedisValue::Status { value } => value.clone(),
                        other => json_of(other).to_string(),
                    };
                    (key, json_of(v))
                })
                .collect(),
        ),
        RedisValue::Error { message } => J::String(message.clone()),
    }
}

fn grid_value(v: &RedisValue) -> GridValue {
    match v {
        RedisValue::Nil => GridValue::Null,
        RedisValue::Int { value } => GridValue::from_i64(*value),
        RedisValue::Double { value } => GridValue::from_f64(*value),
        RedisValue::Bool { value } => GridValue::Bool { value: *value },
        RedisValue::Status { value } | RedisValue::Text { value } => GridValue::text(value.clone()),
        RedisValue::Bytes { hex, len } => GridValue::Bytes {
            value: hex.clone(),
            len: *len,
            truncated: false,
        },
        RedisValue::Error { message } => GridValue::text(message.clone()),
        RedisValue::Array { .. } | RedisValue::Map { .. } => GridValue::json(json_of(v)),
    }
}

fn kind_of(v: &GridValue) -> ValueKind {
    match v {
        GridValue::Bool { .. } => ValueKind::Bool,
        GridValue::Int { .. } => ValueKind::Int,
        GridValue::Bigint { .. } => ValueKind::Bigint,
        GridValue::Float { .. } => ValueKind::Float,
        GridValue::Bytes { .. } => ValueKind::Bytes,
        GridValue::Json { .. } => ValueKind::Json,
        _ => ValueKind::Text,
    }
}

fn column(name: &str, sample: Option<&GridValue>) -> ColumnMeta {
    ColumnMeta {
        name: name.into(),
        type_name: match sample {
            Some(GridValue::Int { .. } | GridValue::Bigint { .. }) => "integer",
            Some(GridValue::Float { .. }) => "double",
            Some(GridValue::Bool { .. }) => "boolean",
            Some(GridValue::Bytes { .. }) => "binary",
            Some(GridValue::Json { .. }) => "array",
            _ => "string",
        }
        .into(),
        kind: sample.map_or(ValueKind::Text, kind_of),
        nullable: Some(true),
        source_table: None,
        source_column: None,
    }
}

/// Replies that are flat `[a1, b1, a2, b2, …]` pairs, with the names of the two columns.
fn pair_columns(args: &[String]) -> Option<(&'static str, &'static str)> {
    let name = args.first()?.to_ascii_uppercase();
    let sub = args.get(1).map(|s| s.to_ascii_uppercase());
    let with_scores = args.iter().any(|a| a.eq_ignore_ascii_case("WITHSCORES"));
    match name.as_str() {
        "HGETALL" => Some(("field", "value")),
        "CONFIG" if sub.as_deref() == Some("GET") => Some(("parameter", "value")),
        "ZPOPMIN" | "ZPOPMAX" => Some(("member", "score")),
        "ZRANGE" | "ZREVRANGE" | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" if with_scores => {
            Some(("member", "score"))
        }
        _ => None,
    }
}

/// A console reply as grid columns and rows: a map or a field/value reply as two columns, a list
/// as `# / value`, anything else as one `reply` cell.
pub fn reply_table(args: &[String], reply: &RedisValue) -> (Vec<ColumnMeta>, Vec<Vec<GridValue>>) {
    match reply {
        RedisValue::Map { entries } => {
            let rows: Vec<Vec<GridValue>> = entries
                .iter()
                .map(|(k, v)| vec![grid_value(k), grid_value(v)])
                .collect();
            let cols = vec![
                column("field", rows.first().map(|r| &r[0])),
                column("value", rows.first().map(|r| &r[1])),
            ];
            (cols, rows)
        }
        RedisValue::Array { items } => {
            if let Some((a, b)) = pair_columns(args) {
                let rows: Vec<Vec<GridValue>> = items
                    .chunks(2)
                    .map(|c| {
                        vec![
                            grid_value(&c[0]),
                            c.get(1).map_or(GridValue::Null, grid_value),
                        ]
                    })
                    .collect();
                let cols = vec![
                    column(a, rows.first().map(|r| &r[0])),
                    column(b, rows.first().map(|r| &r[1])),
                ];
                return (cols, rows);
            }
            let rows: Vec<Vec<GridValue>> = items
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    vec![
                        GridValue::Int {
                            value: i as i64 + 1,
                        },
                        grid_value(v),
                    ]
                })
                .collect();
            let cols = vec![
                column("#", Some(&GridValue::Int { value: 0 })),
                column("value", rows.first().map(|r| &r[1])),
            ];
            (cols, rows)
        }
        other => {
            let v = grid_value(other);
            (vec![column("reply", Some(&v))], vec![vec![v]])
        }
    }
}

#[cfg(test)]
mod table_tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        tokenize(s).unwrap()
    }
    fn t(s: &str) -> RedisValue {
        RedisValue::Text { value: s.into() }
    }

    #[test]
    fn a_field_value_reply_becomes_two_columns() {
        let reply = RedisValue::Array {
            items: vec![t("plan"), t("pro"), t("seats"), t("3")],
        };
        let (cols, rows) = reply_table(&args("HGETALL session:42"), &reply);
        assert_eq!(
            cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["field", "value"]
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[1],
            vec![GridValue::text("seats"), GridValue::text("3")]
        );
    }

    #[test]
    fn scored_replies_are_member_and_score() {
        let reply = RedisValue::Array {
            items: vec![t("a"), t("1"), t("b"), t("2")],
        };
        let (cols, _) = reply_table(&args("ZRANGE z 0 -1 WITHSCORES"), &reply);
        assert_eq!(cols[1].name, "score");
        let (cols, rows) = reply_table(&args("ZRANGE z 0 -1"), &reply);
        assert_eq!((cols[0].name.as_str(), rows.len()), ("#", 4));
    }

    #[test]
    fn scalars_are_one_reply_cell() {
        let (cols, rows) = reply_table(&args("GET k"), &t("v"));
        assert_eq!(cols[0].name, "reply");
        assert_eq!(rows, vec![vec![GridValue::text("v")]]);
        let (_, rows) = reply_table(&args("GET missing"), &RedisValue::Nil);
        assert_eq!(rows, vec![vec![GridValue::Null]]);
        let (cols, rows) = reply_table(&args("INCR n"), &RedisValue::Int { value: 4 });
        assert_eq!(
            (cols[0].kind, rows[0][0].clone()),
            (ValueKind::Int, GridValue::Int { value: 4 })
        );
    }

    #[test]
    fn nested_replies_stay_json() {
        let reply = RedisValue::Array {
            items: vec![RedisValue::Array {
                items: vec![
                    t("1-1"),
                    RedisValue::Array {
                        items: vec![t("k"), t("v")],
                    },
                ],
            }],
        };
        let (_, rows) = reply_table(&args("XRANGE s - +"), &reply);
        assert!(matches!(rows[0][1], GridValue::Json { .. }));
    }
}
