//! One Bolt connection: TCP (optionally TLS), version handshake, HELLO / LOGON, chunked
//! messages, and the request / response bookkeeping that keeps a pipelined connection sane.
//!
//! Reading is cancel-safe: bytes go into `rbuf` and messages are cut out of it, so a read that is
//! dropped by a `select!` (a cancelled query) loses nothing.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use super::packstream::Ps;
use crate::drivers::{DriverError, DriverResult, ErrorCode};

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync> Io for T {}

// Request signatures.
pub const HELLO: u8 = 0x01;
pub const GOODBYE: u8 = 0x02;
pub const RESET: u8 = 0x0F;
pub const RUN: u8 = 0x10;
pub const BEGIN: u8 = 0x11;
pub const COMMIT: u8 = 0x12;
pub const ROLLBACK: u8 = 0x13;
pub const DISCARD: u8 = 0x2F;
pub const PULL: u8 = 0x3F;
pub const ROUTE: u8 = 0x66;
pub const LOGON: u8 = 0x6A;

// Response signatures.
const SUCCESS: u8 = 0x70;
const RECORD: u8 = 0x71;
const IGNORED: u8 = 0x7E;
const FAILURE: u8 = 0x7F;

/// What the server answered to one request.
#[derive(Debug, Clone, PartialEq)]
pub enum Resp {
    Success(Ps),
    Record(Vec<Ps>),
    Ignored,
    Failure { code: String, message: String },
}

impl Resp {
    fn parse(ps: Ps) -> DriverResult<Resp> {
        let Ps::Struct { tag, mut fields } = ps else {
            return Err(protocol("the server sent something that is not a message"));
        };
        let first = if fields.is_empty() {
            Ps::Null
        } else {
            fields.swap_remove(0)
        };
        Ok(match tag {
            SUCCESS => Resp::Success(first),
            RECORD => match first {
                Ps::List(values) => Resp::Record(values),
                _ => return Err(protocol("a record is not a list")),
            },
            IGNORED => Resp::Ignored,
            FAILURE => Resp::Failure {
                // Bolt 5.7+ puts the code in `neo4j_code`; `code` then holds a generic stand-in
                code: first
                    .get("neo4j_code")
                    .or_else(|| first.get("code"))
                    .and_then(Ps::as_str)
                    .unwrap_or("Neo.DatabaseError.General.UnknownError")
                    .to_string(),
                message: first
                    .get("message")
                    .and_then(Ps::as_str)
                    .unwrap_or("")
                    .to_string(),
            },
            other => return Err(protocol(format!("unknown message 0x{other:02X}"))),
        })
    }
}

fn protocol(msg: impl Into<String>) -> DriverError {
    DriverError::new(
        ErrorCode::ConnectionLost,
        format!("Bolt protocol error: {}", msg.into()),
    )
}

/// A server failure as a driver error.
pub fn failure_error(code: &str, message: &str) -> DriverError {
    let kind = if code.contains("Security.Unauthorized") || code.contains("AuthenticationRateLimit")
    {
        ErrorCode::AuthFailed
    } else if code.contains("Security.Forbidden")
        || code.contains("Security.AuthorizationExpired")
        || code.contains("Security.CredentialsExpired")
    {
        ErrorCode::AccessDenied
    } else if code.ends_with("Statement.AccessMode") {
        ErrorCode::ReadOnly
    } else if code.ends_with("Transaction.TransactionTimedOut")
        || code.ends_with("Transaction.TransactionTimedOutClientConfiguration")
    {
        ErrorCode::Timeout
    } else if code.ends_with("Transaction.Terminated")
        || code.ends_with("Transaction.LockClientStopped")
    {
        ErrorCode::Cancelled
    } else {
        ErrorCode::QueryFailed
    };
    let mut e = DriverError::new(kind, message.to_string()).with_detail(code.to_string());
    if kind == ErrorCode::QueryFailed {
        if let Some(offset) = error_offset(message) {
            e = e.with_position(offset + 1);
        }
    }
    e
}

/// `(line 1, column 5 (offset: 4))` in a syntax error message: the 0-based offset.
fn error_offset(message: &str) -> Option<u32> {
    let rest = message.split("(offset: ").nth(1)?;
    rest.split(')').next()?.trim().parse().ok()
}

pub struct ConnectOpts {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub tls: Option<Arc<rustls::ClientConfig>>,
    /// `Some` for `neo4j://` schemes: the routing context sent in HELLO.
    pub routing: Option<Vec<(String, Ps)>>,
    pub timeout: Duration,
}

impl ConnectOpts {
    pub fn address(&self) -> String {
        address(&self.host, self.port)
    }
}

pub fn address(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

pub struct Conn {
    io: Box<dyn Io>,
    rbuf: Vec<u8>,
    rpos: usize,
    acc: Vec<u8>,
    wbuf: Vec<u8>,
    /// Negotiated Bolt version.
    pub version: (u8, u8),
    /// `Neo4j/5.26.0`
    pub server: String,
    pub address: String,
    /// Requests whose summary (SUCCESS / FAILURE / IGNORED) has not been read yet.
    pending: usize,
    broken: bool,
}

impl std::fmt::Debug for Conn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Conn")
            .field("address", &self.address)
            .field("version", &self.version)
            .field("pending", &self.pending)
            .finish()
    }
}

fn io_error(e: std::io::Error) -> DriverError {
    DriverError::new(
        ErrorCode::ConnectionLost,
        format!("The connection to the server was lost: {e}"),
    )
}

impl Conn {
    pub async fn open(opts: &ConnectOpts) -> DriverResult<Conn> {
        let address = opts.address();
        let tcp = match tokio::time::timeout(
            opts.timeout,
            TcpStream::connect((opts.host.as_str(), opts.port)),
        )
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                return Err(DriverError::new(
                    ErrorCode::ConnectionLost,
                    format!("Could not connect to {address}: {e}"),
                ))
            }
            Err(_) => {
                return Err(DriverError::new(
                    ErrorCode::Timeout,
                    format!("Timed out connecting to {address}"),
                ))
            }
        };
        let _ = tcp.set_nodelay(true);
        let io: Box<dyn Io> = match &opts.tls {
            None => Box::new(tcp),
            Some(config) => {
                let name =
                    rustls::pki_types::ServerName::try_from(opts.host.clone()).map_err(|_| {
                        DriverError::new(
                            ErrorCode::TlsFailed,
                            format!("\"{}\" is not a valid server name for TLS", opts.host),
                        )
                    })?;
                let connector = tokio_rustls::TlsConnector::from(config.clone());
                match tokio::time::timeout(opts.timeout, connector.connect(name, tcp)).await {
                    Ok(Ok(s)) => Box::new(s),
                    Ok(Err(e)) => {
                        return Err(crate::transport::tls::map_tls_error(
                            &e.to_string(),
                            &opts.host,
                        )
                        .unwrap_or_else(|| {
                            DriverError::new(
                                ErrorCode::TlsFailed,
                                "The TLS connection could not be established",
                            )
                            .with_detail(e.to_string())
                        }))
                    }
                    Err(_) => {
                        return Err(DriverError::new(
                            ErrorCode::Timeout,
                            format!("Timed out during the TLS handshake with {address}"),
                        ))
                    }
                }
            }
        };
        let mut conn = Conn {
            io,
            rbuf: Vec::new(),
            rpos: 0,
            acc: Vec::new(),
            wbuf: Vec::new(),
            version: (0, 0),
            server: String::new(),
            address,
            pending: 0,
            broken: false,
        };
        match tokio::time::timeout(opts.timeout, conn.start(opts)).await {
            Ok(r) => r?,
            Err(_) => {
                return Err(DriverError::new(
                    ErrorCode::Timeout,
                    format!("Timed out signing in to {}", conn.address),
                ))
            }
        }
        Ok(conn)
    }

    async fn start(&mut self, opts: &ConnectOpts) -> DriverResult<()> {
        // magic, then up to four proposals (range, minor, major): 5.8 down to 5.0, and 4.4
        let mut hello = vec![0x60, 0x60, 0xB0, 0x17];
        for proposal in [0x0008_0805u32, 0x0000_0404, 0, 0] {
            hello.extend_from_slice(&proposal.to_be_bytes());
        }
        self.io.write_all(&hello).await.map_err(io_error)?;
        self.io.flush().await.map_err(io_error)?;
        let mut answer = [0u8; 4];
        self.io.read_exact(&mut answer).await.map_err(|e| {
            DriverError::new(
                ErrorCode::ConnectionLost,
                format!(
                    "{} did not answer the Bolt handshake ({e}). Is this a Neo4j Bolt port?",
                    self.address
                ),
            )
        })?;
        self.version = (answer[3], answer[2]);
        if self.version == (0, 0) {
            return Err(DriverError::new(
                ErrorCode::Unsupported,
                "The server speaks none of the Bolt versions Clew supports (4.4 and 5.x)",
            ));
        }

        let mut extra = vec![(
            "user_agent".to_string(),
            Ps::str(format!("Clew/{}", env!("CARGO_PKG_VERSION"))),
        )];
        if self.version >= (5, 3) {
            extra.push((
                "bolt_agent".into(),
                Ps::map([
                    (
                        "product",
                        Ps::str(format!("Clew/{}", env!("CARGO_PKG_VERSION"))),
                    ),
                    ("language", Ps::str("Rust")),
                ]),
            ));
        }
        if let Some(ctx) = &opts.routing {
            extra.push(("routing".into(), Ps::Map(ctx.clone())));
        }
        let basic = [
            ("scheme".to_string(), Ps::str("basic")),
            ("principal".to_string(), Ps::str(&opts.user)),
            ("credentials".to_string(), Ps::str(&opts.password)),
        ];
        let separate_logon = self.version >= (5, 1);
        if !separate_logon {
            extra.extend(basic.clone());
        }
        self.send(HELLO, vec![Ps::Map(extra)]).await?;
        let success = self.expect_success().await?;
        self.server = success
            .get("server")
            .and_then(Ps::as_str)
            .unwrap_or("Neo4j")
            .to_string();
        if separate_logon {
            self.send(LOGON, vec![Ps::Map(basic.to_vec())]).await?;
            self.expect_success().await?;
        }
        Ok(())
    }

    /// `5.26.0` out of `Neo4j/5.26.0` (the whole text when it has another shape).
    pub fn server_version(&self) -> String {
        self.server
            .split_once('/')
            .map_or(self.server.clone(), |(_, v)| v.to_string())
    }

    pub fn is_broken(&self) -> bool {
        self.broken
    }

    /// No request is waiting for its summary.
    pub fn is_idle(&self) -> bool {
        !self.broken && self.pending == 0
    }

    /// Write one request. It owes a summary until [`Self::recv`] returns one.
    pub async fn send(&mut self, signature: u8, fields: Vec<Ps>) -> DriverResult<()> {
        self.queue(signature, fields);
        self.flush().await
    }

    /// Like [`Self::send`] without writing yet, to pipeline several requests in one write.
    pub fn queue(&mut self, signature: u8, fields: Vec<Ps>) {
        let mut body = Vec::new();
        Ps::Struct {
            tag: signature,
            fields,
        }
        .encode(&mut body);
        for chunk in body.chunks(0xFFFF) {
            self.wbuf
                .extend_from_slice(&(chunk.len() as u16).to_be_bytes());
            self.wbuf.extend_from_slice(chunk);
        }
        self.wbuf.extend_from_slice(&[0, 0]);
        if signature != GOODBYE {
            self.pending += 1;
        }
    }

    pub async fn flush(&mut self) -> DriverResult<()> {
        let data = std::mem::take(&mut self.wbuf);
        let r = async {
            self.io.write_all(&data).await?;
            self.io.flush().await
        }
        .await;
        r.map_err(|e| {
            self.broken = true;
            io_error(e)
        })
    }

    /// Cut the next complete message out of the receive buffer.
    fn next_message(&mut self) -> Option<Vec<u8>> {
        loop {
            let avail = &self.rbuf[self.rpos..];
            if avail.len() < 2 {
                break;
            }
            let len = u16::from_be_bytes([avail[0], avail[1]]) as usize;
            if avail.len() < 2 + len {
                break;
            }
            self.acc.extend_from_slice(&avail[2..2 + len]);
            self.rpos += 2 + len;
            if len == 0 && !self.acc.is_empty() {
                // an empty chunk ends a message (an empty message is a NOOP keep-alive)
                let msg = std::mem::take(&mut self.acc);
                self.compact();
                return Some(msg);
            }
        }
        self.compact();
        None
    }

    fn compact(&mut self) {
        if self.rpos == self.rbuf.len() {
            self.rbuf.clear();
            self.rpos = 0;
        } else if self.rpos > 64 * 1024 {
            self.rbuf.drain(..self.rpos);
            self.rpos = 0;
        }
    }

    /// The next response. Cancel-safe. Summaries settle the oldest request.
    pub async fn recv(&mut self) -> DriverResult<Resp> {
        loop {
            if let Some(bytes) = self.next_message() {
                let mut input = &bytes[..];
                let ps = Ps::decode(&mut input).map_err(|e| {
                    self.broken = true;
                    protocol(e.to_string())
                })?;
                let resp = Resp::parse(ps).inspect_err(|_| self.broken = true)?;
                if !matches!(resp, Resp::Record(_)) {
                    self.pending = self.pending.saturating_sub(1);
                }
                return Ok(resp);
            }
            match self.io.read_buf(&mut self.rbuf).await {
                Ok(0) => {
                    self.broken = true;
                    return Err(DriverError::new(
                        ErrorCode::ConnectionLost,
                        "The server closed the connection",
                    ));
                }
                Ok(_) => {}
                Err(e) => {
                    self.broken = true;
                    return Err(io_error(e));
                }
            }
        }
    }

    /// The next response, which must be a SUCCESS (its metadata). A FAILURE becomes an error and
    /// the connection is reset.
    pub async fn expect_success(&mut self) -> DriverResult<Ps> {
        match self.recv().await? {
            Resp::Success(meta) => Ok(meta),
            Resp::Failure { code, message } => {
                self.recover().await;
                Err(failure_error(&code, &message))
            }
            Resp::Ignored => {
                self.recover().await;
                Err(DriverError::new(
                    ErrorCode::QueryFailed,
                    "The server ignored the request",
                ))
            }
            Resp::Record(_) => Err(protocol("a record where a summary was expected")),
        }
    }

    /// Read and discard responses until every request has its summary.
    pub async fn drain(&mut self, limit: Duration) {
        let started = tokio::time::Instant::now();
        while self.pending > 0 && !self.broken {
            let left = limit.saturating_sub(started.elapsed());
            if left.is_zero() || tokio::time::timeout(left, self.recv()).await.is_err() {
                self.broken = true;
            }
        }
    }

    /// Bring a failed or interrupted connection back to READY: RESET, then discard everything
    /// up to its answer. A connection that cannot be recovered is marked broken.
    pub async fn recover(&mut self) {
        if self.broken {
            return;
        }
        // Responses to requests already on the wire still arrive; RESET's answer is the last one.
        if self.send(RESET, vec![]).await.is_err() {
            return;
        }
        self.drain(Duration::from_secs(10)).await;
    }

    /// Say goodbye and close. Errors are not interesting any more.
    pub async fn close(mut self) {
        if !self.broken {
            self.queue(GOODBYE, vec![]);
            let _ = tokio::time::timeout(Duration::from_secs(2), self.flush()).await;
        }
        let _ = self.io.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_map_to_the_error_codes_the_ui_knows() {
        let code_of = |c: &str| failure_error(c, "x").code;
        assert_eq!(
            code_of("Neo.ClientError.Security.Unauthorized"),
            ErrorCode::AuthFailed
        );
        assert_eq!(
            code_of("Neo.ClientError.Security.Forbidden"),
            ErrorCode::AccessDenied
        );
        assert_eq!(
            code_of("Neo.ClientError.Statement.AccessMode"),
            ErrorCode::ReadOnly
        );
        assert_eq!(
            code_of("Neo.ClientError.Statement.SyntaxError"),
            ErrorCode::QueryFailed
        );
        assert_eq!(
            code_of("Neo.TransientError.Transaction.Terminated"),
            ErrorCode::Cancelled
        );
        assert_eq!(
            code_of("Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration"),
            ErrorCode::Timeout
        );
    }

    #[test]
    fn a_syntax_error_position_is_one_based() {
        let e = failure_error(
            "Neo.ClientError.Statement.SyntaxError",
            "Invalid input 'x': expected something (line 1, column 5 (offset: 4))",
        );
        assert_eq!(e.position, Some(5));
        assert_eq!(
            e.detail.as_deref(),
            Some("Neo.ClientError.Statement.SyntaxError")
        );
    }

    #[test]
    fn addresses_bracket_ipv6() {
        assert_eq!(address("db.example.com", 7687), "db.example.com:7687");
        assert_eq!(address("::1", 7687), "[::1]:7687");
        assert_eq!(address("[::1]", 7687), "[::1]:7687");
    }

    #[test]
    fn responses_parse() {
        let ok = Ps::Struct {
            tag: 0x70,
            fields: vec![Ps::map([("fields", Ps::List(vec![]))])],
        };
        assert!(matches!(Resp::parse(ok).unwrap(), Resp::Success(_)));
        let rec = Ps::Struct {
            tag: 0x71,
            fields: vec![Ps::List(vec![Ps::Int(1)])],
        };
        assert_eq!(Resp::parse(rec).unwrap(), Resp::Record(vec![Ps::Int(1)]));
        let fail = Ps::Struct {
            tag: 0x7F,
            fields: vec![Ps::map([("code", Ps::str("C")), ("message", Ps::str("M"))])],
        };
        assert_eq!(
            Resp::parse(fail).unwrap(),
            Resp::Failure {
                code: "C".into(),
                message: "M".into()
            }
        );
        assert_eq!(
            Resp::parse(Ps::Struct {
                tag: 0x7E,
                fields: vec![]
            })
            .unwrap(),
            Resp::Ignored
        );
        assert!(Resp::parse(Ps::Int(1)).is_err());
    }
}
