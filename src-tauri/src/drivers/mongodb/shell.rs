//! The relaxed shell syntax of the query bar and the console: JSON with unquoted keys, single
//! quotes, trailing commas, comments, and the shell's constructors (`ObjectId("…")`,
//! `ISODate("…")`, `NumberLong(…)`, regex literals…). There is no JavaScript engine behind it:
//! only values and `db.<collection>.<method>(…)` calls are understood.

use mongodb::bson::{self, doc, oid::ObjectId, spec::BinarySubtype, Binary, Bson, Document};

/// A syntax error and where it is (1-based character offset into the parsed text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    pub position: usize,
}

type PResult<T> = Result<T, ParseError>;

struct Parser<'a> {
    chars: Vec<char>,
    at: usize,
    #[allow(dead_code)]
    src: &'a str,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            chars: src.chars().collect(),
            at: 0,
            src,
        }
    }

    fn err<T>(&self, message: impl Into<String>) -> PResult<T> {
        Err(ParseError {
            message: message.into(),
            position: self.at + 1,
        })
    }

    fn err_at<T>(&self, at: usize, message: impl Into<String>) -> PResult<T> {
        Err(ParseError {
            message: message.into(),
            position: at + 1,
        })
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn eof(&self) -> bool {
        self.at >= self.chars.len()
    }

    /// Skip whitespace and `//` / `/* */` comments.
    fn ws(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => self.at += 1,
                Some('/') if self.chars.get(self.at + 1) == Some(&'/') => {
                    while self.peek().is_some_and(|c| c != '\n') {
                        self.at += 1;
                    }
                }
                Some('/') if self.chars.get(self.at + 1) == Some(&'*') => {
                    self.at += 2;
                    while self.at < self.chars.len()
                        && !(self.chars[self.at] == '*'
                            && self.chars.get(self.at + 1) == Some(&'/'))
                    {
                        self.at += 1;
                    }
                    self.at = (self.at + 2).min(self.chars.len());
                }
                _ => return,
            }
        }
    }

    fn eat(&mut self, c: char) -> bool {
        self.ws();
        if self.peek() == Some(c) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, c: char, what: &str) -> PResult<()> {
        if self.eat(c) {
            Ok(())
        } else if self.eof() {
            self.err(format!("Expected {what} but the text ended"))
        } else {
            self.err(format!("Expected {what}"))
        }
    }

    fn ident(&mut self) -> Option<String> {
        let start = self.at;
        while self
            .peek()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
        {
            self.at += 1;
        }
        (self.at > start).then(|| self.chars[start..self.at].iter().collect())
    }

    fn string(&mut self) -> PResult<String> {
        let quote = self.peek().expect("a quote");
        let start = self.at;
        self.at += 1;
        let mut out = String::new();
        loop {
            let Some(c) = self.peek() else {
                return self.err_at(start, "This string is never closed");
            };
            self.at += 1;
            if c == quote {
                return Ok(out);
            }
            if c != '\\' {
                out.push(c);
                continue;
            }
            let Some(e) = self.peek() else {
                return self.err_at(start, "This string is never closed");
            };
            self.at += 1;
            match e {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                'b' => out.push('\u{8}'),
                'f' => out.push('\u{c}'),
                '0' => out.push('\0'),
                'u' => {
                    let hex: String = self.chars[self.at..(self.at + 4).min(self.chars.len())]
                        .iter()
                        .collect();
                    match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                        Some(ch) if hex.len() == 4 => {
                            out.push(ch);
                            self.at += 4;
                        }
                        _ => return self.err("Not a valid \\u escape"),
                    }
                }
                other => out.push(other),
            }
        }
    }

    fn regex(&mut self) -> PResult<Bson> {
        let start = self.at;
        self.at += 1; // the opening /
        let mut pattern = String::new();
        let mut in_class = false;
        loop {
            let Some(c) = self.peek() else {
                return self.err_at(start, "This regular expression is never closed");
            };
            self.at += 1;
            match c {
                '\\' => {
                    pattern.push(c);
                    if let Some(n) = self.peek() {
                        pattern.push(n);
                        self.at += 1;
                    }
                }
                '[' => {
                    in_class = true;
                    pattern.push(c);
                }
                ']' => {
                    in_class = false;
                    pattern.push(c);
                }
                '/' if !in_class => break,
                '\n' => return self.err_at(start, "A regular expression can't span lines"),
                _ => pattern.push(c),
            }
        }
        let mut options = String::new();
        while self
            .peek()
            .is_some_and(|c| matches!(c, 'i' | 'm' | 's' | 'x' | 'u' | 'g'))
        {
            let c = self.peek().unwrap();
            if c != 'g' && c != 'u' {
                options.push(c);
            }
            self.at += 1;
        }
        let mut sorted: Vec<char> = options.chars().collect();
        sorted.sort_unstable();
        Ok(Bson::RegularExpression(bson::Regex {
            pattern,
            options: sorted.into_iter().collect(),
        }))
    }

    fn number(&mut self) -> PResult<Bson> {
        let start = self.at;
        if self.peek() == Some('-') || self.peek() == Some('+') {
            self.at += 1;
        }
        if self.chars[self.at..].starts_with(&['I', 'n', 'f', 'i', 'n', 'i', 't', 'y']) {
            self.at += 8;
            let neg = self.chars[start] == '-';
            return Ok(Bson::Double(if neg {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }));
        }
        let mut float = false;
        while let Some(c) = self.peek() {
            match c {
                '0'..='9' => self.at += 1,
                '.' | 'e' | 'E' => {
                    float = true;
                    self.at += 1;
                    if matches!(c, 'e' | 'E') && matches!(self.peek(), Some('+' | '-')) {
                        self.at += 1;
                    }
                }
                _ => break,
            }
        }
        let text: String = self.chars[start..self.at].iter().collect();
        let text = text.trim_start_matches('+');
        if text.is_empty() || text == "-" {
            return self.err_at(start, "Expected a number");
        }
        if !float {
            if let Ok(n) = text.parse::<i32>() {
                return Ok(Bson::Int32(n));
            }
            if let Ok(n) = text.parse::<i64>() {
                return Ok(Bson::Int64(n));
            }
        }
        text.parse::<f64>()
            .map(Bson::Double)
            .or_else(|_| self.err_at(start, format!("{text} isn't a valid number")))
    }

    fn array(&mut self) -> PResult<Bson> {
        self.at += 1;
        let mut out = Vec::new();
        loop {
            self.ws();
            if self.eat(']') {
                return Ok(Bson::Array(out));
            }
            out.push(self.value()?);
            self.ws();
            if self.eat(',') {
                continue;
            }
            if self.eat(']') {
                return Ok(Bson::Array(out));
            }
            return self.err("Expected , or ] in this array");
        }
    }

    fn key(&mut self) -> PResult<String> {
        self.ws();
        match self.peek() {
            Some('"' | '\'') => self.string(),
            Some(c) if c.is_alphanumeric() || c == '_' || c == '$' => {
                let start = self.at;
                // dotted paths (`user.id`) are single keys
                while self
                    .peek()
                    .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '$' | '.'))
                {
                    self.at += 1;
                }
                Ok(self.chars[start..self.at].iter().collect())
            }
            Some(_) => self.err("Expected a field name"),
            None => self.err("Expected a field name but the text ended"),
        }
    }

    fn object(&mut self) -> PResult<Bson> {
        self.at += 1;
        let mut out = Document::new();
        loop {
            self.ws();
            if self.eat('}') {
                return Ok(Bson::Document(out));
            }
            let key = self.key()?;
            self.expect(':', "a : after the field name")?;
            let value = self.value()?;
            out.insert(key, value);
            self.ws();
            if self.eat(',') {
                continue;
            }
            if self.eat('}') {
                return Ok(Bson::Document(out));
            }
            return self.err("Expected , or } in this object");
        }
    }

    fn call_args(&mut self) -> PResult<Vec<Bson>> {
        self.expect('(', "(")?;
        let mut args = Vec::new();
        loop {
            self.ws();
            if self.eat(')') {
                return Ok(args);
            }
            args.push(self.value()?);
            self.ws();
            if self.eat(',') {
                continue;
            }
            if self.eat(')') {
                return Ok(args);
            }
            return self.err("Expected , or ) in this call");
        }
    }

    fn constructor(&mut self, name: &str, at: usize) -> PResult<Bson> {
        let args = self.call_args()?;
        let text = |i: usize| -> Option<String> {
            match args.get(i) {
                Some(Bson::String(s)) => Some(s.clone()),
                Some(Bson::Int32(n)) => Some(n.to_string()),
                Some(Bson::Int64(n)) => Some(n.to_string()),
                _ => None,
            }
        };
        let bad = |what: &str| -> PResult<Bson> { self.err_at(at, what.to_string()) };
        match name {
            "ObjectId" => match args.first() {
                None => Ok(Bson::ObjectId(ObjectId::new())),
                Some(Bson::String(s)) => ObjectId::parse_str(s)
                    .map(Bson::ObjectId)
                    .or_else(|_| bad("ObjectId needs 24 hexadecimal characters")),
                _ => bad("ObjectId takes a string of 24 hexadecimal characters"),
            },
            "ISODate" | "Date" => match args.first() {
                None => Ok(Bson::DateTime(bson::DateTime::now())),
                Some(Bson::String(s)) => bson::DateTime::parse_rfc3339_str(s)
                    .or_else(|_| bson::DateTime::parse_rfc3339_str(format!("{s}T00:00:00Z")))
                    .or_else(|_| bson::DateTime::parse_rfc3339_str(format!("{s}Z")))
                    .map(Bson::DateTime)
                    .or_else(|_| bad("Not a date: use ISO 8601, e.g. ISODate(\"2026-10-01\")")),
                Some(Bson::Int32(n)) => Ok(Bson::DateTime(bson::DateTime::from_millis(*n as i64))),
                Some(Bson::Int64(n)) => Ok(Bson::DateTime(bson::DateTime::from_millis(*n))),
                Some(Bson::Double(n)) => Ok(Bson::DateTime(bson::DateTime::from_millis(*n as i64))),
                _ => bad("Date takes an ISO 8601 string or milliseconds"),
            },
            "NumberLong" | "Long" => text(0)
                .and_then(|s| s.parse::<i64>().ok())
                .map(Bson::Int64)
                .map_or_else(|| bad("NumberLong takes an integer or a string of digits"), Ok),
            "NumberInt" | "Int32" => text(0)
                .and_then(|s| s.parse::<i32>().ok())
                .map(Bson::Int32)
                .map_or_else(|| bad("NumberInt takes a 32-bit integer"), Ok),
            "NumberDecimal" | "Decimal128" => text(0)
                .and_then(|s| s.parse::<bson::Decimal128>().ok())
                .map(Bson::Decimal128)
                .map_or_else(|| bad("NumberDecimal takes a decimal string, e.g. \"12.50\""), Ok),
            "Double" => match args.first() {
                Some(Bson::Int32(n)) => Ok(Bson::Double(*n as f64)),
                Some(Bson::Int64(n)) => Ok(Bson::Double(*n as f64)),
                Some(Bson::Double(n)) => Ok(Bson::Double(*n)),
                _ => bad("Double takes a number"),
            },
            "UUID" => match args.first() {
                Some(Bson::String(s)) => uuid::Uuid::parse_str(s)
                    .map(|u| {
                        Bson::Binary(Binary {
                            subtype: BinarySubtype::Uuid,
                            bytes: u.as_bytes().to_vec(),
                        })
                    })
                    .or_else(|_| bad("Not a UUID")),
                _ => bad("UUID takes a string"),
            },
            "Timestamp" => match (args.first(), args.get(1)) {
                (Some(t), Some(i)) => {
                    let n = |b: &Bson| match b {
                        Bson::Int32(n) => Some(*n as u32),
                        Bson::Int64(n) => Some(*n as u32),
                        _ => None,
                    };
                    match (n(t), n(i)) {
                        (Some(time), Some(increment)) => {
                            Ok(Bson::Timestamp(bson::Timestamp { time, increment }))
                        }
                        _ => bad("Timestamp takes two integers"),
                    }
                }
                _ => bad("Timestamp takes (seconds, increment)"),
            },
            "BinData" => match (args.first(), args.get(1)) {
                (Some(Bson::Int32(sub)), Some(Bson::String(b64))) => {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map(|bytes| {
                            Bson::Binary(Binary {
                                subtype: BinarySubtype::from(*sub as u8),
                                bytes,
                            })
                        })
                        .or_else(|_| bad("BinData needs base64 text"))
                }
                _ => bad("BinData takes (subtype, \"base64\")"),
            },
            "MinKey" => Ok(Bson::MinKey),
            "MaxKey" => Ok(Bson::MaxKey),
            other => self.err_at(
                at,
                format!("{other}(…) isn't supported; only values and constructors like ObjectId(…) and ISODate(…) are"),
            ),
        }
    }

    fn value(&mut self) -> PResult<Bson> {
        self.ws();
        let at = self.at;
        match self.peek() {
            None => self.err("Expected a value but the text ended"),
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"' | '\'') => self.string().map(Bson::String),
            Some('/') => self.regex(),
            Some(c) if c.is_ascii_digit() || c == '-' || c == '+' || c == '.' => self.number(),
            Some(c) if c.is_alphabetic() || c == '_' || c == '$' => {
                let name = self.ident().unwrap_or_default();
                match name.as_str() {
                    "true" => Ok(Bson::Boolean(true)),
                    "false" => Ok(Bson::Boolean(false)),
                    "null" | "undefined" => Ok(Bson::Null),
                    "NaN" => Ok(Bson::Double(f64::NAN)),
                    "Infinity" => Ok(Bson::Double(f64::INFINITY)),
                    "new" => {
                        self.ws();
                        let at = self.at;
                        let ctor = self.ident().unwrap_or_default();
                        self.constructor(&ctor, at)
                    }
                    _ => {
                        self.ws();
                        if self.peek() == Some('(') {
                            self.constructor(&name, at)
                        } else {
                            self.err_at(
                                at,
                                format!("Unexpected {name}: quote text values, e.g. \"{name}\""),
                            )
                        }
                    }
                }
            }
            Some(c) => self.err(format!("Unexpected {c}")),
        }
    }
}

/// Parse one value; the whole text must be consumed. Empty text is `None`.
pub fn parse_value(src: &str) -> Result<Option<Bson>, ParseError> {
    let mut p = Parser::new(src);
    p.ws();
    if p.eof() {
        return Ok(None);
    }
    let v = p.value()?;
    p.ws();
    p.eat(';');
    p.ws();
    if !p.eof() {
        return p.err("Unexpected text after the value");
    }
    Ok(Some(v))
}

/// A field that must be a document (filter, projection, sort). Empty means `{}`.
pub fn parse_document(src: &str) -> Result<Document, ParseError> {
    match parse_value(src)? {
        None => Ok(doc! {}),
        Some(Bson::Document(d)) => Ok(d),
        Some(_) => Err(ParseError {
            message: "Expected an object like { field: value }".into(),
            position: 1,
        }),
    }
}

/// An aggregation pipeline: an array of stages.
pub fn parse_pipeline(src: &str) -> Result<Vec<Document>, ParseError> {
    match parse_value(src)? {
        None => Ok(vec![]),
        Some(Bson::Array(stages)) => stages
            .into_iter()
            .map(|s| match s {
                Bson::Document(d) => Ok(d),
                _ => Err(ParseError {
                    message: "Each pipeline stage must be an object".into(),
                    position: 1,
                }),
            })
            .collect(),
        Some(_) => Err(ParseError {
            message: "A pipeline is an array of stages: [ { $match: … }, … ]".into(),
            position: 1,
        }),
    }
}

/// A call in a shell command: `name(args…)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub name: String,
    pub args: Vec<Bson>,
}

/// A parsed console command.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    ShowCollections,
    ShowDatabases,
    Use(String),
    /// `db.<collection>.<method>(…)` with cursor modifiers chained after it.
    Collection {
        collection: String,
        call: Call,
        chain: Vec<Call>,
    },
    /// `db.getName()`, `db.stats()`… on the database itself.
    Database {
        call: Call,
    },
}

const UNSUPPORTED: &str = "Only db.<collection>.<method>(…) commands are supported";

/// Cursor modifiers that may follow a `find` / `aggregate`.
pub const CHAIN: &[&str] = &[
    "sort",
    "limit",
    "skip",
    "project",
    "hint",
    "count",
    "toArray",
    "pretty",
    "maxTimeMS",
    "batchSize",
];

/// Parse one console command. Anything else — loops, variables, functions — is refused.
pub fn parse_command(src: &str) -> Result<Command, ParseError> {
    let trimmed = src.trim().trim_end_matches(';').trim();
    let lower = trimmed.to_ascii_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    match words.as_slice() {
        ["show", "collections" | "tables"] => return Ok(Command::ShowCollections),
        ["show", "dbs" | "databases"] => return Ok(Command::ShowDatabases),
        _ => {}
    }
    if words.first() == Some(&"use") && words.len() == 2 {
        let name = trimmed.split_whitespace().nth(1).unwrap_or_default();
        return Ok(Command::Use(
            name.trim_matches(|c| c == '"' || c == '\'').to_string(),
        ));
    }
    let mut p = Parser::new(src);
    p.ws();
    let refuse = |p: &Parser| -> ParseError {
        ParseError {
            message: UNSUPPORTED.into(),
            position: p.at + 1,
        }
    };
    if p.ident().as_deref() != Some("db") {
        return Err(refuse(&p));
    }
    if !p.eat('.') {
        return Err(refuse(&p));
    }
    p.ws();
    let first = match p.peek() {
        Some(c) if c.is_alphabetic() || c == '_' || c == '$' => p.ident().unwrap_or_default(),
        _ => return Err(refuse(&p)),
    };
    let parse_call = |p: &mut Parser, name: String| -> PResult<Call> {
        p.ws();
        if p.peek() != Some('(') {
            return Err(refuse(p));
        }
        Ok(Call {
            name,
            args: p.call_args()?,
        })
    };
    p.ws();
    // db.getCollection("name").method(…)
    let (collection, call) = if first == "getCollection" && p.peek() == Some('(') {
        let args = p.call_args()?;
        let Some(Bson::String(name)) = args.first().cloned() else {
            return p.err("getCollection takes the collection name as a string");
        };
        if !p.eat('.') {
            return Err(refuse(&p));
        }
        p.ws();
        let method = p.ident().ok_or_else(|| refuse(&p))?;
        (Some(name), parse_call(&mut p, method)?)
    } else if p.peek() == Some('(') {
        // db.stats(), db.getName()…
        let call = parse_call(&mut p, first)?;
        (None, call)
    } else if p.eat('.') {
        p.ws();
        let method = p.ident().ok_or_else(|| refuse(&p))?;
        (Some(first), parse_call(&mut p, method)?)
    } else {
        return Err(refuse(&p));
    };
    let mut chain = Vec::new();
    loop {
        p.ws();
        if p.eat(';') {
            p.ws();
        }
        if p.eof() {
            break;
        }
        if !p.eat('.') {
            return Err(refuse(&p));
        }
        p.ws();
        let name_at = p.at;
        let name = p.ident().ok_or_else(|| refuse(&p))?;
        if !CHAIN.contains(&name.as_str()) {
            return Err(ParseError {
                message: UNSUPPORTED.into(),
                position: name_at + 1,
            });
        }
        chain.push(parse_call(&mut p, name)?);
    }
    Ok(match collection {
        Some(collection) => Command::Collection {
            collection,
            call,
            chain,
        },
        None => Command::Database { call },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, Bson};

    fn v(src: &str) -> Bson {
        parse_value(src).unwrap().unwrap()
    }

    #[test]
    fn plain_json_and_relaxed_json_parse_alike() {
        assert_eq!(
            v(r#"{"a": 1, "b": [true, null]}"#),
            v("{ a: 1, b: [true, null] }")
        );
        assert_eq!(
            v("{ a: 'x', \"b\": 'y' }"),
            Bson::Document(doc! {"a": "x", "b": "y"})
        );
        assert_eq!(v("{ a: 1, }"), Bson::Document(doc! {"a": 1}));
        assert_eq!(
            v("[1, 2, ]"),
            Bson::Array(vec![Bson::Int32(1), Bson::Int32(2)])
        );
    }

    #[test]
    fn dotted_and_operator_keys() {
        assert_eq!(
            v("{ user.id: 5, $or: [{ a: 1 }] }"),
            Bson::Document(doc! {"user.id": 5, "$or": [{"a": 1}]})
        );
    }

    #[test]
    fn numbers_keep_their_width() {
        assert_eq!(v("5"), Bson::Int32(5));
        assert_eq!(v("-5"), Bson::Int32(-5));
        assert_eq!(v("5000000000"), Bson::Int64(5_000_000_000));
        assert_eq!(v("1.5"), Bson::Double(1.5));
        assert_eq!(v("1e3"), Bson::Double(1000.0));
        assert_eq!(
            v("NumberLong(\"9007199254740993\")"),
            Bson::Int64(9_007_199_254_740_993)
        );
        assert_eq!(v("NumberInt(7)"), Bson::Int32(7));
        assert_eq!(v("Infinity"), Bson::Double(f64::INFINITY));
    }

    #[test]
    fn constructors() {
        assert_eq!(
            v(r#"ObjectId("6703f1c2a9e41d7c2e0fb812")"#),
            Bson::ObjectId(ObjectId::parse_str("6703f1c2a9e41d7c2e0fb812").unwrap())
        );
        let Bson::DateTime(d) = v(r#"ISODate("2026-10-01")"#) else {
            panic!()
        };
        assert_eq!(d.try_to_rfc3339_string().unwrap(), "2026-10-01T00:00:00Z");
        let Bson::DateTime(d) = v(r#"new Date("2026-10-01T12:30:00Z")"#) else {
            panic!()
        };
        assert_eq!(d.timestamp_millis(), 1_790_857_800_000);
        assert!(matches!(
            v(r#"NumberDecimal("12.50")"#),
            Bson::Decimal128(_)
        ));
        assert!(matches!(
            v(r#"UUID("123e4567-e89b-12d3-a456-426614174000")"#),
            Bson::Binary(Binary {
                subtype: BinarySubtype::Uuid,
                ..
            })
        ));
        assert_eq!(v("MinKey()"), Bson::MinKey);
        assert_eq!(
            v("Timestamp(5, 2)"),
            Bson::Timestamp(bson::Timestamp {
                time: 5,
                increment: 2
            })
        );
    }

    #[test]
    fn regex_literals() {
        assert_eq!(
            v("/^ab+c\\/d/i"),
            Bson::RegularExpression(bson::Regex {
                pattern: "^ab+c\\/d".into(),
                options: "i".into()
            })
        );
        assert_eq!(
            v("{ name: /smith[/]x/im }"),
            Bson::Document(
                doc! {"name": Bson::RegularExpression(bson::Regex { pattern: "smith[/]x".into(), options: "im".into() })}
            )
        );
    }

    #[test]
    fn comments_and_escapes() {
        assert_eq!(
            v("{ a: 1 /* one */, // two\n b: 2 }"),
            Bson::Document(doc! {"a": 1, "b": 2})
        );
        assert_eq!(v(r#""a\né\"""#), Bson::String("a\né\"".into()));
    }

    #[test]
    fn errors_carry_a_position() {
        let e = parse_value("{ a: }").unwrap_err();
        assert_eq!(e.position, 6);
        let e = parse_value("{ a: 1").unwrap_err();
        assert!(
            e.message.contains("text ended") || e.message.contains("Expected"),
            "{e:?}"
        );
        let e = parse_value("{ a: foo }").unwrap_err();
        assert!(e.message.contains("quote text"), "{e:?}");
        assert_eq!(e.position, 6);
        let e = parse_value("{ a: ObjectId(\"zz\") }").unwrap_err();
        assert!(e.message.contains("24 hexadecimal"), "{e:?}");
        let e = parse_value("{ a: 1 } x").unwrap_err();
        assert_eq!(e.position, 10);
        let e = parse_value("'abc").unwrap_err();
        assert!(e.message.contains("never closed"));
        let e = parse_value("{ a: Foo(1) }").unwrap_err();
        assert!(e.message.contains("isn't supported"));
    }

    #[test]
    fn empty_means_nothing() {
        assert_eq!(parse_value("  ").unwrap(), None);
        assert_eq!(parse_document("").unwrap(), doc! {});
        assert_eq!(parse_pipeline("").unwrap(), Vec::<Document>::new());
        assert!(parse_document("[1]").is_err());
        assert!(parse_pipeline("{ a: 1 }").is_err());
        assert_eq!(
            parse_pipeline("[{ $match: { a: 1 } }, { $limit: 5 }]").unwrap(),
            vec![doc! {"$match": {"a": 1}}, doc! {"$limit": 5}]
        );
    }

    #[test]
    fn shell_commands() {
        assert_eq!(
            parse_command("show collections").unwrap(),
            Command::ShowCollections
        );
        assert_eq!(parse_command("show dbs;").unwrap(), Command::ShowDatabases);
        assert_eq!(
            parse_command("use shop").unwrap(),
            Command::Use("shop".into())
        );
        let Command::Collection {
            collection,
            call,
            chain,
        } = parse_command("db.events.find({ type: 'x' }, { _id: 0 }).sort({ ts: -1 }).limit(5);")
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(collection, "events");
        assert_eq!(call.name, "find");
        assert_eq!(
            call.args,
            vec![
                Bson::Document(doc! {"type": "x"}),
                Bson::Document(doc! {"_id": 0})
            ]
        );
        assert_eq!(
            chain.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["sort", "limit"]
        );
        let Command::Collection {
            collection, call, ..
        } = parse_command("db.getCollection(\"my-events\").countDocuments({})").unwrap()
        else {
            panic!()
        };
        assert_eq!(
            (collection.as_str(), call.name.as_str()),
            ("my-events", "countDocuments")
        );
        assert!(matches!(
            parse_command("db.stats()").unwrap(),
            Command::Database { .. }
        ));
    }

    #[test]
    fn javascript_is_refused() {
        for src in [
            "for (var i = 0; i < 3; i++) { print(i) }",
            "var x = 1",
            "print('hi')",
            "db",
            "db.events",
            "db.events.find({}).forEach(printjson)",
            "function f() {}",
        ] {
            let e = parse_command(src).unwrap_err();
            assert!(
                e.message
                    .contains("Only db.<collection>.<method>(…) commands are supported")
                    || e.message.contains("Expected"),
                "{src}: {e:?}"
            );
        }
    }
}
