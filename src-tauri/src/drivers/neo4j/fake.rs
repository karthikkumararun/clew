//! A pretend Neo4j for unit tests: just enough Bolt 5.4 to drive the client and the session without
//! Docker. The queries it understands are fixed words:
//!
//! - `ROWS <n>`      streams the integers 1..=n in the column `n`, honouring PULL sizes
//! - `NODE`          one node record with a Bolt 5 element id
//! - `SLEEP`         never answers until RESET arrives (then FAILURE, IGNORED…, SUCCESS)
//! - `BAD`           a syntax error with an offset
//! - `WRITE`         fails with the AccessMode error when the transaction is READ
//! - anything else   an empty result
//!
//! Users `neo4j` with password `pw` log in; databases other than `neo4j` and `system` do not exist.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::bolt::Ps;

pub struct FakeNeo4j {
    pub port: u16,
    /// Requests seen, by name (`RUN ROWS 5`, `BEGIN r neo4j`, `RESET`…).
    pub log: Arc<std::sync::Mutex<Vec<String>>>,
    pub connections: Arc<AtomicUsize>,
}

fn frame(msg: &Ps) -> Vec<u8> {
    let mut body = Vec::new();
    msg.encode(&mut body);
    let mut out = Vec::new();
    for chunk in body.chunks(0xFFFF) {
        out.extend_from_slice(&(chunk.len() as u16).to_be_bytes());
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&[0, 0]);
    out
}

fn success(meta: Ps) -> Vec<u8> {
    frame(&Ps::Struct {
        tag: 0x70,
        fields: vec![meta],
    })
}

fn record(values: Vec<Ps>) -> Vec<u8> {
    frame(&Ps::Struct {
        tag: 0x71,
        fields: vec![Ps::List(values)],
    })
}

fn ignored() -> Vec<u8> {
    frame(&Ps::Struct {
        tag: 0x7E,
        fields: vec![],
    })
}

/// Bolt 5.7+ servers send the real code as `neo4j_code` and a generic one as `code`.
fn failure(code: &str, message: &str) -> Vec<u8> {
    frame(&Ps::Struct {
        tag: 0x7F,
        fields: vec![Ps::map([
            ("neo4j_code", Ps::str(code)),
            ("code", Ps::str("Neo.DatabaseError.General.UnknownError")),
            ("message", Ps::str(message)),
        ])],
    })
}

async fn read_message(stream: &mut TcpStream) -> Option<Ps> {
    let mut body = Vec::new();
    loop {
        let mut len = [0u8; 2];
        stream.read_exact(&mut len).await.ok()?;
        let len = u16::from_be_bytes(len) as usize;
        if len == 0 {
            if body.is_empty() {
                continue;
            }
            break;
        }
        let mut chunk = vec![0u8; len];
        stream.read_exact(&mut chunk).await.ok()?;
        body.extend_from_slice(&chunk);
    }
    Ps::decode(&mut &body[..]).ok()
}

impl FakeNeo4j {
    pub async fn start() -> FakeNeo4j {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let (l, c) = (log.clone(), connections.clone());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                c.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(serve(stream, port, l.clone()));
            }
        });
        FakeNeo4j {
            port,
            log,
            connections,
        }
    }

    pub fn seen(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

async fn serve(mut stream: TcpStream, port: u16, log: Arc<std::sync::Mutex<Vec<String>>>) {
    let mut handshake = [0u8; 20];
    if stream.read_exact(&mut handshake).await.is_err() {
        return;
    }
    // the client's first proposal is a range containing 5.4
    if stream.write_all(&[0, 0, 4, 5]).await.is_err() {
        return;
    }
    let note = |s: String| log.lock().unwrap().push(s);

    let mut mode_read = false;
    // rows still to send for the open result, and the PULL/RUN responses held back by SLEEP
    let mut remaining: i64 = 0;
    let mut sleeping = false;
    let mut deferred = 0usize;
    let mut query = String::new();
    let mut next_value: i64 = 1;
    // after a FAILURE everything is IGNORED until RESET
    let mut failed = false;

    while let Some(msg) = read_message(&mut stream).await {
        let Ps::Struct { tag, fields } = msg else {
            return;
        };
        let mut out: Vec<u8> = Vec::new();
        if failed && tag != 0x0F && tag != 0x02 {
            if stream.write_all(&ignored()).await.is_err() {
                return;
            }
            continue;
        }
        match tag {
            0x01 => {
                note("HELLO".into());
                out = success(Ps::map([
                    ("server", Ps::str("Neo4j/5.26.0")),
                    ("connection_id", Ps::str("bolt-1")),
                ]));
            }
            0x6A => {
                let auth = fields.first().cloned().unwrap_or(Ps::Null);
                let ok = auth.get("principal").and_then(Ps::as_str) == Some("neo4j")
                    && auth.get("credentials").and_then(Ps::as_str) == Some("pw");
                note(format!("LOGON {ok}"));
                if ok {
                    out = success(Ps::Map(vec![]));
                } else {
                    let _ = stream
                        .write_all(&failure(
                            "Neo.ClientError.Security.Unauthorized",
                            "The client is unauthorized due to authentication failure.",
                        ))
                        .await;
                    return;
                }
            }
            0x11 => {
                let extra = fields.first().cloned().unwrap_or(Ps::Null);
                let db = extra.get("db").and_then(Ps::as_str).unwrap_or("neo4j");
                mode_read = extra.get("mode").and_then(Ps::as_str) == Some("r");
                note(format!("BEGIN {} {db}", if mode_read { "r" } else { "w" }));
                out = if db == "neo4j" || db == "system" {
                    success(Ps::Map(vec![]))
                } else {
                    failure(
                        "Neo.ClientError.Database.DatabaseNotFound",
                        &format!("Database does not exist. Database name: '{db}'."),
                    )
                };
            }
            0x10 => {
                query = fields
                    .first()
                    .and_then(Ps::as_str)
                    .unwrap_or_default()
                    .to_string();
                note(format!("RUN {query}"));
                if query == "SLEEP" {
                    sleeping = true;
                    deferred += 1;
                } else if query == "BAD" {
                    out = failure(
                        "Neo.ClientError.Statement.SyntaxError",
                        "Invalid input 'BAD' (line 1, column 1 (offset: 0))",
                    );
                } else if query == "WRITE" && mode_read {
                    out = failure(
                        "Neo.ClientError.Statement.AccessMode",
                        "Writing in read access mode not allowed.",
                    );
                } else {
                    next_value = 1;
                    remaining = query
                        .strip_prefix("ROWS ")
                        .and_then(|n| n.parse().ok())
                        .unwrap_or(if query == "NODE" { 1 } else { 0 });
                    out = success(Ps::map([
                        ("fields", Ps::List(vec![Ps::str("n")])),
                        ("t_first", Ps::Int(1)),
                    ]));
                }
            }
            0x3F => {
                let n = fields
                    .first()
                    .and_then(|m| m.get("n"))
                    .and_then(Ps::as_i64)
                    .unwrap_or(-1);
                note(format!("PULL {n}"));
                if sleeping {
                    deferred += 1;
                } else if query == "BAD" || (query == "WRITE" && mode_read) {
                    out = ignored();
                } else {
                    let take = if n < 0 { remaining } else { n.min(remaining) };
                    for _ in 0..take {
                        if query == "NODE" {
                            out.extend(record(vec![Ps::Struct {
                                tag: 0x4E,
                                fields: vec![
                                    Ps::Int(7),
                                    Ps::List(vec![Ps::str("Product")]),
                                    Ps::map([("name", Ps::str("Brass Lamp"))]),
                                    Ps::str("4:fake:7"),
                                ],
                            }]));
                        } else {
                            out.extend(record(vec![Ps::Int(next_value)]));
                            next_value += 1;
                        }
                    }
                    remaining -= take;
                    let more = remaining > 0;
                    out.extend(success(Ps::map([
                        ("has_more", Ps::Bool(more)),
                        ("db", Ps::str("neo4j")),
                        ("t_last", Ps::Int(2)),
                    ])));
                }
            }
            0x12 | 0x13 => {
                note(if tag == 0x12 { "COMMIT" } else { "ROLLBACK" }.into());
                out = success(Ps::Map(vec![]));
            }
            0x0F => {
                note("RESET".into());
                // the interrupted request fails, what was queued behind it is ignored
                for i in 0..deferred {
                    out.extend(if i == 0 {
                        failure(
                            "Neo.TransientError.Transaction.Terminated",
                            "The transaction has been terminated.",
                        )
                    } else {
                        ignored()
                    });
                }
                deferred = 0;
                sleeping = false;
                failed = false;
                remaining = 0;
                out.extend(success(Ps::Map(vec![])));
            }
            0x66 => {
                note("ROUTE".into());
                let me = format!("127.0.0.1:{port}");
                let role = |r: &str| {
                    Ps::map([
                        ("role", Ps::str(r)),
                        ("addresses", Ps::List(vec![Ps::str(me.clone())])),
                    ])
                };
                out = success(Ps::map([(
                    "rt",
                    Ps::map([
                        ("ttl", Ps::Int(300)),
                        ("db", Ps::str("neo4j")),
                        (
                            "servers",
                            Ps::List(vec![role("WRITE"), role("READ"), role("ROUTE")]),
                        ),
                    ]),
                )]));
            }
            0x02 => return,
            _ => {
                out = failure("Neo.ClientError.Request.Invalid", "unknown message");
            }
        }
        // a failure message (struct signature 0x7F after the 2-byte chunk header and marker)
        if out.len() > 4 && out[3] == 0x7F && tag != 0x0F {
            failed = true;
        }
        if !out.is_empty() && stream.write_all(&out).await.is_err() {
            return;
        }
    }
}
