## Context

Safeguard flags are stored per connection (`add-connection-management`). Execution paths: console `query_execute`, table editor `changes_apply`, explorer actions (Generate DDL opens in a console, so it is covered), AI inserts (they only insert text; running still goes through `query_execute`).

## Decisions

- **Guard in Rust, not only UI.** `safety::guard(session, statements) -> GuardDecision { Allow | NeedsConfirm(details) | NeedsTypedConfirm(details) | Block(reason) }` runs inside `query_execute` / `changes_apply`. The frontend shows the dialog and calls back with a one-time `confirmation_token` tied to the exact statement hash, so a confirmation cannot be reused for a different statement.
- **Classifier** uses `sqlparser-rs` with the connection's dialect; if parsing fails, the statement is `unknown` (treated as write). Leading comments and `EXPLAIN ANALYZE` (executes) are handled explicitly.
- **Database-level read-only**: PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; MySQL/MariaDB `SET SESSION TRANSACTION READ ONLY`; SQLite `PRAGMA query_only = ON`; SQL Server has no session read-only, so the guard is UI/Rust-only there (documented); ClickHouse `readonly=1` setting; DuckDB opens with `access_mode=READ_ONLY` on a separate connection.
- **Affected-row estimate**: `EXPLAIN` the UPDATE/DELETE and read the top node's row estimate (PG/MySQL); skip if it takes > 300 ms.

## Risks / Trade-offs

- [Classifier false negatives] → Database-level read-only is the backstop where available; unknown statements count as writes.
- [Confirmation fatigue on production] → Read-only is the default, so confirmations appear only after the user deliberately switched a session to read-write.
