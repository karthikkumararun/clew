## ADDED Requirements

### Requirement: Connection model
A connection SHALL have: a stable id, name, driver id, group, environment (`local`, `development`, `staging`, `production`), driver settings (host, port, database, user for network drivers; host, port, connect-by (service name / SID / TNS alias / Easy Connect), user, role and wallet folder for Oracle; file path for file drivers; URI for MongoDB; host, port, db index for Redis; protocol, host, port, user and database for Neo4j), password-storage mode (`keychain`, `ask`, `none`), optional SSH tunnel, TLS settings, advanced settings (connect timeout, query timeout, keep-alive, statements to run on connect, driver properties) and safeguard flags (read-only by default, confirm writes, manual commit).

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

#### Scenario: Oracle form
- **WHEN** the user selects Oracle
- **THEN** the General tab shows host, port 1521, a "Connect by" select (Service name, SID, TNS alias, Easy Connect string) with the matching field, user, password, role, an optional wallet folder, and the Oracle Instant Client status

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
The system SHALL parse connection URLs (`postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `sqlserver://`, `oracle://`, `clickhouse://`, `sqlite:`, `duckdb:`, `mongodb://`, `mongodb+srv://`, `redis://`, `rediss://`, `neo4j://`, `neo4j+s://`, `bolt://`, `bolt+s://`) into a prefilled connection dialog for the user to confirm.

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

### Requirement: Export connections
The system SHALL export selected connections (with their groups and environments) from the Export tab of the Connections dialog (`design/canvas/ImportExport.dc.html`). The user SHALL choose whether to include saved passwords (database passwords and SSH passphrases), SSH private key files referenced by the connections, and SQL files linked to the connections. When any secret or key is included, the file SHALL be encrypted with a passphrase the user enters twice (minimum 12 characters, with a strength meter), using AES-256-GCM with a key derived by Argon2id; otherwise the file SHALL be plain JSON. The passphrase SHALL never be stored.

#### Scenario: Export with passwords and an SSH key
- **WHEN** the user exports `prod-postgres`, `prod-replica` and `staging-mysql` with passwords and SSH keys included and a passphrase
- **THEN** a `.clew` file is written whose contents (settings, passwords, the `~/.ssh/id_ed25519` key and linked SQL files) are unreadable without the passphrase, and only a small unencrypted header (format, version, KDF parameters, creation date, counts) is visible

#### Scenario: Export without secrets
- **WHEN** the user exports with neither passwords nor SSH keys included
- **THEN** a readable `.json` file is written that contains no secret, and the dialog says the importer will be asked for passwords when connecting

#### Scenario: Weak or mismatched passphrase
- **WHEN** the passphrase is shorter than 12 characters or the confirmation doesn't match
- **THEN** Export stays disabled and the field explains why

#### Scenario: Keychain access denied during export
- **WHEN** a password can't be read from the keychain
- **THEN** that connection is exported without its password and the summary lists it as "password not included"

#### Scenario: Missing SSH key file
- **WHEN** a connection's key file no longer exists on disk
- **THEN** the export continues without it and the summary warns "1 SSH key not found"

### Requirement: Import a Clew export
The Import tab SHALL accept `.clew` and `.json` files produced by Export. For encrypted files the user SHALL enter the passphrase to unlock; then the contents SHALL be listed for review (connections with New / Duplicate status, counts of passwords, keys and SQL files) before anything is saved. Imported passwords SHALL go to the OS keychain; imported SSH private keys SHALL be written to Clew's key folder (`<app_data>/ssh-keys/`) readable only by the current user (0600 on macOS; owner-only ACL on Windows), and the connections SHALL point to them.

#### Scenario: Wrong passphrase
- **WHEN** the user enters a wrong passphrase
- **THEN** the dialog shows "That passphrase doesn't unlock this file" and nothing is imported

#### Scenario: Tampered file
- **WHEN** the encrypted payload or header has been modified
- **THEN** authentication fails and the dialog shows "This file is damaged or was changed after export"

#### Scenario: Duplicate connection
- **WHEN** an imported connection matches an existing one (same driver, host, port, database, user)
- **THEN** it is unchecked by default with "Already in Clew"; if checked it is added as a new connection with a suffixed name, never overwriting the existing one

#### Scenario: Newer format
- **WHEN** the file's format version is newer than this Clew understands
- **THEN** the dialog says which Clew version is needed and imports nothing

### Requirement: Import from DataGrip
The Import tab SHALL import from DataGrip: it SHALL detect installed DataGrip configuration folders (all versions; macOS `~/Library/Application Support/JetBrains/DataGrip*`, Windows `%APPDATA%\JetBrains\DataGrip*`) for global data sources (`options/dataSources.xml` + `dataSources.local.xml`), and accept project folders (`.idea/dataSources.xml` + `dataSources.local.xml`). Each data source SHALL be listed with driver badge, name, address, number of SQL files and status (New, Already in Clew, Driver not available). Options SHALL include: import SQL consoles and scratch files, try to import saved passwords, environment for imported connections (detect from name, or a fixed environment) and target group (one "Imported from DataGrip" group, or keep DataGrip folders as groups).

#### Scenario: Detect DataGrip
- **WHEN** the user picks DataGrip as the source on a Mac with DataGrip 2026.2 and 2025.3 installed
- **THEN** the dialog lists both configuration folders, newest first, and shows the data sources of the selected one

#### Scenario: Map drivers and settings
- **WHEN** a data source uses the JDBC URL `jdbc:postgresql://db.internal:5432/analytics` with an SSH tunnel and SSL settings
- **THEN** the imported connection is PostgreSQL with host, port, database, user, the SSH tunnel (host, port, user, auth type, key file path) and TLS mode carried over

#### Scenario: Oracle data source
- **WHEN** a data source uses `jdbc:oracle:thin:@ora.internal:1521/REPORTS`
- **THEN** it imports as Oracle with connect-by Service name `REPORTS`

#### Scenario: Unsupported driver
- **WHEN** a data source uses a driver Clew doesn't have (e.g. Cassandra)
- **THEN** it is listed, unchecked and disabled, with "Driver not available"

#### Scenario: Environment from name
- **WHEN** "Detect from name" is selected and a data source is named `analytics-prod`
- **THEN** it imports with environment Production (and its safeguard defaults); names containing `stag` map to Staging, `dev` to Development, otherwise Local

#### Scenario: Passwords from DataGrip
- **WHEN** "Try to import saved passwords" is checked on macOS
- **THEN** Clew reads each data source's password from DataGrip's keychain entry (macOS asks the user to allow access once per entry) and stores it in Clew's own keychain entry; entries that can't be read are skipped and listed as "password not imported"

#### Scenario: Passwords on Windows
- **WHEN** the user imports from DataGrip on Windows
- **THEN** the password option is shown disabled with "Not available on Windows yet — you'll be asked when connecting"

### Requirement: Import SQL files from DataGrip
When "Import SQL consoles and scratch files" is checked, the system SHALL copy each imported data source's query consoles (from DataGrip's `consoles/db/<data-source-id>/` folder) into `~/Documents/Clew/Scripts/<connection name>/` and link them to the new connection, and SHALL copy DataGrip scratch files (`scratches/*.sql`) into `~/Documents/Clew/Scripts/Scratches/` unlinked. Original files SHALL never be modified or moved.

#### Scenario: Consoles follow their connection
- **WHEN** `analytics-prod` has 4 consoles in DataGrip and is imported
- **THEN** 4 `.sql` files appear under `analytics-prod` in the explorer's Scripts node, and opening one opens a console bound to `analytics-prod`

#### Scenario: Merge into an existing connection
- **WHEN** a data source is "Already in Clew" and its row is set to "merge SQL files only"
- **THEN** its consoles are linked to the existing Clew connection and no new connection is created

#### Scenario: Name collision
- **WHEN** a file with the same name already exists in the target folder
- **THEN** the imported file is saved with a numeric suffix and nothing is overwritten

### Requirement: Import from DBeaver and pgpass
The Import tab SHALL also import DBeaver connections (`data-sources.json` of a workspace, without passwords) and `~/.pgpass` lines (one PostgreSQL connection per non-wildcard line; passwords go to the keychain only if the user ticks "Import passwords"). Imported entries SHALL be reviewed in the same list before saving.

#### Scenario: Import from DBeaver
- **WHEN** the user picks a DBeaver `data-sources.json` with 4 connections
- **THEN** a preview lists 4 connections with detected drivers; importing the checked ones adds them to an "Imported" group without passwords

### Requirement: Connection scripts
Each connection SHALL have a Scripts folder (default `~/Documents/Clew/Scripts/<connection name>/`, changeable per connection) for SQL files linked to it. Files saved from a console of that connection SHALL default to this folder, and linked files SHALL open in a console bound to the connection.

#### Scenario: Save a console
- **WHEN** the user saves a new console for `staging-mysql`
- **THEN** the save dialog starts in `~/Documents/Clew/Scripts/staging-mysql/`

#### Scenario: Rename a connection
- **WHEN** a connection is renamed
- **THEN** its links are kept; the folder is renamed only if the user agrees
