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
