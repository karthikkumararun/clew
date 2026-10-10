## ADDED Requirements

### Requirement: Connection model
A connection SHALL have: a stable id, name, driver id, group, environment (`local`, `development`, `staging`, `production`), driver settings (host, port, database, user for network drivers; file path for file drivers; URI for MongoDB; host, port, db index for Redis), password-storage mode (`keychain`, `ask`, `none`), optional SSH tunnel, TLS settings, advanced settings (connect timeout, query timeout, keep-alive, statements to run on connect, driver properties) and safeguard flags (read-only by default, confirm writes, manual commit).

#### Scenario: Defaults by environment
- **WHEN** the user creates a connection with environment Production
- **THEN** the safeguard flags default to read-only by default, confirm writes and manual commit, all on

#### Scenario: Defaults for other environments
- **WHEN** the user creates a connection with environment Local
- **THEN** all safeguard flags default to off

### Requirement: Persist connections without secrets
The system SHALL save connections to `connections.json` in the platform app-data directory and SHALL never write passwords, SSH passphrases or tokens to that file or to logs. Secrets SHALL be stored in the OS keychain under service `Clew` and account `<connection-id>:<secret-kind>`.

#### Scenario: Save with password
- **WHEN** the user saves a connection with "Save password: In system keychain"
- **THEN** `connections.json` contains the connection without the password, and the keychain contains it

#### Scenario: Ask every time
- **WHEN** the password mode is "Ask every time" and the user connects
- **THEN** a password prompt appears; the password is held in memory for the session only

#### Scenario: Keychain unavailable
- **WHEN** the keychain cannot be accessed (locked or denied)
- **THEN** the save succeeds without the password, and the user sees "Couldn't save the password to the keychain — you'll be asked when connecting"

#### Scenario: Concurrent edits
- **WHEN** `connections.json` changed on disk since it was loaded (e.g. edited by hand)
- **THEN** the system reloads it before writing and does not lose either change to other connections

### Requirement: Connection dialog
The system SHALL provide a New/Edit connection dialog matching `design/canvas/ConnectionDialog.dc.html`: a searchable driver list grouped SQL / NoSQL, Name and Group, Environment chips, tabs General / SSH tunnel / SSL / Advanced, a read-only URL preview with Copy, Test connection, Cancel and Save & connect. The General tab SHALL show the form for the selected driver's form kind.

#### Scenario: Switch driver
- **WHEN** the user selects MySQL after PostgreSQL in the driver list
- **THEN** the port changes from 5432 to 3306 unless the user had edited it, and the URL preview updates

#### Scenario: File driver form
- **WHEN** the user selects SQLite
- **THEN** the General tab shows a database-file field with a Choose… button and "Create the file if it doesn't exist", and no host or port fields

#### Scenario: Name suggestion
- **WHEN** the user has not typed a name
- **THEN** the name field suggests `<environment>-<driver>` (e.g. `prod-postgres`) and follows driver and environment changes until edited

#### Scenario: Production safeguards box
- **WHEN** the environment is Production
- **THEN** a red "Production safeguards" box shows the three safeguard checkboxes, checked

#### Scenario: Validation
- **WHEN** the user presses Save with an empty host or a port outside 1–65535
- **THEN** the field is marked invalid with a message and nothing is saved

#### Scenario: Keyboard
- **WHEN** the dialog is open
- **THEN** Esc cancels, Mod+Enter saves, and Tab moves through every control in order

### Requirement: Test connection from the dialog
The dialog SHALL test the current, unsaved settings and show the result inline next to the button.

#### Scenario: Success
- **WHEN** the test succeeds
- **THEN** the dialog shows a green check with "Connected · <server version> · <ms> ms" (plus "via <ssh host>" when tunnelled)

#### Scenario: Failure
- **WHEN** the test fails
- **THEN** the dialog shows the error message in `--danger` with a "Details" toggle for the full driver error, and the dialog stays open

#### Scenario: Cancel a slow test
- **WHEN** a test is still running after 2 seconds
- **THEN** the button turns into "Cancel test" and pressing it aborts the attempt

### Requirement: Paste a connection URL
The system SHALL parse connection URLs (`postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `sqlserver://`, `clickhouse://`, `sqlite:`, `duckdb:`, `mongodb://`, `mongodb+srv://`, `redis://`, `rediss://`) into a prefilled connection dialog for the user to confirm.

#### Scenario: Postgres URL with password
- **WHEN** the user pastes `postgres://karthik:secret@db.internal:5432/analytics?sslmode=require` on the Welcome screen and presses Connect
- **THEN** the connection dialog opens with driver PostgreSQL, host, port, user, database and TLS mode filled, the password in the password field (not saved until the user saves), and environment Local

#### Scenario: Unrecognised URL
- **WHEN** the scheme is not recognised
- **THEN** the field shows "Clew doesn't recognise this URL scheme" and nothing opens

### Requirement: Organise connections
The system SHALL let the user rename, duplicate, delete (with confirmation), change environment and move connections between groups, and create, rename and delete groups (deleting a group moves its connections to "Ungrouped").

#### Scenario: Delete
- **WHEN** the user deletes a connection and confirms
- **THEN** it disappears from the explorer and `connections.json`, its keychain secrets are removed, and any open tabs for it close after asking about unsaved changes

#### Scenario: Duplicate
- **WHEN** the user duplicates `prod-postgres`
- **THEN** a new connection `prod-postgres (copy)` with a new id and copied secrets opens in the edit dialog

### Requirement: Connect and disconnect
The system SHALL connect a saved connection on demand (double-click in explorer, opening a console, running a query) and SHALL let the user disconnect it, closing all its sessions and its SSH tunnel.

#### Scenario: Disconnect with an open transaction
- **WHEN** the user disconnects while a console has an uncommitted transaction
- **THEN** the system asks "Commit", "Roll back" or "Cancel" first

### Requirement: Toolbar connection chip
The main toolbar SHALL show the active tab's connection as a chip: environment dot, driver badge, connection name, database and schema, with a menu to switch the active tab's database or schema.

#### Scenario: Switch schema
- **WHEN** the user picks schema `billing` from the chip menu in a PostgreSQL console
- **THEN** the console's session runs `SET search_path` accordingly and the chip shows `billing`

### Requirement: Recent connections
The Welcome screen SHALL list up to 5 most recently used connections with environment bar, driver badge, name, a short address (host:port/db, file path, or "localhost:6379 · db 0") and relative last-used time. Selecting one connects and opens a console.

#### Scenario: Open recent
- **WHEN** the user clicks `dev-mongo` in Recent
- **THEN** the app connects and opens a console tab for it

### Requirement: Import connections
The system SHALL import connections from: DataGrip (`dataSources.xml` + `dataSources.local.xml` of a project), DBeaver (`data-sources.json`), `~/.pgpass`, and Clew's own export file. Imported connections SHALL be shown in a preview list with checkboxes before anything is saved; duplicates (same driver, host, port, database, user) SHALL be flagged.

#### Scenario: Import from DBeaver
- **WHEN** the user picks a DBeaver `data-sources.json` with 4 connections
- **THEN** a preview lists 4 connections with detected drivers; importing the checked ones adds them to an "Imported" group without passwords

#### Scenario: Unsupported driver in import
- **WHEN** an imported entry uses a driver Clew doesn't have (e.g. Oracle)
- **THEN** it is listed, unchecked and disabled, with "Driver not available"

### Requirement: Export connections
The system SHALL export selected connections to a JSON file that contains no secrets.

#### Scenario: Share with a friend
- **WHEN** the user exports two connections
- **THEN** the file contains their settings without passwords and can be imported on another machine
