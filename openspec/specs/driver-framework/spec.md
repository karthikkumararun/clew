# driver-framework Specification

## Purpose
TBD - created by archiving change add-driver-framework. Update Purpose after archive.
## Requirements
### Requirement: Driver registry
The system SHALL keep a registry of available drivers. Each driver SHALL declare: id, display name, 2-letter badge, color token, family (`sql`, `document`, `keyvalue` or `graph`), default port (if any), connection-form kind (`network`, `file`, `uri` or `keyvalue`), SQL dialect (for `sql` drivers) and capability flags (`transactions`, `cancel`, `explain`, `editable_results`, `schemas`, `multiple_databases`).

#### Scenario: List drivers
- **WHEN** the frontend requests the driver list
- **THEN** it receives every registered driver with its metadata, grouped by family, PostgreSQL and SQLite included

#### Scenario: Unknown driver in a saved connection
- **WHEN** a saved connection names a driver id the registry does not know
- **THEN** opening it fails with error code `driver_unavailable` and the message names the missing driver

### Requirement: Test a connection
The system SHALL connect with a given configuration, run a trivial round-trip, report the server product and version and the round-trip time, then disconnect, all without saving anything.

#### Scenario: Successful test
- **WHEN** the user tests a valid PostgreSQL configuration
- **THEN** the result is `ok` with `PostgreSQL 16.x` and the elapsed milliseconds

#### Scenario: Wrong password
- **WHEN** the server rejects the credentials
- **THEN** the result is an error with code `auth_failed` and the server's message, and the password is not echoed

#### Scenario: Host unreachable
- **WHEN** the host does not answer within the connect timeout (default 10s)
- **THEN** the result is an error with code `timeout` naming the host and port

### Requirement: Sessions
The system SHALL open a dedicated session (one physical connection) per editor tab that runs queries, and a separate shared pool (max 3 connections) per connection for metadata and introspection. A session SHALL keep its transaction state and session settings until it is closed.

#### Scenario: Transaction spans statements
- **WHEN** the user runs `BEGIN`, then `INSERT …`, then `SELECT …` in the same console tab
- **THEN** all three run on the same physical connection and the SELECT sees the uncommitted insert

#### Scenario: Introspection does not block a running query
- **WHEN** a long query runs in a console and the user expands a table in the explorer
- **THEN** the explorer loads its columns through the metadata pool without waiting for the query

#### Scenario: Lost connection
- **WHEN** the server closes a session's connection
- **THEN** the next execute fails with code `connection_lost`, the session is marked disconnected, and the following execute reconnects automatically (any open transaction is reported as rolled back)

### Requirement: Execute and stream results
The system SHALL execute a statement on a session and stream the results as batches (default 500 rows) over a channel. Each result SHALL carry column metadata (name, database type name, value kind, nullable, and the source table and column when the driver knows them), the rows, and when done: rows affected, elapsed time and whether more rows remain.

#### Scenario: Large result is paged
- **WHEN** a SELECT returns 100,000 rows with a page size of 500
- **THEN** the first 500 rows arrive and the result reports `has_more = true`; further rows arrive only when the frontend asks to fetch more

#### Scenario: Statement without a result set
- **WHEN** the user runs an UPDATE that changes 12 rows
- **THEN** the result has no columns, `rows_affected = 12` and the elapsed time

#### Scenario: Multiple statements
- **WHEN** a script with three statements runs in script mode
- **THEN** the statements run in order and each produces its own result; execution stops at the first error unless "continue on error" was requested

#### Scenario: SQL error with position
- **WHEN** the server reports a syntax error at character 42
- **THEN** the error carries code `query_failed`, the server message, any hint, and position 42 relative to the statement text

### Requirement: Cancel and timeout
The system SHALL cancel a running statement on request using the driver's native mechanism (e.g. `pg_cancel_backend` via a cancel token for PostgreSQL, interrupt for SQLite), and SHALL cancel automatically when an optional per-connection query timeout expires.

#### Scenario: User cancels
- **WHEN** the user cancels a running `SELECT pg_sleep(60)`
- **THEN** the statement stops within 2 seconds, the result is `cancelled`, and the session stays usable

#### Scenario: Timeout
- **WHEN** a connection has a 5s query timeout and a statement runs longer
- **THEN** the statement is cancelled and the result is an error with code `timeout`

### Requirement: Uniform value model
The system SHALL convert database values to a single value model: `null`, `bool`, `int` (i64), `bigint` (as decimal string when beyond i64), `float`, `decimal` (string, exact), `text`, `bytes` (shown as hex, length-limited), `date`, `time`, `timestamp`, `timestamptz` (ISO 8601 strings), `interval`, `uuid`, `json`, `array`, and `other` (the driver's text representation plus its type name). Values SHALL round-trip: a value read and written back unchanged leaves the database unchanged.

#### Scenario: Exact decimals
- **WHEN** a `numeric(30,10)` column holds `12345678901234567890.0123456789`
- **THEN** the value arrives as that exact string and is never converted to a float

#### Scenario: Unsupported type
- **WHEN** a column has a type the driver cannot decode natively (e.g. a PostGIS geometry)
- **THEN** the value arrives as `other` with the server's text form and the type name, and the grid marks it read-only

#### Scenario: Large values
- **WHEN** a text or bytes value is larger than 1 MB
- **THEN** the batch carries the first 64 KB plus a `truncated` flag, and the full value is fetched on demand

### Requirement: Lazy schema introspection
The system SHALL expose the database structure as a tree whose children load on demand: connection → databases → schemas → object groups (tables, views, materialized views, functions, sequences, types) → objects → columns, primary key, foreign keys, indexes. Each node SHALL carry kind, name, an optional detail (e.g. type, row-count estimate) and whether it has children.

#### Scenario: Expand tables
- **WHEN** the frontend requests the children of `analytics.public › tables`
- **THEN** it receives each table with its estimated row count, sorted by name

#### Scenario: Column details
- **WHEN** the frontend requests the children of table `orders`
- **THEN** it receives each column with its type, nullability, default, primary-key flag and foreign-key target (e.g. `users.id`)

#### Scenario: Permission denied on a schema
- **WHEN** the user lacks USAGE on a schema
- **THEN** that schema node is returned with an `access_denied` detail instead of failing the whole request

#### Scenario: Completion snapshot
- **WHEN** the console asks for a completion snapshot of a database
- **THEN** it receives all schemas, tables, views, columns (with types) and functions in one call, cached until the user refreshes

### Requirement: SSH tunnel
For network drivers, the system SHALL optionally connect through an SSH tunnel with host, port, user and one of: SSH agent, private key file (with optional passphrase from the keychain), or password. The tunnel SHALL forward a local ephemeral port to the database host and port.

#### Scenario: Agent auth
- **WHEN** the tunnel uses the SSH agent and the agent holds a matching key
- **THEN** the tunnel opens and the database connection goes through it; the status reports "via SSH <host>"

#### Scenario: Unknown host key
- **WHEN** the bastion's host key is not in `~/.ssh/known_hosts` nor in Clew's own known-hosts file
- **THEN** the connection pauses and the user is shown the key fingerprint to accept or reject; accepting stores it in Clew's known-hosts file

#### Scenario: Changed host key
- **WHEN** the bastion presents a key different from the stored one
- **THEN** the connection fails with code `host_key_mismatch` and nothing is sent

### Requirement: TLS
For network drivers, the system SHALL support TLS modes `disable`, `prefer`, `require`, `verify-ca` and `verify-full`, with an optional CA certificate file and optional client certificate and key, using the OS trust store when no CA file is given.

#### Scenario: verify-full with wrong hostname
- **WHEN** the mode is verify-full and the certificate does not match the host
- **THEN** the connection fails with code `tls_failed` and the message names the mismatch

### Requirement: PostgreSQL driver
The system SHALL include a PostgreSQL driver (versions 12+) supporting all requirements above, the dialect `postgresql`, EXPLAIN (text and JSON), and results that report source table and column for editing.

#### Scenario: Server version in status
- **WHEN** a PostgreSQL session opens
- **THEN** the status bar shows "PostgreSQL <major.minor>"

### Requirement: MySQL and MariaDB drivers
The system SHALL include MySQL (8.0+) and MariaDB (10.6+) drivers with default port 3306, dialects `mysql` / `mariadb`, streaming results, cancellation via `KILL QUERY <connection id>` on a separate connection, introspection (databases as the top level, tables, views, routines, triggers, columns, keys, indexes), DDL via `SHOW CREATE`, and session read-only via `SET SESSION TRANSACTION READ ONLY`.

#### Scenario: Cancel a long query
- **WHEN** the user cancels `SELECT SLEEP(60)` on MySQL
- **THEN** the query stops within 2 seconds and the session stays usable

#### Scenario: Zero dates
- **WHEN** a DATETIME column contains `0000-00-00 00:00:00`
- **THEN** the value arrives as `other` with that text, not as an error

### Requirement: SQLite driver
The system SHALL include a SQLite driver for local database files supporting execution, cancellation (interrupt), introspection (main + attached databases), editing and EXPLAIN QUERY PLAN.

#### Scenario: Missing file
- **WHEN** a SQLite connection points to a file that does not exist and "create if missing" is off
- **THEN** opening fails with code `file_not_found`

#### Scenario: Locked database
- **WHEN** another process holds a write lock longer than the busy timeout (5s)
- **THEN** the write fails with code `database_locked`

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

### Requirement: Document session contract
Drivers of the `document` family SHALL provide: list databases, list collections (with estimated document counts), find (filter, projection, sort, skip, limit) with streaming cursors, aggregate, count, insert, replace, update and delete by `_id`, list/create/drop indexes, and schema inference by sampling.

#### Scenario: Cursor paging
- **WHEN** a find matches 1,936 documents with a page size of 50
- **THEN** the first 50 arrive with `has_more = true`, and fetching more continues the same cursor

### Requirement: Key-value session contract
Drivers of the `keyvalue` family SHALL provide: select logical database, SCAN by pattern with type and TTL (incremental, never `KEYS *`), get/set values per type, set/remove TTL, rename, delete, and execute a raw command returning a typed reply.

#### Scenario: Large keyspace
- **WHEN** a Redis database holds 5 million keys and the user scans `session:*`
- **THEN** results stream in SCAN batches of ~1,000 and the server is never asked for `KEYS`

### Requirement: MongoDB driver
The system SHALL include a MongoDB (5.0+) driver connecting with a `mongodb://` or `mongodb+srv://` URI, auth database and mechanism (SCRAM-SHA-256, X.509, none), TLS and optional SSH tunnel (for non-SRV URIs), converting BSON to Extended JSON (relaxed) for display with types preserved (ObjectId, Date, Decimal128, Int32/Int64, Double, Binary, Timestamp, Regex, MinKey/MaxKey).

#### Scenario: ObjectId display
- **WHEN** a document has `_id: ObjectId("6703f1c2a9e41d7c2e0fb812")`
- **THEN** the value shows as `ObjectId("6703f1c2a9e41d7c2e0fb812")` with type ObjectId, and editing preserves it as an ObjectId

#### Scenario: Server version in status
- **WHEN** a MongoDB session opens on a replica set
- **THEN** the status bar shows "MongoDB <version> · replica set <name>"

### Requirement: Redis driver
The system SHALL include a Redis (6+) driver with host, port, database index, username/password (ACL) or password, TLS (`rediss://`), and support for standalone servers; cluster mode SHALL be detected and reported as unsupported in v1.

#### Scenario: Cluster detected
- **WHEN** the server reports `cluster_enabled:1`
- **THEN** the connection test fails with "Redis Cluster isn't supported yet"

### Requirement: Result column provenance
For SQL drivers, every column of a result SHALL carry, where the driver can know it, the source schema, source table and source column it was read from, and whether the column can be updated through that source (false for computed, aggregated, generated-always and read-only columns). Drivers whose protocol does not report provenance SHALL leave it empty, and Clew SHALL then infer it by analysing the statement (see result-editing › Source detection).

#### Scenario: PostgreSQL reports the table
- **WHEN** a PostgreSQL result column comes straight from `orders.status`
- **THEN** the column metadata names schema `public`, table `orders` and column `status`

#### Scenario: Aliases keep provenance
- **WHEN** a query selects `o.status AS state`
- **THEN** the column is named `state` and its source column is still `status`

#### Scenario: Expressions have no source
- **WHEN** a column is `total * 1.2 AS with_tax`
- **THEN** it has no source table or column and is marked not updatable

#### Scenario: Driver without provenance
- **WHEN** a query runs on a driver that does not report provenance
- **THEN** the columns carry no source and the result editing layer infers it from the statement

### Requirement: Session state and isolation level
SQL sessions SHALL report their transaction state (`idle`, `in_transaction`, `aborted`), an identifier the server knows them by (PostgreSQL backend PID, MySQL and MariaDB connection id, Oracle SID and serial, SQL Server SPID, none for file databases), and SHALL allow setting the transaction isolation level for their next transaction. Each driver SHALL declare the levels it supports: PostgreSQL (read committed, repeatable read, serializable), MySQL and MariaDB (read uncommitted, read committed, repeatable read, serializable), SQL Server (those plus snapshot), Oracle (read committed, serializable), SQLite and DuckDB (none selectable; SQLite reports its fixed behaviour).

#### Scenario: Aborted transaction
- **WHEN** a statement fails inside a PostgreSQL transaction without a savepoint
- **THEN** the session reports `aborted` until it is rolled back

#### Scenario: Set isolation
- **WHEN** the user sets SERIALIZABLE on an idle PostgreSQL session
- **THEN** the next transaction begins with `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`

#### Scenario: Unsupported level
- **WHEN** a driver does not support selecting an isolation level
- **THEN** the selector is hidden for that session and the details pane says why

#### Scenario: Server identifier
- **WHEN** a MySQL session opens
- **THEN** its connection id is available for the details pane and for cancelling with `KILL QUERY`

