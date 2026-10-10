## ADDED Requirements

### Requirement: Oracle driver
The system SHALL include an Oracle Database driver (19c and later, including 21c, 23ai and Autonomous Database via wallet) with default port 1521 and dialect `oracle`. It SHALL connect by service name, SID, TNS alias (from `tnsnames.ora` in `TNS_ADMIN`) or Easy Connect string, with an optional role (SYSDBA, SYSOPER) and wallet folder. It SHALL support streaming results, cancellation via an OCI break, paging via `OFFSET … FETCH`, PL/SQL blocks terminated by a `/` line in script mode, DBMS_OUTPUT capture into the Output tab, introspection of schemas (users) → tables, views, materialized views, sequences, synonyms, packages, procedures, functions, with columns, constraints and indexes, and DDL via `DBMS_METADATA.GET_DDL`.

#### Scenario: Instant Client missing
- **WHEN** the user selects Oracle and no Oracle Instant Client (19+) can be found in the standard locations, `ORACLE_HOME`, or the path set in Settings
- **THEN** the dialog shows "Oracle needs the free Oracle Instant Client" with a download link, the per-OS install steps and a "Choose folder…" button, and Test connection is disabled until it is found

#### Scenario: PL/SQL block in a script
- **WHEN** a script contains a `BEGIN … END;` block followed by a line with only `/`
- **THEN** the block runs as one statement and the next statement starts after the `/`

#### Scenario: DBMS_OUTPUT
- **WHEN** a block calls `DBMS_OUTPUT.PUT_LINE('done')`
- **THEN** "done" appears in the Output tab after the block finishes

#### Scenario: Large objects
- **WHEN** a CLOB or BLOB value is larger than 64 KB
- **THEN** it arrives truncated with the `truncated` flag and the full value is fetched on demand

#### Scenario: Read-only session
- **WHEN** an Oracle connection is read-only by default
- **THEN** every transaction starts with `SET TRANSACTION READ ONLY` and Clew's guard blocks writes, since Oracle has no session-wide read-only mode

#### Scenario: Editing without a primary key
- **WHEN** an edited table has no primary or unique key
- **THEN** rows are addressed by ROWID for UPDATE and DELETE

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
