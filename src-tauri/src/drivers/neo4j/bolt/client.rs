//! Connections to a server or a cluster: `bolt://` goes to one address, `neo4j://` asks the
//! cluster for a routing table (ROUTE) and picks readers and writers from it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::conn::{self, failure_error, Conn, ConnectOpts, Resp};
use super::packstream::Ps;
use crate::drivers::graph::GraphAccess;
use crate::drivers::{DriverError, DriverResult, ErrorCode};

/// Idle connections kept per address.
const IDLE_PER_ADDRESS: usize = 2;
/// A routing table is refreshed after this long even if the server's TTL is longer.
const MAX_TABLE_AGE: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RoutingTable {
    pub readers: Vec<String>,
    pub writers: Vec<String>,
    pub routers: Vec<String>,
}

impl RoutingTable {
    /// Parse the `rt` map of a ROUTE answer.
    pub fn parse(rt: &Ps) -> RoutingTable {
        let mut table = RoutingTable::default();
        for server in rt.get("servers").and_then(Ps::as_list).unwrap_or_default() {
            let addresses: Vec<String> = server
                .get("addresses")
                .and_then(Ps::as_list)
                .unwrap_or_default()
                .iter()
                .filter_map(|a| a.as_str().map(str::to_string))
                .collect();
            match server.get("role").and_then(Ps::as_str) {
                Some("READ") => table.readers.extend(addresses),
                Some("WRITE") => table.writers.extend(addresses),
                Some("ROUTE") => table.routers.extend(addresses),
                _ => {}
            }
        }
        table
    }

    /// Distinct servers in the table.
    pub fn members(&self) -> usize {
        let mut all: Vec<&String> = self
            .readers
            .iter()
            .chain(&self.writers)
            .chain(&self.routers)
            .collect();
        all.sort();
        all.dedup();
        all.len()
    }
}

struct Cached {
    table: RoutingTable,
    fetched: Instant,
    ttl: Duration,
}

pub struct Client {
    opts: ConnectOpts,
    cache: HashMap<String, Cached>,
    idle: HashMap<String, Vec<Conn>>,
    /// Rotates through the candidates of a role.
    turn: usize,
}

fn split_address(addr: &str) -> Option<(String, u16)> {
    let (host, port) = addr.rsplit_once(':')?;
    Some((
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .to_string(),
        port.parse().ok()?,
    ))
}

impl Client {
    pub fn new(opts: ConnectOpts) -> Self {
        Self {
            opts,
            cache: HashMap::new(),
            idle: HashMap::new(),
            turn: 0,
        }
    }

    pub fn routed(&self) -> bool {
        self.opts.routing.is_some()
    }

    pub fn initial_address(&self) -> String {
        self.opts.address()
    }

    async fn connect(&self, addr: &str) -> DriverResult<Conn> {
        if addr == self.opts.address() {
            return Conn::open(&self.opts).await;
        }
        let (host, port) = split_address(addr).ok_or_else(|| {
            DriverError::new(
                ErrorCode::ConnectionLost,
                format!("The cluster named a server address Clew cannot read: {addr}"),
            )
        })?;
        let mut opts = ConnectOpts {
            host,
            port,
            user: self.opts.user.clone(),
            password: self.opts.password.clone(),
            tls: self.opts.tls.clone(),
            routing: self.opts.routing.clone(),
            timeout: self.opts.timeout,
        };
        // the routing context names the address the user typed, which every member shares
        opts.routing = self.opts.routing.clone();
        Conn::open(&opts).await
    }

    async fn take_or_connect(&mut self, addr: &str) -> DriverResult<Conn> {
        while let Some(conn) = self.idle.get_mut(addr).and_then(Vec::pop) {
            if conn.is_idle() {
                return Ok(conn);
            }
        }
        self.connect(addr).await
    }

    /// A connection ready for a new transaction on `db` in the given access mode.
    pub async fn acquire(&mut self, db: Option<&str>, access: GraphAccess) -> DriverResult<Conn> {
        if !self.routed() {
            let addr = self.opts.address();
            return self.take_or_connect(&addr).await;
        }
        let mut last: Option<DriverError> = None;
        for attempt in 0..2 {
            let table = self.table(db, attempt > 0).await?;
            let candidates = match access {
                GraphAccess::Read => [&table.readers, &table.writers],
                GraphAccess::Write => [&table.writers, &table.writers],
            };
            let list = if candidates[0].is_empty() {
                candidates[1]
            } else {
                candidates[0]
            };
            if list.is_empty() {
                return Err(DriverError::new(
                    ErrorCode::ConnectionLost,
                    match access {
                        GraphAccess::Read => "The cluster has no server that can read right now",
                        GraphAccess::Write => "The cluster has no writer right now (no leader)",
                    },
                ));
            }
            self.turn = self.turn.wrapping_add(1);
            for i in 0..list.len() {
                let addr = list[(self.turn + i) % list.len()].clone();
                match self.take_or_connect(&addr).await {
                    Ok(c) => return Ok(c),
                    Err(e) => last = Some(e),
                }
            }
            self.cache.remove(db.unwrap_or(""));
        }
        Err(last.unwrap_or_else(|| {
            DriverError::new(
                ErrorCode::ConnectionLost,
                "No server in the cluster answered",
            )
        }))
    }

    /// Give a connection back. One that is not ready for the next transaction is closed.
    pub fn release(&mut self, conn: Conn) {
        if !conn.is_idle() {
            return;
        }
        let list = self.idle.entry(conn.address.clone()).or_default();
        if list.len() < IDLE_PER_ADDRESS {
            list.push(conn);
        }
    }

    /// The server rejected the write (`NotALeader`, `ForbiddenOnReadOnlyDatabase`): ask again.
    pub fn forget_routing(&mut self) {
        self.cache.clear();
    }

    pub async fn close(&mut self) {
        for (_, conns) in self.idle.drain() {
            for c in conns {
                c.close().await;
            }
        }
    }

    /// The routing table for `db`, from the cache unless `refresh` or it expired.
    pub async fn table(&mut self, db: Option<&str>, refresh: bool) -> DriverResult<RoutingTable> {
        let key = db.unwrap_or("").to_string();
        if !refresh {
            if let Some(c) = self.cache.get(&key) {
                if c.fetched.elapsed() < c.ttl.min(MAX_TABLE_AGE) {
                    return Ok(c.table.clone());
                }
            }
        }
        // ask the known routers first, then the address the user gave
        let mut routers: Vec<String> = self
            .cache
            .get(&key)
            .map(|c| c.table.routers.clone())
            .unwrap_or_default();
        let initial = self.opts.address();
        if !routers.contains(&initial) {
            routers.push(initial);
        }
        let mut last: Option<DriverError> = None;
        for addr in routers {
            match self.fetch_table(&addr, db).await {
                Ok((table, ttl)) => {
                    self.cache.insert(
                        key,
                        Cached {
                            table: table.clone(),
                            fetched: Instant::now(),
                            ttl,
                        },
                    );
                    return Ok(table);
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| DriverError::internal("no router to ask")))
    }

    async fn fetch_table(
        &mut self,
        addr: &str,
        db: Option<&str>,
    ) -> DriverResult<(RoutingTable, Duration)> {
        let mut conn = self.take_or_connect(addr).await?;
        let ctx = Ps::Map(self.opts.routing.clone().unwrap_or_default());
        let extra = match db {
            Some(d) => Ps::map([("db", Ps::str(d))]),
            None => Ps::Map(vec![]),
        };
        let result = async {
            conn.send(conn::ROUTE, vec![ctx, Ps::List(vec![]), extra])
                .await?;
            match conn.recv().await? {
                Resp::Success(meta) => Ok(meta),
                Resp::Failure { code, message } => {
                    conn.recover().await;
                    Err(failure_error(&code, &message))
                }
                _ => Err(DriverError::internal("unexpected answer to ROUTE")),
            }
        }
        .await;
        let meta = match result {
            Ok(m) => m,
            Err(e) => {
                self.release(conn);
                return Err(e);
            }
        };
        self.release(conn);
        let rt = meta
            .get("rt")
            .ok_or_else(|| DriverError::internal("the routing table is missing"))?;
        let ttl = rt.get("ttl").and_then(Ps::as_i64).unwrap_or(300).max(0) as u64;
        Ok((RoutingTable::parse(rt), Duration::from_secs(ttl)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(role: &str, addrs: &[&str]) -> Ps {
        Ps::map([
            ("role", Ps::str(role)),
            (
                "addresses",
                Ps::List(addrs.iter().map(|a| Ps::str(*a)).collect()),
            ),
        ])
    }

    #[test]
    fn a_routing_table_is_read_from_the_route_answer() {
        let rt = Ps::map([
            ("ttl", Ps::Int(300)),
            ("db", Ps::str("neo4j")),
            (
                "servers",
                Ps::List(vec![
                    server("WRITE", &["a:7687"]),
                    server("READ", &["b:7687", "c:7687"]),
                    server("ROUTE", &["a:7687", "b:7687", "c:7687"]),
                ]),
            ),
        ]);
        let t = RoutingTable::parse(&rt);
        assert_eq!(t.writers, ["a:7687"]);
        assert_eq!(t.readers, ["b:7687", "c:7687"]);
        assert_eq!(t.routers.len(), 3);
        assert_eq!(t.members(), 3);
    }

    #[test]
    fn a_single_server_is_one_member() {
        let rt = Ps::map([(
            "servers",
            Ps::List(vec![
                server("WRITE", &["h:7687"]),
                server("READ", &["h:7687"]),
                server("ROUTE", &["h:7687"]),
            ]),
        )]);
        assert_eq!(RoutingTable::parse(&rt).members(), 1);
    }

    #[test]
    fn addresses_split_into_host_and_port() {
        assert_eq!(split_address("db:7687"), Some(("db".into(), 7687)));
        assert_eq!(split_address("[::1]:7687"), Some(("::1".into(), 7687)));
        assert_eq!(split_address("nope"), None);
    }
}
