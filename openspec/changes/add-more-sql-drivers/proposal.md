## Why

With the driver contract proven on PostgreSQL, MySQL and SQLite, the remaining SQL databases in the connection dialog (SQL Server, Oracle, ClickHouse, DuckDB) can be added behind the same contract and pass the same conformance suite, with no UI changes.

## What Changes

- Add drivers: SQL Server 2019+, Oracle 19c+ (incl. 23ai and Autonomous Database), ClickHouse 23+, DuckDB 1.x. (MySQL and MariaDB ship earlier, in `add-driver-framework`.)
- Each implements execution with streaming, cancel, the value model, introspection, completion snapshot, DDL generation, editing support (PK detection, DML quoting/paging) and database-level read-only where available.
- Extend the conformance suite and docker-compose with these databases.

Canvas: the SQL section of the driver list in `design/canvas/ConnectionDialog.dc.html` (badges MS, OR, CH, DK).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `driver-framework`: adds requirements for the SQL Server, Oracle, ClickHouse and DuckDB drivers (new requirements only, existing ones unchanged).

## Impact

- Rust: `src-tauri/src/drivers/{mssql/,oracle/,clickhouse/,duckdb/}`.
- Dependencies: `oracle` (rust-oracle on ODPI-C; loads the user's Oracle Instant Client at runtime, not bundled), `tiberius` + `tokio-util` compat, `clickhouse` crate (HTTP), `duckdb` crate with `bundled` feature (adds build time and ~20 MB to the binary).
- docker-compose: mcr.microsoft.com/mssql/server:2022, gvenzl/oracle-free (Oracle Database 23ai Free), clickhouse/clickhouse-server.
