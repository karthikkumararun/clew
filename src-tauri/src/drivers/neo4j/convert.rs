//! Bolt values to the value model, and query parameters (JSON) to Bolt values.

use std::collections::{BTreeMap, HashSet};

use chrono::{
    DateTime, Duration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike,
};

use super::bolt::Ps;
use crate::drivers::graph::{GraphNode, GraphRel};
use crate::drivers::Value;

/// Collects the distinct nodes and relationships met while converting the records of a result.
#[derive(Default)]
pub struct Elements {
    pub nodes: Vec<GraphNode>,
    pub relationships: Vec<GraphRel>,
    seen_nodes: HashSet<String>,
    seen_rels: HashSet<String>,
}

impl Elements {
    fn node(&mut self, n: &GraphNode) {
        if self.seen_nodes.insert(n.element_id.clone()) {
            self.nodes.push(n.clone());
        }
    }

    fn rel(&mut self, r: &GraphRel) {
        if self.seen_rels.insert(r.element_id.clone()) {
            self.relationships.push(r.clone());
        }
    }
}

fn text_at(fields: &[Ps], i: usize) -> Option<String> {
    fields.get(i).and_then(Ps::as_str).map(str::to_string)
}

fn int_at(fields: &[Ps], i: usize) -> i64 {
    fields.get(i).and_then(Ps::as_i64).unwrap_or(0)
}

fn props(ps: Option<&Ps>) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (k, v) in ps.and_then(Ps::as_map).unwrap_or_default() {
        out.insert(k.clone(), plain(v));
    }
    out
}

/// A node struct: `[id, labels, properties, element_id?]` (the element id arrives with Bolt 5).
fn node_of(fields: &[Ps]) -> GraphNode {
    let id = int_at(fields, 0);
    GraphNode {
        element_id: text_at(fields, 3).unwrap_or_else(|| id.to_string()),
        labels: fields
            .get(1)
            .and_then(Ps::as_list)
            .unwrap_or_default()
            .iter()
            .filter_map(|l| l.as_str().map(str::to_string))
            .collect(),
        properties: props(fields.get(2)),
    }
}

/// A relationship struct: `[id, start, end, type, properties, element_id?, start_el?, end_el?]`.
fn rel_of(fields: &[Ps]) -> GraphRel {
    let id = int_at(fields, 0);
    GraphRel {
        element_id: text_at(fields, 5).unwrap_or_else(|| id.to_string()),
        rel_type: text_at(fields, 3).unwrap_or_default(),
        start_id: text_at(fields, 6).unwrap_or_else(|| int_at(fields, 1).to_string()),
        end_id: text_at(fields, 7).unwrap_or_else(|| int_at(fields, 2).to_string()),
        properties: props(fields.get(4)),
    }
}

/// A relationship inside a path: `[id, type, properties, element_id?]`, ends given by the path.
fn unbound_rel_of(fields: &[Ps]) -> GraphRel {
    let id = int_at(fields, 0);
    GraphRel {
        element_id: text_at(fields, 3).unwrap_or_else(|| id.to_string()),
        rel_type: text_at(fields, 1).unwrap_or_default(),
        start_id: String::new(),
        end_id: String::new(),
        properties: props(fields.get(2)),
    }
}

/// A path struct `[nodes, relationships, indices]`: the indices alternate a relationship (1-based,
/// negative when walked backwards) and the next node.
fn path_of(fields: &[Ps]) -> (Vec<GraphNode>, Vec<GraphRel>) {
    let nodes: Vec<GraphNode> = fields
        .first()
        .and_then(Ps::as_list)
        .unwrap_or_default()
        .iter()
        .filter_map(|n| match n {
            Ps::Struct { tag: 0x4E, fields } => Some(node_of(fields)),
            _ => None,
        })
        .collect();
    let unbound: Vec<GraphRel> = fields
        .get(1)
        .and_then(Ps::as_list)
        .unwrap_or_default()
        .iter()
        .filter_map(|r| match r {
            Ps::Struct { tag: 0x72, fields } => Some(unbound_rel_of(fields)),
            _ => None,
        })
        .collect();
    let indices: Vec<i64> = fields
        .get(2)
        .and_then(Ps::as_list)
        .unwrap_or_default()
        .iter()
        .filter_map(Ps::as_i64)
        .collect();
    let mut rels = Vec::new();
    let mut current = 0usize;
    for pair in indices.chunks(2) {
        let [rel_index, next_index] = pair else { break };
        let (Some(next), Some(rel)) = (
            nodes.get(*next_index as usize),
            unbound.get(rel_index.unsigned_abs() as usize - 1),
        ) else {
            break;
        };
        let here = &nodes[current.min(nodes.len() - 1)];
        let mut rel = rel.clone();
        if *rel_index > 0 {
            rel.start_id = here.element_id.clone();
            rel.end_id = next.element_id.clone();
        } else {
            rel.start_id = next.element_id.clone();
            rel.end_id = here.element_id.clone();
        }
        rels.push(rel);
        current = *next_index as usize;
    }
    (nodes, rels)
}

/// A value of a record cell. Graph values are also added to `elements`.
pub fn convert(ps: &Ps, elements: &mut Elements) -> Value {
    match ps {
        Ps::Struct { tag: 0x4E, fields } => {
            let n = node_of(fields);
            elements.node(&n);
            Value::Node {
                element_id: n.element_id,
                labels: n.labels,
                properties: n.properties,
            }
        }
        Ps::Struct { tag: 0x52, fields } => {
            let r = rel_of(fields);
            elements.rel(&r);
            Value::Relationship {
                element_id: r.element_id,
                rel_type: r.rel_type,
                start_id: r.start_id,
                end_id: r.end_id,
                properties: r.properties,
            }
        }
        Ps::Struct { tag: 0x50, fields } => {
            let (nodes, rels) = path_of(fields);
            nodes.iter().for_each(|n| elements.node(n));
            rels.iter().for_each(|r| elements.rel(r));
            Value::Path {
                nodes,
                relationships: rels,
            }
        }
        Ps::List(items) => Value::Array {
            value: items.iter().map(|i| convert(i, elements)).collect(),
        },
        Ps::Map(entries) => {
            let mut object = serde_json::Map::new();
            for (k, v) in entries {
                object.insert(k.clone(), plain_json(&convert(v, elements)));
            }
            Value::Json {
                value: serde_json::Value::Object(object),
            }
        }
        other => plain(other),
    }
}

/// A value without graph elements (a property, or a scalar).
pub fn plain(ps: &Ps) -> Value {
    match ps {
        Ps::Null => Value::Null,
        Ps::Bool(b) => Value::Bool { value: *b },
        Ps::Int(i) => Value::from_i64(*i),
        Ps::Float(f) => Value::from_f64(*f),
        Ps::Str(s) => Value::text(s.clone()),
        Ps::Bytes(b) => Value::bytes(b),
        Ps::List(items) => Value::Array {
            value: items.iter().map(plain).collect(),
        },
        Ps::Map(_) => {
            let mut scratch = Elements::default();
            convert(ps, &mut scratch)
        }
        Ps::Struct { tag, fields } => temporal(*tag, fields)
            .unwrap_or_else(|| Value::other(format!("{ps:?}"), format!("bolt struct 0x{tag:02X}"))),
    }
}

/// The JSON a value takes inside a map: plain scalars stay plain, integers beyond JavaScript's
/// safe range and everything without a JSON form become strings, graph values stay tagged.
fn plain_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Bool { value } => J::Bool(*value),
        Value::Int { value } => J::from(*value),
        Value::Float { value } => serde_json::Number::from_f64(*value).map_or(J::Null, J::Number),
        Value::Bigint { value }
        | Value::Decimal { value }
        | Value::Text { value, .. }
        | Value::Date { value }
        | Value::Time { value }
        | Value::Timestamp { value }
        | Value::Timestamptz { value }
        | Value::Interval { value }
        | Value::Uuid { value }
        | Value::Other { value, .. }
        | Value::Bytes { value, .. } => J::String(value.clone()),
        Value::Json { value } => value.clone(),
        Value::Array { value } => J::Array(value.iter().map(plain_json).collect()),
        Value::Node { .. } | Value::Relationship { .. } | Value::Path { .. } => {
            serde_json::to_value(v).unwrap_or(J::Null)
        }
    }
}

// ---- temporal and spatial types ------------------------------------------------------------

fn epoch() -> NaiveDate {
    NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid date")
}

fn nanos_text(nanos: u32) -> String {
    if nanos == 0 {
        String::new()
    } else {
        format!(".{nanos:09}").trim_end_matches('0').to_string()
    }
}

fn time_text(t: NaiveTime) -> String {
    format!("{}{}", t.format("%H:%M:%S"), nanos_text(t.nanosecond()))
}

fn local_time(nanos_of_day: i64) -> Option<NaiveTime> {
    let secs = u32::try_from(nanos_of_day.div_euclid(1_000_000_000)).ok()?;
    let nanos = u32::try_from(nanos_of_day.rem_euclid(1_000_000_000)).ok()?;
    NaiveTime::from_num_seconds_from_midnight_opt(secs, nanos)
}

fn offset_text(seconds: i64) -> String {
    let sign = if seconds < 0 { '-' } else { '+' };
    let abs = seconds.abs();
    let (h, m, s) = (abs / 3600, abs % 3600 / 60, abs % 60);
    if s == 0 {
        format!("{sign}{h:02}:{m:02}")
    } else {
        format!("{sign}{h:02}:{m:02}:{s:02}")
    }
}

fn local_datetime(seconds: i64, nanos: i64) -> Option<NaiveDateTime> {
    DateTime::from_timestamp(seconds, u32::try_from(nanos).ok()?).map(|d| d.naive_utc())
}

fn timestamptz(t: DateTime<FixedOffset>) -> Value {
    Value::timestamptz(t)
}

fn temporal(tag: u8, f: &[Ps]) -> Option<Value> {
    Some(match tag {
        // Date: days since 1970-01-01
        0x44 => Value::date(epoch().checked_add_signed(Duration::try_days(int_at(f, 0))?)?),
        // Time: nanoseconds since midnight, offset seconds
        0x54 => Value::Time {
            value: format!(
                "{}{}",
                time_text(local_time(int_at(f, 0))?),
                offset_text(int_at(f, 1))
            ),
        },
        // LocalTime
        0x74 => Value::Time {
            value: time_text(local_time(int_at(f, 0))?),
        },
        // DateTime (Bolt 5): seconds since the epoch in UTC, nanoseconds, offset seconds
        0x49 => {
            let utc = DateTime::from_timestamp(int_at(f, 0), u32::try_from(int_at(f, 1)).ok()?)?;
            let offset = FixedOffset::east_opt(i32::try_from(int_at(f, 2)).ok()?)?;
            timestamptz(utc.with_timezone(&offset))
        }
        // DateTime (Bolt 4.4): seconds are the wall clock read as if it were UTC
        0x46 => {
            let wall = local_datetime(int_at(f, 0), int_at(f, 1))?;
            let offset = FixedOffset::east_opt(i32::try_from(int_at(f, 2)).ok()?)?;
            timestamptz(offset.from_local_datetime(&wall).single()?)
        }
        // DateTimeZoneId (Bolt 5): UTC seconds, nanoseconds, zone id
        0x69 => {
            let utc = DateTime::from_timestamp(int_at(f, 0), u32::try_from(int_at(f, 1)).ok()?)?;
            let zone: chrono_tz::Tz = text_at(f, 2)?.parse().ok()?;
            let local = utc.with_timezone(&zone);
            timestamptz(local.with_timezone(&local.offset().fix()))
        }
        // DateTimeZoneId (Bolt 4.4): wall clock seconds
        0x66 => {
            let wall = local_datetime(int_at(f, 0), int_at(f, 1))?;
            let zone: chrono_tz::Tz = text_at(f, 2)?.parse().ok()?;
            let local = zone.from_local_datetime(&wall).earliest()?;
            timestamptz(local.with_timezone(&local.offset().fix()))
        }
        // LocalDateTime
        0x64 => Value::timestamp(local_datetime(int_at(f, 0), int_at(f, 1))?),
        // Duration: months, days, seconds, nanoseconds
        0x45 => Value::Interval {
            value: duration_text(int_at(f, 0), int_at(f, 1), int_at(f, 2), int_at(f, 3)),
        },
        // Point2D / Point3D: srid, x, y[, z]
        0x58 | 0x59 => {
            let coord = |i: usize| f.get(i).and_then(Ps::as_f64).unwrap_or(f64::NAN);
            let mut text = format!(
                "point({{srid: {}, x: {}, y: {}",
                int_at(f, 0),
                coord(1),
                coord(2)
            );
            if tag == 0x59 {
                text.push_str(&format!(", z: {}", coord(3)));
            }
            text.push_str("})");
            Value::other(text, "Point")
        }
        _ => return None,
    })
}

use chrono::Offset;

/// Neo4j's own text form: `P1Y2M3DT4H5M6.789S`; a zero duration is `PT0S`.
pub fn duration_text(months: i64, days: i64, seconds: i64, nanos: i64) -> String {
    let mut out = String::from("P");
    let (years, months) = (months / 12, months % 12);
    for (n, unit) in [(years, 'Y'), (months, 'M'), (days, 'D')] {
        if n != 0 {
            out.push_str(&format!("{n}{unit}"));
        }
    }
    let total = i128::from(seconds) * 1_000_000_000 + i128::from(nanos);
    if total != 0 {
        out.push('T');
        let negative = total < 0;
        let abs = total.unsigned_abs();
        let (h, rest) = (abs / 3_600_000_000_000, abs % 3_600_000_000_000);
        let (m, rest) = (rest / 60_000_000_000, rest % 60_000_000_000);
        let (s, frac) = (rest / 1_000_000_000, (rest % 1_000_000_000) as u32);
        let sign = if negative { "-" } else { "" };
        if h != 0 {
            out.push_str(&format!("{sign}{h}H"));
        }
        if m != 0 {
            out.push_str(&format!("{sign}{m}M"));
        }
        if s != 0 || frac != 0 {
            out.push_str(&format!("{sign}{s}{}S", nanos_text(frac)));
        }
    }
    if out == "P" {
        out.push_str("T0S");
    }
    out
}

// ---- parameters ----------------------------------------------------------------------------

/// JSON parameters to Bolt values. `{"kind": "bigint", "value": "9007199254740993"}` is how the
/// frontend sends an integer beyond JavaScript's safe range.
pub fn json_to_ps(v: &serde_json::Value) -> Ps {
    use serde_json::Value as J;
    match v {
        J::Null => Ps::Null,
        J::Bool(b) => Ps::Bool(*b),
        J::Number(n) => n
            .as_i64()
            .map(Ps::Int)
            .unwrap_or_else(|| Ps::Float(n.as_f64().unwrap_or(f64::NAN))),
        J::String(s) => Ps::Str(s.clone()),
        J::Array(a) => Ps::List(a.iter().map(json_to_ps).collect()),
        J::Object(o) => {
            if o.len() == 2 && o.get("kind").and_then(J::as_str) == Some("bigint") {
                if let Some(i) = o
                    .get("value")
                    .and_then(J::as_str)
                    .and_then(|s| s.parse::<i64>().ok())
                {
                    return Ps::Int(i);
                }
            }
            Ps::Map(o.iter().map(|(k, v)| (k.clone(), json_to_ps(v))).collect())
        }
    }
}

pub fn params_to_ps(params: &serde_json::Map<String, serde_json::Value>) -> Ps {
    Ps::Map(
        params
            .iter()
            .map(|(k, v)| (k.clone(), json_to_ps(v)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(tag: u8, fields: Vec<Ps>) -> Ps {
        Ps::Struct { tag, fields }
    }

    fn node(id: i64, label: &str, name: &str, element: Option<&str>) -> Ps {
        let mut f = vec![
            Ps::Int(id),
            Ps::List(vec![Ps::str(label)]),
            Ps::map([("name", Ps::str(name))]),
        ];
        if let Some(e) = element {
            f.push(Ps::str(e));
        }
        s(0x4E, f)
    }

    fn json(v: &Value) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    /// (spec: driver-framework › Graph session contract › Records with graph values)
    #[test]
    fn nodes_carry_labels_and_properties_and_are_collected_once() {
        let mut el = Elements::default();
        let n = node(7, "User", "Ada", Some("4:abc:7"));
        let v = convert(&n, &mut el);
        convert(&n, &mut el);
        assert_eq!(
            json(&v),
            serde_json::json!({
                "kind": "node", "elementId": "4:abc:7", "labels": ["User"],
                "properties": {"name": {"kind": "text", "value": "Ada"}}
            })
        );
        assert_eq!(el.nodes.len(), 1);
    }

    #[test]
    fn bolt_4_nodes_use_the_numeric_id_as_element_id() {
        let mut el = Elements::default();
        let Value::Node { element_id, .. } = convert(&node(42, "User", "x", None), &mut el) else {
            panic!()
        };
        assert_eq!(element_id, "42");
    }

    #[test]
    fn relationships_name_their_ends() {
        let mut el = Elements::default();
        let r = s(
            0x52,
            vec![
                Ps::Int(9),
                Ps::Int(1),
                Ps::Int(2),
                Ps::str("BOUGHT"),
                Ps::map([("qty", Ps::Int(2))]),
                Ps::str("5:x:9"),
                Ps::str("4:x:1"),
                Ps::str("4:x:2"),
            ],
        );
        let v = convert(&r, &mut el);
        assert_eq!(
            json(&v),
            serde_json::json!({
                "kind": "relationship", "elementId": "5:x:9", "relType": "BOUGHT",
                "startId": "4:x:1", "endId": "4:x:2",
                "properties": {"qty": {"kind": "int", "value": 2}}
            })
        );
        assert_eq!(el.relationships.len(), 1);
    }

    #[test]
    fn a_path_alternates_relationships_and_nodes_and_honours_direction() {
        let rel = |id: i64| s(0x72, vec![Ps::Int(id), Ps::str("R"), Ps::Map(vec![])]);
        let path = s(
            0x50,
            vec![
                Ps::List(vec![
                    node(1, "A", "a", None),
                    node(2, "B", "b", None),
                    node(3, "C", "c", None),
                ]),
                Ps::List(vec![rel(10), rel(11)]),
                // a -[10]-> b, then c -[11]-> b walked backwards
                Ps::List(vec![Ps::Int(1), Ps::Int(1), Ps::Int(-2), Ps::Int(2)]),
            ],
        );
        let mut el = Elements::default();
        let Value::Path {
            nodes,
            relationships,
        } = convert(&path, &mut el)
        else {
            panic!()
        };
        assert_eq!(nodes.len(), 3);
        assert_eq!(
            (
                relationships[0].start_id.as_str(),
                relationships[0].end_id.as_str()
            ),
            ("1", "2")
        );
        assert_eq!(
            (
                relationships[1].start_id.as_str(),
                relationships[1].end_id.as_str()
            ),
            ("3", "2")
        );
        assert_eq!((el.nodes.len(), el.relationships.len()), (3, 2));
    }

    /// (spec: driver-framework › Neo4j driver › Large integers)
    #[test]
    fn integers_beyond_the_safe_range_are_exact_strings() {
        assert_eq!(
            json(&plain(&Ps::Int(9_007_199_254_740_993))),
            serde_json::json!({"kind": "bigint", "value": "9007199254740993"})
        );
        assert_eq!(
            json(&plain(&Ps::Int(5))),
            serde_json::json!({"kind": "int", "value": 5})
        );
        // inside a map too
        let mut el = Elements::default();
        let v = convert(&Ps::map([("n", Ps::Int(i64::MIN))]), &mut el);
        assert_eq!(json(&v)["value"]["n"], "-9223372036854775808");
    }

    #[test]
    fn scalars_lists_and_maps() {
        let mut el = Elements::default();
        assert_eq!(convert(&Ps::Null, &mut el), Value::Null);
        assert_eq!(
            convert(&Ps::Bool(true), &mut el),
            Value::Bool { value: true }
        );
        assert_eq!(
            convert(&Ps::Float(1.5), &mut el),
            Value::Float { value: 1.5 }
        );
        let list = convert(&Ps::List(vec![Ps::Int(1), Ps::str("a")]), &mut el);
        assert!(matches!(list, Value::Array { ref value } if value.len() == 2));
        let map = convert(
            &Ps::map([
                ("a", Ps::Int(1)),
                ("b", Ps::List(vec![Ps::Null, Ps::Bool(false)])),
            ]),
            &mut el,
        );
        assert_eq!(
            json(&map)["value"],
            serde_json::json!({"a": 1, "b": [null, false]})
        );
        assert_eq!(
            json(&plain(&Ps::Bytes(vec![0xDE, 0xAD]))),
            serde_json::json!({"kind": "bytes", "value": "dead", "len": 2})
        );
    }

    #[test]
    fn dates_and_times() {
        let text = |ps: Ps| match plain(&ps) {
            Value::Date { value }
            | Value::Time { value }
            | Value::Timestamp { value }
            | Value::Timestamptz { value }
            | Value::Interval { value }
            | Value::Other { value, .. } => value,
            other => panic!("{other:?}"),
        };
        assert_eq!(text(s(0x44, vec![Ps::Int(0)])), "1970-01-01");
        assert_eq!(text(s(0x44, vec![Ps::Int(20_149)])), "2025-03-02");
        assert_eq!(text(s(0x44, vec![Ps::Int(-1)])), "1969-12-31");
        // 12:30:15.5 +01:00
        assert_eq!(
            text(s(0x54, vec![Ps::Int(45_015_500_000_000), Ps::Int(3600)])),
            "12:30:15.5+01:00"
        );
        assert_eq!(text(s(0x74, vec![Ps::Int(3_600_000_000_000)])), "01:00:00");
        assert_eq!(
            text(s(0x74, vec![Ps::Int(1)])),
            "00:00:00.000000001",
            "nanoseconds survive"
        );
        assert_eq!(
            text(s(0x64, vec![Ps::Int(1_000_000_000), Ps::Int(123_000_000)])),
            "2001-09-09T01:46:40.123"
        );
        // Bolt 5: UTC seconds + offset
        assert_eq!(
            text(s(
                0x49,
                vec![Ps::Int(1_000_000_000), Ps::Int(0), Ps::Int(3600)]
            )),
            "2001-09-09T02:46:40+01:00"
        );
        // Bolt 4.4: wall-clock seconds + offset
        assert_eq!(
            text(s(
                0x46,
                vec![Ps::Int(1_000_000_000), Ps::Int(0), Ps::Int(3600)]
            )),
            "2001-09-09T01:46:40+01:00"
        );
        // zone ids resolve to the zone's offset at that instant (CEST in September)
        assert_eq!(
            text(s(
                0x69,
                vec![Ps::Int(1_000_000_000), Ps::Int(0), Ps::str("Europe/Paris")]
            )),
            "2001-09-09T03:46:40+02:00"
        );
        assert_eq!(
            text(s(0x58, vec![Ps::Int(7203), Ps::Float(1.0), Ps::Float(2.5)])),
            "point({srid: 7203, x: 1, y: 2.5})"
        );
        // unknown zone ids and structs degrade to `other`
        assert!(matches!(
            plain(&s(
                0x69,
                vec![Ps::Int(0), Ps::Int(0), Ps::str("Nowhere/Land")]
            )),
            Value::Other { .. }
        ));
        assert!(matches!(plain(&s(0x01, vec![])), Value::Other { .. }));
    }

    #[test]
    fn durations_use_neo4js_text_form() {
        assert_eq!(duration_text(0, 0, 0, 0), "PT0S");
        assert_eq!(duration_text(14, 3, 0, 0), "P1Y2M3D");
        assert_eq!(duration_text(0, 0, 3661, 500_000_000), "PT1H1M1.5S");
        assert_eq!(duration_text(1, 2, 3, 4), "P1M2DT3.000000004S");
        assert_eq!(duration_text(0, 0, -90, 0), "PT-1M-30S");
    }

    #[test]
    fn parameters_become_bolt_values() {
        let params = serde_json::json!({
            "name": "Ada", "n": 5, "f": 1.5, "ok": true, "none": null,
            "list": [1, 2], "map": {"a": 1},
            "big": {"kind": "bigint", "value": "9007199254740993"},
            "lookalike": {"kind": "bigint", "value": "nope"}
        });
        let ps = params_to_ps(params.as_object().unwrap());
        assert_eq!(ps.get("name"), Some(&Ps::str("Ada")));
        assert_eq!(ps.get("n"), Some(&Ps::Int(5)));
        assert_eq!(ps.get("f"), Some(&Ps::Float(1.5)));
        assert_eq!(ps.get("none"), Some(&Ps::Null));
        assert_eq!(ps.get("big"), Some(&Ps::Int(9_007_199_254_740_993)));
        assert!(matches!(ps.get("lookalike"), Some(Ps::Map(_))));
        assert_eq!(
            ps.get("list"),
            Some(&Ps::List(vec![Ps::Int(1), Ps::Int(2)]))
        );
    }
}
