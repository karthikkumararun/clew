//! A Redis session: one multiplexed connection per logical database in use.

use std::collections::HashMap;

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use redis::Value;

use super::commands::{
    convert, invalid, keyspaces, refuse_blocking, reply_table, text_of, tokenize, tokenize_bytes,
};
use super::{map_err, Endpoint};
use crate::drivers::nosql::{KeyDetail, KeyInfo, KvReply, KvRequest, RedisValue};
use crate::drivers::{
    CancelFn, CancelHandle, DriverError, DriverResult, ErrorCode, ExecRequest, ExecSummary,
    KeyValueSession, ResultEvent, ResultId, ResultSink, ServerInfo, Session,
};

pub struct RedisSession {
    endpoint: Endpoint,
    conns: HashMap<u32, MultiplexedConnection>,
    info: ServerInfo,
    read_only: bool,
    /// Command name → whether the server flags it `write`.
    write_flags: HashMap<String, bool>,
    /// The logical database console lines run on (`SELECT n` changes it).
    current_db: u32,
    next_result: ResultId,
}

struct NoCancel;

#[async_trait]
impl CancelFn for NoCancel {
    async fn cancel(&self) -> DriverResult<()> {
        // Redis commands are short and non-blocking in the console; there is nothing to interrupt.
        Ok(())
    }
}

impl RedisSession {
    pub(crate) fn new(
        endpoint: Endpoint,
        db: u32,
        conn: MultiplexedConnection,
        info: ServerInfo,
        read_only: bool,
    ) -> Self {
        Self {
            endpoint,
            current_db: db,
            next_result: 1,
            conns: HashMap::from([(db, conn)]),
            info,
            read_only,
            write_flags: HashMap::new(),
        }
    }

    async fn conn(&mut self, db: u32) -> DriverResult<MultiplexedConnection> {
        if let Some(c) = self.conns.get(&db) {
            return Ok(c.clone());
        }
        let c = self.endpoint.connect(db).await?;
        self.conns.insert(db, c.clone());
        Ok(c)
    }

    async fn run(conn: &mut MultiplexedConnection, args: &[&str]) -> DriverResult<Value> {
        let mut cmd = redis::cmd(args[0]);
        for a in &args[1..] {
            cmd.arg(*a);
        }
        cmd.query_async::<Value>(conn).await.map_err(map_err)
    }

    async fn is_write(&mut self, conn: &mut MultiplexedConnection, name: &str) -> bool {
        let key = name.to_ascii_uppercase();
        if let Some(w) = self.write_flags.get(&key) {
            return *w;
        }
        let write = match Self::run(conn, &["COMMAND", "INFO", &key]).await {
            Ok(Value::Array(entries)) => match entries.first() {
                Some(Value::Array(info)) => match info.get(2) {
                    Some(Value::Array(flags) | Value::Set(flags)) => flags
                        .iter()
                        .any(|f| text_of(f).is_some_and(|f| f.eq_ignore_ascii_case("write"))),
                    _ => true,
                },
                // unknown command: let the server say so
                _ => false,
            },
            // can't tell: assume it writes
            _ => true,
        };
        self.write_flags.insert(key, write);
        write
    }

    async fn scan(
        &mut self,
        db: u32,
        pattern: &str,
        cursor: &str,
        count: u32,
        type_filter: Option<String>,
    ) -> DriverResult<KvReply> {
        let mut conn = self.conn(db).await?;
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(if cursor.is_empty() { "0" } else { cursor })
            .arg("MATCH")
            .arg(if pattern.is_empty() { "*" } else { pattern })
            .arg("COUNT")
            .arg(count.max(1));
        if let Some(t) = type_filter.filter(|t| !t.is_empty()) {
            cmd.arg("TYPE").arg(t);
        }
        let (next, names): (String, Vec<String>) =
            cmd.query_async(&mut conn).await.map_err(map_err)?;
        let mut keys = Vec::with_capacity(names.len());
        if !names.is_empty() {
            let mut pipe = redis::pipe();
            for n in &names {
                pipe.cmd("TYPE").arg(n).cmd("PTTL").arg(n);
            }
            let replies: Vec<Value> = pipe.query_async(&mut conn).await.map_err(map_err)?;
            for (i, name) in names.into_iter().enumerate() {
                let type_name = replies
                    .get(i * 2)
                    .and_then(text_of)
                    .unwrap_or_else(|| "none".into());
                let ttl = match replies.get(i * 2 + 1) {
                    Some(Value::Int(n)) if *n >= 0 => Some(*n),
                    _ => None,
                };
                keys.push(KeyInfo {
                    name,
                    type_name,
                    ttl_ms: ttl,
                });
            }
        }
        Ok(KvReply::Keys { cursor: next, keys })
    }

    async fn inspect(&mut self, db: u32, key: &str) -> DriverResult<KvReply> {
        let mut conn = self.conn(db).await?;
        let type_name = text_of(&Self::run(&mut conn, &["TYPE", key]).await?).unwrap_or_default();
        if type_name == "none" {
            return Ok(KvReply::Key { detail: None });
        }
        let ttl = match Self::run(&mut conn, &["PTTL", key]).await? {
            Value::Int(n) if n >= 0 => Some(n),
            _ => None,
        };
        let size_cmd = match type_name.as_str() {
            "string" => "STRLEN",
            "hash" => "HLEN",
            "list" => "LLEN",
            "set" => "SCARD",
            "zset" => "ZCARD",
            "stream" => "XLEN",
            _ => "",
        };
        let size = if size_cmd.is_empty() {
            0
        } else {
            match Self::run(&mut conn, &[size_cmd, key]).await? {
                Value::Int(n) => n.max(0) as u64,
                _ => 0,
            }
        };
        let encoding = Self::run(&mut conn, &["OBJECT", "ENCODING", key])
            .await
            .ok()
            .and_then(|v| text_of(&v));
        let memory = match Self::run(&mut conn, &["MEMORY", "USAGE", key]).await {
            Ok(Value::Int(n)) => Some(n.max(0) as u64),
            _ => None,
        };
        Ok(KvReply::Key {
            detail: Some(KeyDetail {
                name: key.to_string(),
                type_name,
                ttl_ms: ttl,
                size,
                encoding,
                memory,
            }),
        })
    }

    async fn page(
        &mut self,
        db: u32,
        key: &str,
        type_name: &str,
        position: &str,
        count: u32,
    ) -> DriverResult<KvReply> {
        let mut conn = self.conn(db).await?;
        let n = count.max(1) as i64;
        let start: i64 = position.parse().unwrap_or(0);
        let len = |v: Value| match v {
            Value::Int(n) => Some(n.max(0) as u64),
            _ => None,
        };
        match type_name {
            "string" => {
                // up to 1 MB; the viewer says when it's cut
                let total = len(Self::run(&mut conn, &["STRLEN", key]).await?);
                let v = Self::run(&mut conn, &["GETRANGE", key, "0", "1048575"]).await?;
                Ok(KvReply::Page {
                    rows: vec![vec![convert(v)]],
                    next: None,
                    total,
                })
            }
            "list" => {
                let total = len(Self::run(&mut conn, &["LLEN", key]).await?);
                let stop = (start + n - 1).to_string();
                let v = Self::run(&mut conn, &["LRANGE", key, &start.to_string(), &stop]).await?;
                let items = match convert(v) {
                    RedisValue::Array { items } => items,
                    _ => vec![],
                };
                let next = (start + items.len() as i64)
                    .lt(&(total.unwrap_or(0) as i64))
                    .then(|| (start + items.len() as i64).to_string());
                Ok(KvReply::Page {
                    rows: items.into_iter().map(|i| vec![i]).collect(),
                    next,
                    total,
                })
            }
            "hash" | "set" => {
                let (scan, size) = if type_name == "hash" {
                    ("HSCAN", "HLEN")
                } else {
                    ("SSCAN", "SCARD")
                };
                let total = len(Self::run(&mut conn, &[size, key]).await?);
                let cursor = if position.is_empty() { "0" } else { position };
                let v = Self::run(&mut conn, &[scan, key, cursor, "COUNT", &n.to_string()]).await?;
                let Value::Array(parts) = v else {
                    return Err(invalid("Unexpected scan reply"));
                };
                let next = parts.first().and_then(text_of).filter(|c| c != "0");
                let flat = match parts.into_iter().nth(1).map(convert) {
                    Some(RedisValue::Array { items }) => items,
                    _ => vec![],
                };
                let rows = if type_name == "hash" {
                    flat.chunks(2).map(|c| c.to_vec()).collect()
                } else {
                    flat.into_iter().map(|m| vec![m]).collect()
                };
                Ok(KvReply::Page { rows, next, total })
            }
            "zset" => {
                let total = len(Self::run(&mut conn, &["ZCARD", key]).await?);
                let stop = (start + n - 1).to_string();
                let v = Self::run(
                    &mut conn,
                    &["ZRANGE", key, &start.to_string(), &stop, "WITHSCORES"],
                )
                .await?;
                let flat = match convert(v) {
                    RedisValue::Array { items } => items,
                    _ => vec![],
                };
                // RESP3 answers [[member, score], …]; RESP2 a flat list
                let rows: Vec<Vec<RedisValue>> =
                    if flat.iter().all(|i| matches!(i, RedisValue::Array { .. }))
                        && !flat.is_empty()
                    {
                        flat.into_iter()
                            .map(|p| match p {
                                RedisValue::Array { items } => items,
                                other => vec![other],
                            })
                            .collect()
                    } else {
                        flat.chunks(2).map(|c| c.to_vec()).collect()
                    };
                let next = ((start + rows.len() as i64) < total.unwrap_or(0) as i64)
                    .then(|| (start + rows.len() as i64).to_string());
                Ok(KvReply::Page { rows, next, total })
            }
            "stream" => {
                let total = len(Self::run(&mut conn, &["XLEN", key]).await?);
                let end = if position.is_empty() {
                    "+".to_string()
                } else {
                    format!("({position}")
                };
                let v = Self::run(
                    &mut conn,
                    &["XREVRANGE", key, &end, "-", "COUNT", &n.to_string()],
                )
                .await?;
                let entries = match convert(v) {
                    RedisValue::Array { items } => items,
                    _ => vec![],
                };
                let mut rows = Vec::new();
                let mut last = None;
                for e in entries {
                    if let RedisValue::Array { mut items } = e {
                        if items.len() == 2 {
                            let fields = items.pop().unwrap();
                            let id = items.pop().unwrap();
                            if let RedisValue::Text { value } = &id {
                                last = Some(value.clone());
                            }
                            rows.push(vec![id, fields]);
                        }
                    }
                }
                let next = if rows.len() as i64 == n { last } else { None };
                Ok(KvReply::Page { rows, next, total })
            }
            other => Err(invalid(format!("Can't show keys of type {other}"))),
        }
    }

    async fn command(&mut self, db: u32, line: &str) -> DriverResult<KvReply> {
        let args = tokenize(line).map_err(invalid)?;
        let Some(name) = args.first() else {
            return Err(invalid("Type a command"));
        };
        if let Some(reason) = refuse_blocking(&args) {
            return Err(DriverError::new(ErrorCode::Unsupported, reason));
        }
        let mut conn = self.conn(db).await?;
        if self.read_only && self.is_write(&mut conn, name).await {
            return Err(DriverError::new(
                ErrorCode::ReadOnly,
                "This session is read-only; writes are refused.",
            ));
        }
        let mut cmd = redis::cmd(name);
        for a in tokenize_bytes(line).map_err(invalid)?.iter().skip(1) {
            cmd.arg(a.as_slice());
        }
        match cmd.query_async::<Value>(&mut conn).await {
            Ok(v) => Ok(KvReply::Reply { value: convert(v) }),
            // a server error is a reply, shown in the console like redis-cli does
            Err(e) if e.kind() != redis::ErrorKind::Io => Ok(KvReply::Reply {
                value: RedisValue::Error {
                    message: map_err(e).message,
                },
            }),
            Err(e) => Err(map_err(e)),
        }
    }
}

#[async_trait]
impl KeyValueSession for RedisSession {
    async fn call(&mut self, request: KvRequest) -> DriverResult<KvReply> {
        match request {
            KvRequest::Databases => {
                let mut conn = self.conn(0).await?;
                let (items, databases) = keyspaces(&mut conn).await?;
                Ok(KvReply::Databases { items, databases })
            }
            KvRequest::Scan {
                db,
                pattern,
                cursor,
                count,
                type_filter,
            } => self.scan(db, &pattern, &cursor, count, type_filter).await,
            KvRequest::Inspect { db, key } => self.inspect(db, &key).await,
            KvRequest::Page {
                db,
                key,
                type_name,
                position,
                count,
            } => self.page(db, &key, &type_name, &position, count).await,
            KvRequest::Commands => {
                let mut conn = self.conn(0).await?;
                let v = match Self::run(&mut conn, &["COMMAND", "LIST"]).await {
                    Ok(v) => v,
                    Err(_) => Self::run(&mut conn, &["COMMAND"]).await?,
                };
                let mut names: Vec<String> = match v {
                    Value::Array(items) => items
                        .iter()
                        .filter_map(|i| match i {
                            Value::Array(info) => info.first().and_then(text_of),
                            other => text_of(other),
                        })
                        .collect(),
                    _ => vec![],
                };
                names.sort();
                names.dedup();
                Ok(KvReply::Commands { names })
            }
            KvRequest::Command { db, line } => self.command(db, &line).await,
        }
    }
}

#[async_trait]
impl Session for RedisSession {
    /// The console: one command line, its reply as a small table.
    async fn execute(&mut self, req: ExecRequest, sink: ResultSink) -> DriverResult<ExecSummary> {
        let started = std::time::Instant::now();
        let line = req.sql.trim();
        let args = tokenize(line).map_err(invalid)?;
        let reply = match args.as_slice() {
            [] => return Err(invalid("Type a command")),
            // SELECT moves the console to another logical database
            [cmd, n] if cmd.eq_ignore_ascii_case("SELECT") => {
                let db: u32 = n.parse().map_err(|_| invalid("ERR invalid DB index"))?;
                self.conn(db).await?;
                self.current_db = db;
                RedisValue::Status { value: "OK".into() }
            }
            _ => match self.command(self.current_db, line).await? {
                KvReply::Reply {
                    value: RedisValue::Error { message },
                } => return Err(DriverError::new(ErrorCode::QueryFailed, message)),
                KvReply::Reply { value } => value,
                _ => RedisValue::Nil,
            },
        };
        let (columns, rows) = reply_table(&args, &reply);
        let result_id = self.next_result;
        self.next_result += 1;
        sink.send(ResultEvent::Columns {
            result_id,
            statement: 0,
            columns,
        })
        .await;
        sink.send(ResultEvent::Rows { result_id, rows }).await;
        let summary = ExecSummary {
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            has_more: false,
        };
        sink.send(ResultEvent::Done {
            result_id,
            summary: summary.clone(),
        })
        .await;
        Ok(summary)
    }

    async fn set_read_only(&mut self, read_only: bool) -> DriverResult<()> {
        self.read_only = read_only;
        Ok(())
    }

    async fn fetch_more(
        &mut self,
        _id: ResultId,
        _n: usize,
        _sink: ResultSink,
    ) -> DriverResult<bool> {
        Ok(false)
    }

    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::new(NoCancel)
    }

    fn server_info(&self) -> ServerInfo {
        self.info.clone()
    }

    fn as_keyvalue(&mut self) -> Option<&mut dyn KeyValueSession> {
        Some(self)
    }

    async fn close(self: Box<Self>) -> DriverResult<()> {
        Ok(())
    }
}
