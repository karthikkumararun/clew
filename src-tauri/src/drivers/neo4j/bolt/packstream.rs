//! PackStream v1, the binary value format of Bolt: encode and decode.

use std::fmt;

/// A PackStream value. Maps keep their key order (a `Vec`), which is also what the server sees.
#[derive(Debug, Clone, PartialEq)]
pub enum Ps {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Bytes(Vec<u8>),
    Str(String),
    List(Vec<Ps>),
    Map(Vec<(String, Ps)>),
    Struct { tag: u8, fields: Vec<Ps> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackError(pub String);

impl fmt::Display for PackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PackStream: {}", self.0)
    }
}

impl std::error::Error for PackError {}

type Result<T> = std::result::Result<T, PackError>;

fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(PackError(msg.into()))
}

/// Bounds how deep a hostile server can nest values.
const MAX_DEPTH: usize = 64;

impl Ps {
    pub fn str(s: impl Into<String>) -> Ps {
        Ps::Str(s.into())
    }

    pub fn map<K: Into<String>>(entries: impl IntoIterator<Item = (K, Ps)>) -> Ps {
        Ps::Map(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    /// Value of `key` when `self` is a map.
    pub fn get(&self, key: &str) -> Option<&Ps> {
        match self {
            Ps::Map(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Ps::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Ps::Int(i) => Some(*i),
            Ps::Float(f) if f.fract() == 0.0 => Some(*f as i64),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Ps::Float(f) => Some(*f),
            Ps::Int(i) => Some(*i as f64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Ps::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Ps]> {
        match self {
            Ps::List(l) => Some(l),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&[(String, Ps)]> {
        match self {
            Ps::Map(m) => Some(m),
            _ => None,
        }
    }

    pub fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Ps::Null => out.push(0xC0),
            Ps::Bool(false) => out.push(0xC2),
            Ps::Bool(true) => out.push(0xC3),
            Ps::Int(i) => encode_int(*i, out),
            Ps::Float(f) => {
                out.push(0xC1);
                out.extend_from_slice(&f.to_be_bytes());
            }
            Ps::Bytes(b) => {
                encode_size(b.len(), BYTES, out);
                out.extend_from_slice(b);
            }
            Ps::Str(s) => {
                encode_size(s.len(), STRING, out);
                out.extend_from_slice(s.as_bytes());
            }
            Ps::List(l) => {
                encode_size(l.len(), LIST, out);
                for v in l {
                    v.encode(out);
                }
            }
            Ps::Map(m) => {
                encode_size(m.len(), MAP, out);
                for (k, v) in m {
                    Ps::Str(k.clone()).encode(out);
                    v.encode(out);
                }
            }
            Ps::Struct { tag, fields } => {
                // Bolt structures have at most 15 fields.
                out.push(0xB0 | (fields.len().min(15) as u8));
                out.push(*tag);
                for v in fields {
                    v.encode(out);
                }
            }
        }
    }

    /// Decode one value from the front of `buf`, advancing it.
    pub fn decode(buf: &mut &[u8]) -> Result<Ps> {
        decode_depth(buf, 0)
    }
}

fn encode_int(i: i64, out: &mut Vec<u8>) {
    if (-16..=127).contains(&i) {
        out.push(i as u8);
    } else if let Ok(v) = i8::try_from(i) {
        out.push(0xC8);
        out.push(v as u8);
    } else if let Ok(v) = i16::try_from(i) {
        out.push(0xC9);
        out.extend_from_slice(&v.to_be_bytes());
    } else if let Ok(v) = i32::try_from(i) {
        out.push(0xCA);
        out.extend_from_slice(&v.to_be_bytes());
    } else {
        out.push(0xCB);
        out.extend_from_slice(&i.to_be_bytes());
    }
}

/// Marker plus size: `tiny` (size in the low nibble, below 16), then 8, 16 and 32-bit forms.
fn encode_size(len: usize, sizes: Sizes, out: &mut Vec<u8>) {
    if let (Some(tiny), true) = (sizes.tiny, len < 16) {
        out.push(tiny | len as u8);
    } else if let (Some(m), true) = (sizes.m8, len <= 0xFF) {
        out.push(m);
        out.push(len as u8);
    } else if len <= 0xFFFF {
        out.push(sizes.m16);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(sizes.m32);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
}

struct Sizes {
    tiny: Option<u8>,
    m8: Option<u8>,
    m16: u8,
    m32: u8,
}

const BYTES: Sizes = Sizes {
    tiny: None,
    m8: Some(0xCC),
    m16: 0xCD,
    m32: 0xCE,
};
const STRING: Sizes = Sizes {
    tiny: Some(0x80),
    m8: Some(0xD0),
    m16: 0xD1,
    m32: 0xD2,
};
const LIST: Sizes = Sizes {
    tiny: Some(0x90),
    m8: Some(0xD4),
    m16: 0xD5,
    m32: 0xD6,
};
const MAP: Sizes = Sizes {
    tiny: Some(0xA0),
    m8: Some(0xD8),
    m16: 0xD9,
    m32: 0xDA,
};

fn take<'a>(buf: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if buf.len() < n {
        return err("unexpected end of data");
    }
    let (head, tail) = buf.split_at(n);
    *buf = tail;
    Ok(head)
}

fn take_u8(buf: &mut &[u8]) -> Result<u8> {
    Ok(take(buf, 1)?[0])
}

fn take_u16(buf: &mut &[u8]) -> Result<usize> {
    let b = take(buf, 2)?;
    Ok(u16::from_be_bytes([b[0], b[1]]) as usize)
}

fn take_u32(buf: &mut &[u8]) -> Result<usize> {
    let b = take(buf, 4)?;
    Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
}

fn utf8(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).or_else(|_| err("invalid UTF-8 in a string"))
}

fn decode_depth(buf: &mut &[u8], depth: usize) -> Result<Ps> {
    if depth > MAX_DEPTH {
        return err("value nested too deeply");
    }
    let marker = take_u8(buf)?;
    let (high, low) = (marker & 0xF0, (marker & 0x0F) as usize);
    Ok(match marker {
        0x00..=0x7F => Ps::Int(marker as i64),
        0xF0..=0xFF => Ps::Int(marker as i8 as i64),
        0xC0 => Ps::Null,
        0xC1 => {
            let b = take(buf, 8)?;
            Ps::Float(f64::from_be_bytes(b.try_into().unwrap()))
        }
        0xC2 => Ps::Bool(false),
        0xC3 => Ps::Bool(true),
        0xC8 => Ps::Int(take_u8(buf)? as i8 as i64),
        0xC9 => Ps::Int(take_u16(buf)? as u16 as i16 as i64),
        0xCA => Ps::Int(take_u32(buf)? as u32 as i32 as i64),
        0xCB => {
            let b = take(buf, 8)?;
            Ps::Int(i64::from_be_bytes(b.try_into().unwrap()))
        }
        0xCC => {
            let n = take_u8(buf)? as usize;
            Ps::Bytes(take(buf, n)?.to_vec())
        }
        0xCD => {
            let n = take_u16(buf)?;
            Ps::Bytes(take(buf, n)?.to_vec())
        }
        0xCE => {
            let n = take_u32(buf)?;
            Ps::Bytes(take(buf, n)?.to_vec())
        }
        _ if high == 0x80 => Ps::Str(utf8(take(buf, low)?)?),
        0xD0 => {
            let n = take_u8(buf)? as usize;
            Ps::Str(utf8(take(buf, n)?)?)
        }
        0xD1 => {
            let n = take_u16(buf)?;
            Ps::Str(utf8(take(buf, n)?)?)
        }
        0xD2 => {
            let n = take_u32(buf)?;
            Ps::Str(utf8(take(buf, n)?)?)
        }
        _ if high == 0x90 => list(buf, low, depth)?,
        0xD4 => {
            let n = take_u8(buf)? as usize;
            list(buf, n, depth)?
        }
        0xD5 => {
            let n = take_u16(buf)?;
            list(buf, n, depth)?
        }
        0xD6 => {
            let n = take_u32(buf)?;
            list(buf, n, depth)?
        }
        _ if high == 0xA0 => map(buf, low, depth)?,
        0xD8 => {
            let n = take_u8(buf)? as usize;
            map(buf, n, depth)?
        }
        0xD9 => {
            let n = take_u16(buf)?;
            map(buf, n, depth)?
        }
        0xDA => {
            let n = take_u32(buf)?;
            map(buf, n, depth)?
        }
        _ if high == 0xB0 => structure(buf, low, depth)?,
        0xDC => {
            let n = take_u8(buf)? as usize;
            structure(buf, n, depth)?
        }
        0xDD => {
            let n = take_u16(buf)?;
            structure(buf, n, depth)?
        }
        other => return err(format!("unknown marker 0x{other:02X}")),
    })
}

fn list(buf: &mut &[u8], n: usize, depth: usize) -> Result<Ps> {
    // each element takes at least one byte, so a lying size cannot allocate more than the input
    let mut items = Vec::with_capacity(n.min(buf.len()));
    for _ in 0..n {
        items.push(decode_depth(buf, depth + 1)?);
    }
    Ok(Ps::List(items))
}

fn map(buf: &mut &[u8], n: usize, depth: usize) -> Result<Ps> {
    let mut entries = Vec::with_capacity(n.min(buf.len()));
    for _ in 0..n {
        let Ps::Str(key) = decode_depth(buf, depth + 1)? else {
            return err("a map key is not a string");
        };
        entries.push((key, decode_depth(buf, depth + 1)?));
    }
    Ok(Ps::Map(entries))
}

fn structure(buf: &mut &[u8], n: usize, depth: usize) -> Result<Ps> {
    let tag = take_u8(buf)?;
    let mut fields = Vec::with_capacity(n.min(buf.len()));
    for _ in 0..n {
        fields.push(decode_depth(buf, depth + 1)?);
    }
    Ok(Ps::Struct { tag, fields })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(v: Ps) -> Vec<u8> {
        let mut out = Vec::new();
        v.encode(&mut out);
        let mut input = &out[..];
        assert_eq!(Ps::decode(&mut input).unwrap(), v);
        assert!(input.is_empty(), "all bytes consumed");
        out
    }

    #[test]
    fn integers_use_the_smallest_form() {
        assert_eq!(round(Ps::Int(0)), [0x00]);
        assert_eq!(round(Ps::Int(127)), [0x7F]);
        assert_eq!(round(Ps::Int(-16)), [0xF0]);
        assert_eq!(round(Ps::Int(-17)), [0xC8, 0xEF]);
        assert_eq!(round(Ps::Int(128)), [0xC9, 0x00, 0x80]);
        assert_eq!(round(Ps::Int(32768)), [0xCA, 0x00, 0x00, 0x80, 0x00]);
        assert_eq!(round(Ps::Int(1 << 40))[0], 0xCB);
        round(Ps::Int(i64::MIN));
        round(Ps::Int(i64::MAX));
        round(Ps::Int(9_007_199_254_740_993));
    }

    #[test]
    fn scalars_round_trip() {
        round(Ps::Null);
        round(Ps::Bool(true));
        round(Ps::Bool(false));
        round(Ps::Float(-1.5e300));
        round(Ps::str(""));
        round(Ps::str("héllo wörld ✓"));
        round(Ps::Bytes(vec![1, 2, 3]));
    }

    #[test]
    fn sizes_cross_every_boundary() {
        for n in [0, 15, 16, 255, 256, 65_535, 65_536] {
            round(Ps::Str("x".repeat(n)));
            round(Ps::Bytes(vec![7; n]));
        }
        for n in [0, 15, 16, 255, 256, 70_000] {
            round(Ps::List(vec![Ps::Int(1); n]));
        }
        for n in [0, 15, 16, 300] {
            round(Ps::Map(
                (0..n).map(|i| (format!("k{i}"), Ps::Int(i))).collect(),
            ));
        }
    }

    #[test]
    fn tiny_string_and_struct_markers() {
        assert_eq!(round(Ps::str("a")), [0x81, b'a']);
        assert_eq!(
            round(Ps::Struct {
                tag: 0x10,
                fields: vec![Ps::Int(1)]
            }),
            [0xB1, 0x10, 0x01]
        );
    }

    #[test]
    fn nested_values_round_trip_and_maps_keep_order() {
        let v = Ps::map([
            ("b", Ps::List(vec![Ps::Null, Ps::Int(2), Ps::str("x")])),
            ("a", Ps::map([("z", Ps::Float(1.0))])),
        ]);
        round(v.clone());
        assert_eq!(v.as_map().unwrap()[0].0, "b");
        assert_eq!(v.get("a").unwrap().get("z"), Some(&Ps::Float(1.0)));
    }

    #[test]
    fn truncated_and_malformed_input_is_an_error_not_a_panic() {
        for bytes in [
            &[0xD0][..],
            &[0x85, b'a'],
            &[0xC1, 0, 0],
            &[0xC7],
            &[0xA1, 0x01, 0x01],
            &[0x81, 0xFF],
        ] {
            let mut input = bytes;
            assert!(Ps::decode(&mut input).is_err(), "{bytes:?}");
        }
        // a list that claims 4 billion elements
        let mut input = &[0xD6, 0xFF, 0xFF, 0xFF, 0xFF][..];
        assert!(Ps::decode(&mut input).is_err());
        // nesting bomb
        let bomb = vec![0x91u8; 10_000];
        let mut input = &bomb[..];
        assert!(Ps::decode(&mut input).is_err());
    }
}
