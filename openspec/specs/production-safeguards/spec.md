# production-safeguards Specification

## Purpose
TBD - created by archiving change add-production-safeguards. Update Purpose after archive.
## Requirements
### Requirement: Statement classification
Before executing anything, the system SHALL classify each statement as `read` (SELECT, SHOW, EXPLAIN without ANALYZE, WITH … SELECT), `write` (INSERT, UPDATE, DELETE, MERGE, COPY FROM, data-modifying CTEs), `ddl` (CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE) or `unknown` (anything else, including procedure calls), per dialect. `unknown` SHALL be treated as `write`.

#### Scenario: Data-modifying CTE
- **WHEN** the statement is `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`
- **THEN** it is classified `write`

#### Scenario: Procedure call
- **WHEN** the statement is `CALL refresh_stats()`
- **THEN** it is classified `unknown` and treated as a write

### Requirement: Read-only sessions
When a connection has "read-only by default", every new session SHALL start read-only: the UI SHALL refuse `write`, `ddl` and `unknown` statements with "This session is read-only" and an inline "Switch to read-write" action, and the session SHALL also be set read-only at the database level where the driver supports it. Table-editor editing controls SHALL be disabled with the reason shown.

#### Scenario: Write in a read-only console
- **WHEN** the user runs an UPDATE on a read-only production session
- **THEN** nothing is sent to the database and Output shows "Blocked: this session is read-only"

#### Scenario: Database-level enforcement
- **WHEN** a statement misclassified as read tries to write on a read-only PostgreSQL session
- **THEN** the database rejects it because the session is `READ ONLY`

### Requirement: Session read-write toggle
The toolbar SHALL show the production badge "PRODUCTION · READ-ONLY" for read-only production sessions. Clicking it SHALL offer "Switch this session to read-write", which requires confirmation, changes the badge to "PRODUCTION · READ-WRITE" (stronger red), applies to the active tab's session only and resets when the session closes.

#### Scenario: Toggle
- **WHEN** the user confirms switching to read-write
- **THEN** only the active console's session becomes read-write and other tabs stay read-only

### Requirement: Confirm writes
When "confirm writes" is on, executing any `write`, `ddl` or `unknown` statement (from a console, the table editor's Submit, or an AI-inserted statement) SHALL show a confirmation dialog listing the connection (with environment), the statements, and for UPDATE/DELETE an estimated affected-row count when it can be obtained cheaply (EXPLAIN estimate). Confirm SHALL be the non-default button; Enter cancels.

#### Scenario: Confirm a write
- **WHEN** the user runs `UPDATE orders SET status = 'shipped' WHERE id = 88213` on a production read-write session
- **THEN** the confirm dialog shows `prod-postgres · Production`, the statement and "≈1 row", and the statement runs only after Confirm

### Requirement: Dangerous statements
On production connections the system SHALL block UPDATE or DELETE without a WHERE clause, TRUNCATE, and DROP (database, schema, table) unless the user types the connection name into a confirmation field. On other environments these SHALL show a warning confirmation instead.

#### Scenario: DELETE without WHERE on production
- **WHEN** the user runs `DELETE FROM orders` on production
- **THEN** a dialog requires typing `prod-postgres` before Run is enabled

#### Scenario: Same statement on local
- **WHEN** the user runs `DELETE FROM orders` on a local connection
- **THEN** a warning dialog asks "Delete every row in orders?" with Cancel as default

### Requirement: Manual commit
When "manual commit" is on, consoles for that connection SHALL start in Manual transaction mode, and closing a tab, disconnecting or quitting with an open transaction SHALL require an explicit Commit or Roll back.

#### Scenario: Quit with open transaction
- **WHEN** the user quits Clew with an open production transaction
- **THEN** quitting pauses and asks Commit / Roll back / Cancel for that console

### Requirement: Production visibility
Every surface bound to a production connection SHALL be visibly marked: red env dot in the tree and chips, 2px red top stripe on its editor tabs, the toolbar badge, and a red-tinted connection segment in the status bar.

#### Scenario: Two windows of the same data
- **WHEN** a production console and a staging console are open side by side in tabs
- **THEN** their tabs carry red and amber stripes respectively
