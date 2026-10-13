## ADDED Requirements

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
