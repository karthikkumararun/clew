## Context

The driver contract and conformance suite exist from `add-driver-framework`. This change adds four SQL drivers that slot into the registry; no UI changes are needed because forms, badges and default ports come from `DriverMeta`.

## Decisions

- **Oracle** via the `oracle` crate (rust-oracle on ODPI-C). ODPI-C loads the Oracle Instant Client libraries at runtime, so Clew stays buildable and distributable without Oracle software; the user installs the free Instant Client once. Detection order: Settings path → `ORACLE_HOME` → library path → standard folders (`~/Downloads/instantclient_*`, `/opt/oracle/instantclient_*`, `C:\oracle\instantclient_*`). Calls run on `spawn_blocking` (the crate is synchronous). Cancel uses `Connection::break_execution()`. Script splitting adds the SQL*Plus `/` terminator and PL/SQL block detection to `split.rs`. DBMS_OUTPUT is enabled per session and drained after each statement. Types: NUMBER → decimal string (int when scale 0 and ≤ 18 digits), DATE/TIMESTAMP[ WITH [LOCAL] TIME ZONE], INTERVAL, RAW → bytes, CLOB/NCLOB/BLOB → truncated with on-demand fetch, ROWID → text. Editing uses the primary key, else ROWID.
- **SQL Server** via `tiberius` (pure Rust TDS) over `tokio-util` compat. Windows integrated auth uses the `winauth` feature on Windows builds only. Batches split on `^\s*GO\s*$` (case-insensitive) before the statement splitter.
- **ClickHouse** via the official `clickhouse` crate (HTTP). The `query_id` is generated per execution so cancel can `KILL QUERY`. Grid editing is disabled (`editable_results = false`) because ClickHouse mutations are asynchronous.
- **DuckDB** via `duckdb` crate `bundled` (no system dependency). Runs on a blocking thread like SQLite; `interrupt()` for cancel.
- **Value mapping** tables live next to each driver (`types.rs`) with unit tests per type.

## Risks / Trade-offs

- [Oracle Instant Client can't be bundled under Oracle's license and must match the CPU (arm64 build on Apple Silicon)] → Detect it, explain and link from the dialog, and show the found version.
- [Oracle docker image is large (~1.5 GB) and slow to start] → Run Oracle integration tests on a schedule / on demand, like SQL Server.
- [DuckDB bundled build time (~3–5 min) and binary size] → Accept; it is a headline feature for local analytics. Cache the build in CI.
- [SQL Server container needs ~2 GB RAM in CI] → Run the mssql integration job on a schedule and on demand, not on every push.
- [ClickHouse HTTP has no session state] → Sessions are emulated with a `session_id` parameter so `SET` statements persist.

## Decisions made during implementation

- **ClickHouse speaks `JSONCompactEachRowWithNamesAndTypes`, not RowBinary, and uses `reqwest` rather than the `clickhouse` crate.** The crate only reads rows into types known at compile time; a database client needs arbitrary columns. The JSON format carries names, types and values, streams line by line, and (with `output_format_json_quote_64bit_integers` and `…_quote_decimals`) loses nothing: 64-bit integers and decimals arrive as strings. Cancel is `KILL QUERY WHERE query_id = …`; sessions are a `session_id` sent with every request; `readonly=1` is sent per request, so a session can be switched to read-write.
- **SQL Server runs everything as a plain SQL batch.** tiberius' `execute` goes through `sp_executesql`, which scopes `USE`, `SET`, `#temp` tables and `BEGIN TRANSACTION` to the call. Row counts come from `SELECT @@ROWCOUNT` appended to INSERT/UPDATE/DELETE/MERGE. Scripts split on `GO` lines; inside a batch plain statements still split at `;` (so `SELECT 1; SELECT 2` shows two results) unless the batch uses variables (`@`), a block or a module definition. Only the first result set of a batch that returns several is shown.
- **SQL Server cancel.** A TDS attention is sent, but tiberius only waits for the acknowledgement for as long as the current message lasts; when it fails the late acknowledgement would be read as the answer to the next query. So the connection is marked broken after a failed cancel and the session manager replaces it before the next statement (`Session::is_alive`), with its usual "connection was re-established" notice. Temporary tables, `SET` options and an open transaction do not survive a cancel. An abandoned result is drained for up to 1.5 s before giving up in the same way.
- **SQL Server TLS.** The login handshake is always TLS and the auto-generated certificate fails rustls' checks, so with TLS off the certificate is accepted (nothing is protected by verifying it); with VerifyCa / VerifyFull it is verified.
- **Oracle** uses `rust-oracle` / ODPI-C and the user's Instant Client. The folder is looked for in Settings, `ORACLE_HOME`, the library path and the usual download folders; the connection dialog shows what was found, or what to install, and keeps Test connection disabled until it is found. The handle is shared (`Arc`), so statements are committed explicitly instead of toggling ODPI-C's autocommit (which needs `&mut`); `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` are handled by the session. A read-only session opens each statement with `COMMIT` + `SET TRANSACTION READ ONLY`; switching to read-write commits the open read-only transaction. DBMS_OUTPUT is drained after every statement into notices. Plain strings convert to dates and timestamps through fixed `NLS_*_FORMAT` settings so table edits can bind text.
- **Oracle: editing uses the primary or unique key only.** Addressing rows by ROWID (for tables without a key) is not implemented; such tables are read-only in the grid ("result has no unique key"). Execution plans (`EXPLAIN PLAN` + `DBMS_XPLAN`) are not wired up for Oracle or SQL Server yet.
- **Oracle: `DBMS_SESSION.SLEEP` does not stop on a break** (a busy query does), so the cancel conformance test uses a CPU-bound query.
- **DuckDB** runs on blocking threads, one connection cloned per session from a shared database, so sessions and the tree see the same data (including `:memory:`). A database's access mode is fixed when it opens, so the session toggle can't switch a DuckDB connection to read-write (it says to reconnect).
- **Transaction detection is dialect-aware**: a bare `BEGIN` opens a block in Oracle and T-SQL, so only `BEGIN TRANSACTION` counts there. ClickHouse has no transactions and its consoles hide the Tx controls.
- **CI.** DuckDB needs nothing; ClickHouse joins the regular integration job. SQL Server and Oracle are under the compose `heavy` profile and the `integration-heavy` feature, run weekly and on pull requests that touch them (`heavy-integration.yml`), with the Linux Instant Client downloaded in the job.

### Not done here
- Tasks 6.1 / 6.2 (end-to-end journey J-18): the `e2e/` framework they build on does not exist yet.
