## ADDED Requirements

### Requirement: Driver registry
The system SHALL keep a registry of available drivers. Each driver SHALL declare: id, display name, 2-letter badge, color token, family (`sql`, `document` or `keyvalue`), default port (if any), connection-form kind (`network`, `file`, `uri` or `keyvalue`), SQL dialect (for `sql` drivers) and capability flags (`transactions`, `cancel`, `explain`, `editable_results`, `schemas`, `multiple_databases`).

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

### Requirement: SQLite driver
The system SHALL include a SQLite driver for local database files supporting execution, cancellation (interrupt), introspection (main + attached databases), editing and EXPLAIN QUERY PLAN.

#### Scenario: Missing file
- **WHEN** a SQLite connection points to a file that does not exist and "create if missing" is off
- **THEN** opening fails with code `file_not_found`

#### Scenario: Locked database
- **WHEN** another process holds a write lock longer than the busy timeout (5s)
- **THEN** the write fails with code `database_locked`
