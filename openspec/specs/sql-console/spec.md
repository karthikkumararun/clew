# sql-console Specification

## Purpose
TBD - created by archiving change add-sql-console. Update Purpose after archive.
## Requirements
### Requirement: Console tabs
The system SHALL open SQL consoles as editor tabs bound to one connection and its own session. The tab title SHALL read "console" with the connection name as subtitle (or the file name for a saved file), and show the environment stripe.

#### Scenario: New console
- **WHEN** the user presses Mod+T with a connection selected in the explorer (or active in the current tab)
- **THEN** a new console tab opens for that connection, focused in the editor

#### Scenario: No connection chosen
- **WHEN** the user presses Mod+T with no connection in context
- **THEN** a connection picker opens first

### Requirement: SQL editor
The editor SHALL use the connection's SQL dialect for highlighting (keywords `--syn-keyword`, functions `--syn-function`, strings `--syn-string`, numbers `--syn-number`, comments `--syn-comment`), show line numbers in a 56px gutter, tint the statement under the cursor with `--bg-current-statement`, and mark its first line with a ▶ run marker in the accent color that runs the statement when clicked. It SHALL support multi-cursor, bracket matching, Mod+/ comment toggle, Mod+F find/replace, Mod+Shift+F format SQL and the font size from Settings.

#### Scenario: Current statement detection
- **WHEN** the cursor is on line 7 of a 13-line SELECT that ends with `;`
- **THEN** lines 2–13 are tinted and the ▶ marker sits on line 2

#### Scenario: Statements without semicolons
- **WHEN** two statements are separated by a blank line and no semicolon
- **THEN** each is detected as its own statement

### Requirement: Schema-aware completion
The editor SHALL complete keywords, schemas, tables, views, columns (with type on the right), table aliases declared in the statement, and functions (with signature), using the connection's completion snapshot. The popup SHALL match the canvas: icon, name, dim signature, right-aligned kind/type, footer hint "↵ insert · ⇥ replace · ⌃Space more".

#### Scenario: Alias columns
- **WHEN** the statement has `FROM orders o` and the user types `o.`
- **THEN** the popup lists the columns of `orders` with their types

#### Scenario: Snapshot not loaded yet
- **WHEN** the snapshot is still loading
- **THEN** keyword completion works and schema items appear once the snapshot arrives, without the user retyping

#### Scenario: Stale schema
- **WHEN** the user creates a table in the console
- **THEN** the snapshot refreshes after the DDL statement succeeds

### Requirement: Run modes
The console SHALL run: the current statement (Mod+Enter or the toolbar Run button), the selection when text is selected (Mod+Enter), and the whole script (Mod+Shift+Enter). Running SHALL show a spinner and elapsed timer on the Result tab and turn Run into Cancel.

#### Scenario: Run current statement
- **WHEN** the user presses Mod+Enter with the cursor inside the SELECT
- **THEN** only that statement runs and its rows appear in the Result tab with "<n> rows · <ms> ms"

#### Scenario: Run script with several results
- **WHEN** a script produces three result sets
- **THEN** the Result tab shows three sub-tabs "Result 1…3", and the Output log lists every statement with its timing

#### Scenario: Cancel
- **WHEN** the user presses Mod+. or Esc (with focus in the console) while a query runs
- **THEN** the query is cancelled and Output shows "Cancelled after <s> s"

#### Scenario: Run while another query runs
- **WHEN** the user runs again while the session is busy
- **THEN** the system asks to cancel the running query first

### Requirement: Results panel
Below the editor, separated by a draggable splitter (height remembered per tab), the console SHALL show a results panel with tabs Result, Output, Explain plan and History, plus a toolbar with the row range ("1–50 of 50"), re-run, filter, transpose, and Export.

#### Scenario: Fetch more rows on scroll
- **WHEN** the user scrolls to the end of a result that has more rows
- **THEN** the next page loads and the range updates (e.g. "1–1,000 of 1,000+")

#### Scenario: Statement without rows
- **WHEN** the statement returns no result set
- **THEN** the Output tab is shown with "<n> rows affected · <ms> ms"

### Requirement: Errors in the editor
When a statement fails, the system SHALL switch to the Output tab, show the error in `--danger` with any hint and position, and underline the error position in the editor with a red squiggle that shows the message on hover.

#### Scenario: Unknown column
- **WHEN** PostgreSQL reports `column o.carrier does not exist` at position 17
- **THEN** Output shows the message and hint, and `o.carrier` is underlined in the editor

### Requirement: Explain plan
The console SHALL show the execution plan of the current statement (toolbar Explain, Mod+Shift+E) in the Explain plan tab as an indented tree with node type, relation, estimated rows and cost; ANALYZE SHALL be a separate, explicit option because it executes the statement.

#### Scenario: Explain analyze on a write
- **WHEN** the user chooses Explain Analyze on an UPDATE
- **THEN** the system warns that the statement will be executed (inside a transaction that is rolled back) and asks for confirmation

### Requirement: Transaction mode
Each console SHALL have a transaction mode, Auto-commit or Manual, shown in the toolbar ("Tx: Auto-commit ▾"). In Manual mode the first statement opens a transaction; the toolbar SHALL show Commit and Rollback buttons and a pending indicator with the count of statements in the transaction.

#### Scenario: Close with an open transaction
- **WHEN** the user closes a console with an uncommitted transaction
- **THEN** the system asks Commit / Roll back / Cancel

### Requirement: SQL files
The console SHALL open and save `.sql` files (Mod+O open file, Mod+S save, Mod+Shift+S save as). A console bound to a file SHALL show the file name as its title and a dirty dot when changed; unsaved console text SHALL still be restored after a restart.

#### Scenario: File changed on disk
- **WHEN** an open file changes on disk and the tab has no unsaved edits
- **THEN** the tab reloads it; if it has unsaved edits, the user is asked which version to keep

### Requirement: Status bar items
While a console is active, the status bar SHALL show the cursor position ("Ln 7, Col 34"), "UTF-8", the dialect ("SQL · PostgreSQL dialect") and the session's transaction state.

#### Scenario: Cursor moves
- **WHEN** the cursor moves
- **THEN** the Ln/Col item updates
