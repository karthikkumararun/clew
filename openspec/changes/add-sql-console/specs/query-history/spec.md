## ADDED Requirements

### Requirement: Record executed statements
The system SHALL record every statement executed from a console with: connection id, database, statement text, start time, duration, rows returned or affected, and outcome (ok, error, cancelled). History SHALL be stored locally in the app store and never leave the machine.

#### Scenario: Successful run recorded
- **WHEN** the user runs a SELECT that returns 50 rows in 38 ms
- **THEN** a history entry with that text, "50 rows", "38 ms" and "ok" is stored

#### Scenario: Retention
- **WHEN** history exceeds 10,000 entries for a connection
- **THEN** the oldest entries beyond 10,000 are deleted

### Requirement: Browse and search history
The History tab of the results panel SHALL list the current connection's history newest first, with a search field (substring over the statement text), outcome icon, relative time, duration and row count. Selecting an entry SHALL show the full text; actions SHALL include Insert into editor, Open in new console and Copy.

#### Scenario: Search
- **WHEN** the user types "orders" in the history search
- **THEN** only entries whose text contains "orders" (case-insensitive) are listed

#### Scenario: Re-run from history
- **WHEN** the user chooses Open in new console on an entry
- **THEN** a new console for the same connection opens with that text, without running it

### Requirement: Clear history
The user SHALL be able to clear history for one connection or for all connections, after confirmation.

#### Scenario: Clear one connection
- **WHEN** the user clears history for `prod-postgres`
- **THEN** only that connection's entries are deleted
