## Context

Safeguard flags are stored per connection (`add-connection-management`). Execution paths: console `query_execute`, table editor `changes_apply`, explorer actions (Generate DDL opens in a console, so it is covered), AI inserts (they only insert text; running still goes through `query_execute`).

## Decisions

- **Guard in Rust, not only UI.** `safety::guard(session, statements) -> GuardDecision { Allow | NeedsConfirm(details) | NeedsTypedConfirm(details) | Block(reason) }` runs inside `query_execute` / `changes_apply`. The frontend shows the dialog and calls back with a one-time `confirmation_token` tied to the exact statement hash, so a confirmation cannot be reused for a different statement.
- **Classifier** uses `sqlparser-rs` with the connection's dialect; if parsing fails, the statement is `unknown` (treated as write). Leading comments and `EXPLAIN ANALYZE` (executes) are handled explicitly.
- **Database-level read-only**: PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; MySQL/MariaDB `SET SESSION TRANSACTION READ ONLY`; SQLite `PRAGMA query_only = ON`; SQL Server has no session read-only, so the guard is UI/Rust-only there (documented); Oracle issues `SET TRANSACTION READ ONLY` at the start of each transaction; ClickHouse `readonly=1` setting; DuckDB opens with `access_mode=READ_ONLY` on a separate connection.
- **Affected-row estimate**: `EXPLAIN` the UPDATE/DELETE and read the top node's row estimate (PG/MySQL); skip if it takes > 300 ms.

## Risks / Trade-offs

- [Classifier false negatives] → Database-level read-only is the backstop where available; unknown statements count as writes.
- [Confirmation fatigue on production] → Read-only is the default, so confirmations appear only after the user deliberately switched a session to read-write.

## Decisions made during implementation

- **Where the guard runs.** Inside `SessionManager` (`execute_inner` and `apply_changes`), the one place every statement passes through, so the UI cannot skip it. The frontend first calls `safety_check`, which returns the decision plus what a dialog needs (statements, estimates, the text to type) and, when a question is asked, a one-time token. The token is bound to the session and the exact statement text; running with a missing, reused or mismatched token fails with `confirmation_required`.
- **Decisions.** `allow`, `block` (read-only session), `confirm`, `typed_confirm`. A session that is read-only blocks anything that is not a read or session control. A dangerous statement (UPDATE/DELETE without WHERE, TRUNCATE, DROP of a table/schema/database) needs the connection name typed on production and a warning confirmation elsewhere, even when "confirm writes" is off. Otherwise "confirm writes" asks for any write, DDL or unknown statement.
- **Policy is registered per connection** when it connects (`set_policy`: name, environment, confirm writes). Connections that have no policy (unit tests) get no confirmations, only read-only enforcement.
- **Classification** uses `sqlparser` with the connection's dialect, plus an explicit `control` class (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/USE/harmless SET) that read-only sessions allow; a `SET` that mentions read/transaction is not control, so it cannot lift the protection. EXPLAIN ANALYZE takes the class of the explained statement. `sqlparser` cannot read `PRAGMA table_info(x)`, so SQLite read-only PRAGMAs are recognised by name; any other valued PRAGMA is unknown (a write).
- **Database-level read-only is switchable.** SQLite now uses `PRAGMA query_only` for read-only sessions instead of opening the file read-only (which cannot be undone); a file the user marked read-only still opens read-only. PostgreSQL and MySQL/MariaDB use `SET SESSION … READ ONLY | READ WRITE`. A session switched to read-write keeps that across an automatic reconnect. SQL Server, Oracle, ClickHouse and DuckDB arrive with `add-more-sql-drivers` and need their own `set_read_only`.
- **Estimates.** The UPDATE/DELETE is rewritten to the SELECT that finds the same rows and that is `EXPLAIN`ed (PostgreSQL JSON plan, MySQL `FORMAT=JSON`, MariaDB tabular), abandoned after 300 ms. MySQL 8 does not describe EXPLAIN's columns when preparing, so the MySQL driver now returns rows from statements it cannot prepare instead of discarding them (this also fixes Explain in the console on MySQL).
- **Table edits** go through the same guard: `safety_check_changes` and `changes_apply` carry the token. The table editor's read-only state is its session's, with the same badge and toggle as consoles.
- **Quitting.** The backend holds window close and app exit while any session has an open transaction and tells the frontend (`quit-requested`); the frontend asks Commit / Roll back / Cancel per console and then calls `app_quit_confirmed`. Closing a tab and disconnecting already asked.
- **Not done.** The AI panel's production notice belongs to `add-ai-assistant`.
