//! A small Bolt client: PackStream, connections, routing. Bolt 5.0–5.8 and 4.4.
//!
//! This replaces the `neo4rs` crate the design first named: its newest release (0.9.0-rc.10)
//! stops at Bolt 4.4, hides the plan, temporal fields and element ids behind private fields, and
//! only routes behind an unstable feature (see the change's design.md).

pub mod client;
pub mod conn;
pub mod packstream;

pub use client::Client;
pub use conn::{Conn, ConnectOpts, Resp};
pub use packstream::Ps;
