//! What the Sessions panel shows about each session: state, timing, the open transaction and its
//! recent statements. Memory only; statement text is truncated and dropped when the transaction
//! ends.

use serde::Serialize;

use crate::drivers::TxState;

/// Statements kept for the open transaction.
pub const TX_STATEMENT_CAP: usize = 20;
/// Characters of statement text kept per statement.
pub const TX_STATEMENT_CHARS: usize = 2000;
/// Characters of the running statement shown in the row.
const RUNNING_CHARS: usize = 200;

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    InTransaction,
    /// A statement failed inside a PostgreSQL transaction; only a rollback clears it.
    Aborted,
    Disconnected,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxBreakdown {
    pub select: u32,
    pub insert: u32,
    pub update: u32,
    pub delete: u32,
    pub other: u32,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxStatement {
    /// Milliseconds since the epoch.
    #[ts(type = "number")]
    pub at: i64,
    /// `select`, `insert`, `update`, `delete` or `other`.
    pub kind: String,
    pub text: String,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub connection_id: String,
    pub tab_id: Option<String>,
    pub name: String,
    pub state: SessionState,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub last_activity_at: i64,
    #[ts(type = "number | null")]
    pub running_since: Option<i64>,
    pub running_statement: Option<String>,
    #[ts(type = "number | null")]
    pub tx_started_at: Option<i64>,
    pub tx_statement_count: u32,
    pub tx_breakdown: TxBreakdown,
    /// The last [`TX_STATEMENT_CAP`] statements of the open transaction, oldest first.
    pub tx_statements: Vec<TxStatement>,
    /// Current default level for the next transaction, upper-case (`READ COMMITTED`).
    pub isolation: Option<String>,
    pub supported_isolation: Vec<String>,
    /// Why the level cannot be selected, when `supported_isolation` is empty.
    pub isolation_note: Option<String>,
    /// The server's identifier for the session (PostgreSQL PID, MySQL connection id).
    pub backend_id: Option<String>,
    pub read_only: bool,
    /// Other tabs attached to this session (not counting `tab_id`).
    pub shared_with: Vec<String>,
    /// Set while a statement from another tab is queued behind the running one: the name of the
    /// session (tab) that holds it.
    pub waiting_for: Option<String>,
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    /// Every session, sent once when a subscriber attaches.
    Snapshot {
        sessions: Vec<SessionMeta>,
    },
    Upsert {
        session: SessionMeta,
    },
    Removed {
        id: String,
    },
}

/// `select`, `insert`, `update`, `delete` or `other` by the statement's first keyword.
pub fn statement_kind(sql: &str) -> &'static str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, t)| t).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, t)| t).trim_start();
        } else if let Some(r) = rest.strip_prefix('(') {
            rest = r.trim_start();
        } else {
            break;
        }
    }
    let word = rest
        .split(|c: char| !c.is_ascii_alphanumeric())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    match word.as_str() {
        "SELECT" | "WITH" | "TABLE" | "VALUES" => "select",
        "INSERT" | "REPLACE" => "insert",
        "UPDATE" => "update",
        "DELETE" => "delete",
        _ => "other",
    }
}

fn is_savepoint(sql: &str) -> bool {
    first_words(sql, 1) == ["SAVEPOINT"]
}

/// `ROLLBACK TO [SAVEPOINT] x`: ends the failure of a PostgreSQL transaction, not the transaction.
fn is_rollback_to(sql: &str) -> bool {
    let w = first_words(sql, 2);
    w.first().is_some_and(|f| f == "ROLLBACK")
        && matches!(w.get(1).map(String::as_str), Some("TO" | "SAVEPOINT"))
}

fn first_words(sql: &str, n: usize) -> Vec<String> {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, t)| t).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, t)| t).trim_start();
        } else {
            break;
        }
    }
    rest.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(n)
        .map(str::to_ascii_uppercase)
        .collect()
}

/// At most `max` characters of `text`.
pub fn truncate(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => text[..i].to_string(),
        None => text.to_string(),
    }
}

/// A session's meta plus the bookkeeping that decides its state.
#[derive(Debug, Clone)]
pub struct MetaCell {
    pub meta: SessionMeta,
    tx_open: bool,
    aborted: bool,
    disconnected: bool,
    /// The open transaction has a savepoint: a failed statement may still be recovered from.
    savepoint: bool,
}

impl MetaCell {
    pub fn new(meta: SessionMeta) -> Self {
        Self {
            meta,
            tx_open: false,
            aborted: false,
            disconnected: false,
            savepoint: false,
        }
    }

    pub fn tx_open(&self) -> bool {
        self.tx_open
    }

    pub fn aborted(&self) -> bool {
        self.aborted
    }

    pub fn has_savepoint(&self) -> bool {
        self.savepoint
    }

    fn rest_state(&self) -> SessionState {
        if self.disconnected {
            SessionState::Disconnected
        } else if self.aborted {
            SessionState::Aborted
        } else if self.tx_open {
            SessionState::InTransaction
        } else {
            SessionState::Idle
        }
    }

    /// A statement starts running.
    pub fn statement_started(&mut self, sql: &str, hidden: bool, now: i64) {
        self.disconnected = false;
        self.meta.state = SessionState::Running;
        self.meta.running_since = Some(now);
        self.meta.running_statement = Some(if hidden {
            "(hidden)".to_string()
        } else {
            truncate(sql.trim(), RUNNING_CHARS)
        });
        self.meta.last_activity_at = now;
    }

    fn stop_running(&mut self, now: i64) {
        self.meta.running_since = None;
        self.meta.running_statement = None;
        self.meta.last_activity_at = now;
    }

    /// The statement finished. `effect` is its transaction effect (`Some(true)` opens,
    /// `Some(false)` ends one).
    ///
    /// `count` is false for statements Clew runs on its own (row estimates, namespace switches):
    /// they never show up in the transaction's statement list.
    pub fn statement_ok(
        &mut self,
        sql: &str,
        hidden: bool,
        count: bool,
        effect: Option<bool>,
        now: i64,
    ) {
        self.stop_running(now);
        match effect {
            Some(true) => self.begin_tx(now),
            Some(false) => self.end_tx(),
            None if is_rollback_to(sql) => self.aborted = false,
            None if self.tx_open && count => self.record(sql, hidden, now),
            None => {}
        }
        self.meta.state = self.rest_state();
    }

    /// The statement failed. `aborts` says the failure leaves a transaction aborted (the manager
    /// decides by driver); `lost` that the connection went away.
    pub fn statement_failed(&mut self, aborts: bool, lost: bool, now: i64) {
        self.stop_running(now);
        if lost {
            self.disconnected = true;
            self.end_tx();
        } else if aborts && self.tx_open {
            self.aborted = true;
        }
        self.meta.state = self.rest_state();
    }

    /// A statement was cancelled or failed without changing the transaction (or only the
    /// transaction state the server confirmed): put the row back to its resting state.
    pub fn settle(&mut self) {
        self.meta.state = self.rest_state();
    }

    /// The server says the transaction is gone (deadlock victim, timeout, ...).
    pub fn server_says(&mut self, state: TxState, now: i64) {
        match state {
            TxState::Idle => self.end_tx(),
            TxState::InTransaction => {
                if !self.tx_open {
                    self.begin_tx(now);
                }
            }
            TxState::Aborted => {
                if !self.tx_open {
                    self.begin_tx(now);
                }
                self.aborted = true;
            }
        }
        self.meta.state = self.rest_state();
    }

    /// The session was closed on purpose or lost: nothing is running or open.
    pub fn set_disconnected(&mut self, now: i64) {
        self.stop_running(now);
        self.disconnected = true;
        self.end_tx();
        self.meta.state = SessionState::Disconnected;
    }

    /// A fresh connection replaced the lost one.
    pub fn set_reconnected(&mut self) {
        self.disconnected = false;
        self.end_tx();
        self.meta.state = self.rest_state();
    }

    /// Staged table edits ran: `statements` were applied and the transaction is `open` afterwards.
    pub fn changes_applied(&mut self, kinds_and_text: &[(String, String)], open: bool, now: i64) {
        self.stop_running(now);
        if open {
            if !self.tx_open {
                self.begin_tx(now);
            }
            for (kind, text) in kinds_and_text {
                self.push(kind, text, now);
            }
        } else {
            self.end_tx();
        }
        self.meta.state = self.rest_state();
    }

    fn begin_tx(&mut self, now: i64) {
        if self.tx_open {
            return;
        }
        self.tx_open = true;
        self.aborted = false;
        self.savepoint = false;
        self.meta.tx_started_at = Some(now);
        self.meta.tx_statement_count = 0;
        self.meta.tx_breakdown = TxBreakdown::default();
        self.meta.tx_statements.clear();
    }

    /// Forget the transaction: counts, timing and every statement text.
    pub fn end_tx(&mut self) {
        self.tx_open = false;
        self.aborted = false;
        self.savepoint = false;
        self.meta.tx_started_at = None;
        self.meta.tx_statement_count = 0;
        self.meta.tx_breakdown = TxBreakdown::default();
        self.meta.tx_statements.clear();
    }

    fn record(&mut self, sql: &str, hidden: bool, now: i64) {
        if is_savepoint(sql) {
            self.savepoint = true;
        }
        let kind = statement_kind(sql);
        let text = if hidden { "(hidden)" } else { sql.trim() };
        self.push(kind, text, now);
    }

    fn push(&mut self, kind: &str, text: &str, now: i64) {
        self.meta.tx_statement_count += 1;
        let b = &mut self.meta.tx_breakdown;
        match kind {
            "select" => b.select += 1,
            "insert" => b.insert += 1,
            "update" => b.update += 1,
            "delete" => b.delete += 1,
            _ => b.other += 1,
        }
        if self.meta.tx_statements.len() == TX_STATEMENT_CAP {
            self.meta.tx_statements.remove(0);
        }
        self.meta.tx_statements.push(TxStatement {
            at: now,
            kind: kind.to_string(),
            text: truncate(text, TX_STATEMENT_CHARS),
        });
    }
}
