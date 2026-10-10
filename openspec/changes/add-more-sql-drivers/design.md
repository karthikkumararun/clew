## Context

The driver contract and conformance suite exist from `add-driver-framework`. This change adds five SQL drivers that slot into the registry; no UI changes are needed because forms, badges and default ports come from `DriverMeta`.

## Decisions

- **MySQL/MariaDB** share `drivers/mysql/` with a `Flavor` enum (differences: JSON type, sequences, `RETURNING` support in MariaDB). sqlx `mysql` streaming via `fetch`.
- **SQL Server** via `tiberius` (pure Rust TDS) over `tokio-util` compat. Windows integrated auth uses the `winauth` feature on Windows builds only. Batches split on `^\s*GO\s*$` (case-insensitive) before the statement splitter.
- **ClickHouse** via the official `clickhouse` crate (HTTP). The `query_id` is generated per execution so cancel can `KILL QUERY`. Grid editing is disabled (`editable_results = false`) because ClickHouse mutations are asynchronous.
- **DuckDB** via `duckdb` crate `bundled` (no system dependency). Runs on a blocking thread like SQLite; `interrupt()` for cancel.
- **Value mapping** tables live next to each driver (`types.rs`) with unit tests per type.

## Risks / Trade-offs

- [DuckDB bundled build time (~3–5 min) and binary size] → Accept; it is a headline feature for local analytics. Cache the build in CI.
- [SQL Server container needs ~2 GB RAM in CI] → Run the mssql integration job on a schedule and on demand, not on every push.
- [ClickHouse HTTP has no session state] → Sessions are emulated with a `session_id` parameter so `SET` statements persist.
