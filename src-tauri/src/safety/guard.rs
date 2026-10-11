//! The decision: may these statements run on this session, do they need the user's say-so, or are
//! they blocked? The decision is made here in Rust; the frontend only shows the dialogs. A
//! confirmation is a one-time token tied to the exact text that was shown.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::classify::{StatementClass, StatementInfo};

/// What a connection's safeguards say, as far as the guard needs them.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// The connection's name; typed back to confirm a dangerous statement on production.
    pub name: String,
    /// `local`, `development`, `staging` or `production`.
    pub environment: String,
    pub confirm_writes: bool,
    /// Ask before UPDATE / DELETE without WHERE, TRUNCATE and DROP. Always on for connections
    /// the app manages; the `Default` (no policy registered, as in unit tests) leaves it off.
    pub warn_dangerous: bool,
}

impl Policy {
    /// The policy of a saved connection.
    pub fn managed(name: &str, environment: &str, confirm_writes: bool) -> Self {
        Self {
            name: name.to_string(),
            environment: environment.to_string(),
            confirm_writes,
            warn_dangerous: true,
        }
    }

    pub fn is_production(&self) -> bool {
        self.environment == "production"
    }
}

#[derive(ts_rs::TS)]
#[ts(export)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    /// Not sent: nothing may change on this session.
    Block,
    Confirm,
    /// Production and dangerous: the user must type the connection's name.
    TypedConfirm,
}

/// The reason shown when a write is refused on a read-only session.
pub const READ_ONLY_REASON: &str = "This session is read-only";

pub fn decide(statements: &[StatementInfo], read_only: bool, policy: &Policy) -> Decision {
    let mutating = statements.iter().any(|s| s.class.mutates());
    if !mutating {
        return Decision::Allow;
    }
    if read_only {
        return Decision::Block;
    }
    if policy.warn_dangerous && statements.iter().any(|s| s.danger.is_some()) {
        return if policy.is_production() {
            Decision::TypedConfirm
        } else {
            Decision::Confirm
        };
    }
    if policy.confirm_writes {
        Decision::Confirm
    } else {
        Decision::Allow
    }
}

/// Class counts for tests and the dialog's summary.
pub fn mutating(statements: &[StatementInfo]) -> impl Iterator<Item = &StatementInfo> {
    statements
        .iter()
        .filter(|s| s.class.mutates() || s.class == StatementClass::Ddl)
}

const TOKEN_LIFETIME: Duration = Duration::from_secs(5 * 60);

struct Granted {
    session_id: String,
    text: String,
    at: Instant,
}

/// One-time confirmation tokens.
#[derive(Default)]
pub struct Tokens {
    granted: HashMap<String, Granted>,
    next: u64,
}

/// The text a token is bound to: statement texts joined, so any edit invalidates it.
pub fn bound_text(statements: &[StatementInfo]) -> String {
    statements
        .iter()
        .map(|s| s.text.trim())
        .collect::<Vec<_>>()
        .join("\n;\n")
}

impl Tokens {
    pub fn mint(&mut self, session_id: &str, text: String) -> String {
        self.granted.retain(|_, g| g.at.elapsed() < TOKEN_LIFETIME);
        self.next += 1;
        // Unguessability isn't the point (the webview is trusted); uniqueness and single use are.
        let token = format!("confirm-{}-{}", self.next, now_nanos());
        self.granted.insert(
            token.clone(),
            Granted {
                session_id: session_id.to_string(),
                text,
                at: Instant::now(),
            },
        );
        token
    }

    /// Use a token. It works once, for the session and exact text it was minted for.
    pub fn consume(&mut self, token: &str, session_id: &str, text: &str) -> bool {
        match self.granted.remove(token) {
            Some(g) => {
                g.at.elapsed() < TOKEN_LIFETIME && g.session_id == session_id && g.text == text
            }
            None => false,
        }
    }
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safety::classify::classify;

    fn infos(sql: &str) -> Vec<StatementInfo> {
        classify(sql, "postgres", None, true)
    }
    fn policy(env: &str, confirm: bool) -> Policy {
        Policy::managed("prod-postgres", env, confirm)
    }

    #[test]
    fn reads_and_control_always_run() {
        for read_only in [true, false] {
            for sql in ["SELECT 1", "BEGIN", "COMMIT", "SET search_path = a"] {
                assert_eq!(
                    decide(&infos(sql), read_only, &policy("production", true)),
                    Decision::Allow,
                    "{sql}"
                );
            }
        }
    }

    #[test]
    fn a_read_only_session_blocks_every_kind_of_change() {
        for sql in [
            "UPDATE t SET a = 1 WHERE id = 1",
            "CREATE TABLE x (a int)",
            "CALL p()",
            "SELEC 1",
            "SELECT 1; DELETE FROM t WHERE id = 2",
        ] {
            assert_eq!(
                decide(&infos(sql), true, &policy("production", true)),
                Decision::Block,
                "{sql}"
            );
        }
    }

    #[test]
    fn confirm_writes_asks_for_anything_that_changes() {
        let p = policy("production", true);
        assert_eq!(
            decide(&infos("UPDATE t SET a = 1 WHERE id = 1"), false, &p),
            Decision::Confirm
        );
        assert_eq!(
            decide(&infos("CREATE TABLE x (a int)"), false, &p),
            Decision::Confirm
        );
        assert_eq!(decide(&infos("CALL p()"), false, &p), Decision::Confirm);
        let off = policy("development", false);
        assert_eq!(
            decide(&infos("UPDATE t SET a = 1 WHERE id = 1"), false, &off),
            Decision::Allow
        );
    }

    #[test]
    fn dangerous_statements_need_the_name_on_production_and_a_warning_elsewhere() {
        for sql in [
            "DELETE FROM orders",
            "TRUNCATE orders",
            "DROP TABLE orders",
            "UPDATE orders SET a = 1",
        ] {
            assert_eq!(
                decide(&infos(sql), false, &policy("production", false)),
                Decision::TypedConfirm,
                "{sql}"
            );
            assert_eq!(
                decide(&infos(sql), false, &policy("local", false)),
                Decision::Confirm,
                "{sql}"
            );
            assert_eq!(
                decide(&infos(sql), false, &policy("staging", true)),
                Decision::Confirm,
                "{sql}"
            );
        }
    }

    #[test]
    fn a_script_is_judged_by_its_worst_statement() {
        let sql = "UPDATE t SET a = 1 WHERE id = 1; DELETE FROM t";
        assert_eq!(
            decide(&infos(sql), false, &policy("production", false)),
            Decision::TypedConfirm
        );
    }

    #[test]
    fn a_token_works_once_for_the_same_session_and_text() {
        let mut t = Tokens::default();
        let token = t.mint("s1", "DELETE FROM t".into());
        assert!(!t.consume(&token, "s2", "DELETE FROM t"), "other session");
        let token = t.mint("s1", "DELETE FROM t".into());
        assert!(!t.consume(&token, "s1", "DELETE FROM u"), "other statement");
        let token = t.mint("s1", "DELETE FROM t".into());
        assert!(t.consume(&token, "s1", "DELETE FROM t"));
        assert!(!t.consume(&token, "s1", "DELETE FROM t"), "single use");
        assert!(!t.consume("nope", "s1", "x"));
    }

    #[test]
    fn bound_text_changes_with_any_edit() {
        let a = bound_text(&infos("DELETE FROM t WHERE id = 1"));
        let b = bound_text(&infos("DELETE FROM t WHERE id = 2"));
        assert_ne!(a, b);
    }
}
