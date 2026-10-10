## Why

With the driver contract proven on PostgreSQL and SQLite, the remaining SQL databases in the connection dialog (MySQL, MariaDB, SQL Server, ClickHouse, DuckDB) can be added behind the same contract and pass the same conformance suite, with no UI changes.

## What Changes

- Add drivers: MySQL 8+, MariaDB 10.6+, SQL Server 2019+, ClickHouse 23+, DuckDB 1.x.
- Each implements execution with streaming, cancel, the value model, introspection, completion snapshot, DDL generation, editing support (PK detection, DML quoting/paging) and database-level read-only where available.
- Extend the conformance suite and docker-compose with these databases.

Canvas: the SQL section of the driver list in `design/canvas/ConnectionDialog.dc.html` (badges MY, MA, MS, CH, DK).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `driver-framework`: adds requirements for the MySQL, MariaDB, SQL Server, ClickHouse and DuckDB drivers (new requirements only, existing ones unchanged).

## Impact

- Rust: `src-tauri/src/drivers/{mysql/,mssql/,clickhouse/,duckdb/}` (MariaDB shares the MySQL module with a flavor flag).
- Dependencies: sqlx `mysql`, `tiberius` + `tokio-util` compat, `clickhouse` crate (HTTP), `duckdb` crate with `bundled` feature (adds build time and ~20 MB to the binary).
- docker-compose: mysql:8, mariadb:11, mcr.microsoft.com/mssql/server:2022, clickhouse/clickhouse-server.
