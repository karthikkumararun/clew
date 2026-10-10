## ADDED Requirements

### Requirement: MySQL and MariaDB drivers
The system SHALL include MySQL (8.0+) and MariaDB (10.6+) drivers with default port 3306, dialects `mysql` / `mariadb`, streaming results, cancellation via `KILL QUERY <connection id>` on a separate connection, introspection (databases as the top level, tables, views, routines, triggers, columns, keys, indexes), DDL via `SHOW CREATE`, and session read-only via `SET SESSION TRANSACTION READ ONLY`.

#### Scenario: Cancel a long query
- **WHEN** the user cancels `SELECT SLEEP(60)` on MySQL
- **THEN** the query stops within 2 seconds and the session stays usable

#### Scenario: Zero dates
- **WHEN** a DATETIME column contains `0000-00-00 00:00:00`
- **THEN** the value arrives as `other` with that text, not as an error

### Requirement: SQL Server driver
The system SHALL include a SQL Server (2019+) driver with default port 1433, dialect `tsql`, SQL and Windows-integrated (NTLM on Windows) authentication, `GO` batch separators in script mode, paging via `OFFSET … FETCH`, cancellation via TDS attention, and introspection of databases, schemas, tables, views, procedures and functions.

#### Scenario: GO separators
- **WHEN** a script contains `GO` lines
- **THEN** each batch between them runs separately

#### Scenario: No session read-only
- **WHEN** a SQL Server connection is read-only by default
- **THEN** writes are blocked by Clew's guard, and the connection dialog notes that SQL Server has no session-level read-only

### Requirement: ClickHouse driver
The system SHALL include a ClickHouse (23+) driver over HTTP(S) with default port 8123 (8443 for TLS), dialect `clickhouse`, streaming via `FORMAT RowBinaryWithNamesAndTypes`, cancellation via `KILL QUERY WHERE query_id`, introspection of databases, tables (with engine) and columns, and read-only via the `readonly=1` setting. Results SHALL be read-only in the grid (no row-level editing).

#### Scenario: Engine shown
- **WHEN** the user expands tables in a ClickHouse database
- **THEN** each table shows its engine (e.g. MergeTree) as the detail

### Requirement: DuckDB driver
The system SHALL include a DuckDB (1.x) driver for local `.duckdb` files and in-memory databases, dialect `duckdb`, with cancellation via interrupt, introspection of catalogs, schemas, tables, views and columns, and read-only mode via `access_mode = READ_ONLY`. Querying files directly (e.g. `SELECT * FROM 'data.parquet'`) SHALL work.

#### Scenario: Query a Parquet file
- **WHEN** the user runs `SELECT * FROM '~/data/events.parquet' LIMIT 100` in a DuckDB console
- **THEN** the rows appear in the grid

### Requirement: Conformance across SQL drivers
Every SQL driver SHALL pass the shared conformance suite (test, execute, stream, page, cancel, timeout, value round-trip, introspection, completion snapshot, editing DML where supported).

#### Scenario: CI runs the suite
- **WHEN** CI runs the integration job
- **THEN** each driver's conformance tests run against its docker-compose service and all pass
