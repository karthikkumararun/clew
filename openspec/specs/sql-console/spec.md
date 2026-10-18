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

### Requirement: Auto-refresh
The results toolbar SHALL offer auto-refresh (Off, every 5, 10, 30 seconds, every minute, or a custom interval) which re-runs the result's statement. It SHALL apply only to statements classified as read, SHALL pause while the result has pending changes, the tab is not visible or the window is in the background, and SHALL stop on any error, showing the error in the Output tab. The current setting SHALL show in the toolbar.

#### Scenario: Every 10 seconds
- **WHEN** the user sets Every 10 seconds on a SELECT result
- **THEN** the statement re-runs every 10 seconds and the toolbar shows "Every 10 s"

#### Scenario: Not for writes
- **WHEN** the result came from an UPDATE ... RETURNING statement
- **THEN** auto-refresh is unavailable with "Only read statements can refresh automatically"

#### Scenario: Pending changes
- **WHEN** the result has staged edits and auto-refresh is on
- **THEN** refreshing pauses and the toolbar says "Paused: pending changes"

### Requirement: Result paging
A setting SHALL choose how results of the console are browsed: Scroll (default, rows load as the user scrolls) or Pages. In Pages mode the toolbar shows First, Previous, Next, Last, "<from>–<to>" and a page size choice (100, 500, 1,000, custom), with Mod+Alt+Up and Mod+Alt+Down for previous and next. Pages are windows over the loaded rows; moving forward loads more rows from the open cursor; Last asks for confirmation when it must load more than 100,000 rows.

#### Scenario: Next page
- **WHEN** the user presses Next on page 1 of a 5,000 row result with page size 500
- **THEN** rows 501–1,000 show

#### Scenario: Last page of a large result
- **WHEN** the user presses Last on a result with at least 1,000,000 rows
- **THEN** a confirmation says it will load all rows first

### Requirement: Output tab tools
The Output tab SHALL have a toolbar with soft wrap, auto-scroll to the latest entry, pause output (entries keep arriving but the view stops scrolling), and Clear. Its context menu SHALL offer Copy, Copy statement, and "Compare with clipboard". Entries SHALL show timestamp, statement summary, outcome, duration, rows affected and the transaction mode.

#### Scenario: Clear
- **WHEN** the user presses Clear
- **THEN** the log is emptied for this console and the history is unaffected

### Requirement: Plan tab details
The Plan tab SHALL offer Copy original plan (the plan in the database's own format: text, JSON or XML), a details pane for the selected plan node (all fields the database reports for it), cost bars that show each node's share of the total cost, and, when an AI provider is configured, "Explain with AI" that attaches the plan to a question in Ask mode. Analyzing a plan SHALL never run the statement unless Explain Analyze was explicitly chosen.

#### Scenario: Copy native plan
- **WHEN** the user presses Copy original plan on a PostgreSQL plan
- **THEN** the plan JSON as returned by `EXPLAIN (FORMAT JSON)` is on the clipboard

#### Scenario: Node details
- **WHEN** the user selects a Seq Scan node
- **THEN** the details pane lists relation, filter, rows estimated and actual (if analysed), width and costs

### Requirement: Transaction isolation level
The console toolbar's transaction control SHALL show the isolation level in manual mode ("Tx: Manual · READ COMMITTED") and its menu SHALL list the levels the driver supports and Auto-commit or Manual. Choosing a level applies to the next transaction, or immediately when no transaction is open; changing it while a transaction is open SHALL ask to commit or roll back first. Each connection MAY have a default level in its Advanced settings, used by new sessions.

#### Scenario: Choose a level
- **WHEN** the user picks SERIALIZABLE from the Tx menu in a manual console with no open transaction
- **THEN** the chip reads "Tx: Manual · SERIALIZABLE" and the next transaction uses it

#### Scenario: Change inside a transaction
- **WHEN** the user picks another level while a transaction is open
- **THEN** a dialog offers Commit, Roll back and Cancel before the change applies

#### Scenario: Connection default
- **WHEN** a connection's default is REPEATABLE READ
- **THEN** every new console session of that connection starts with it

### Requirement: Text selection
In every text editor of the app (SQL console, Cypher and command consoles, value editor, review editor), the user SHALL be able to select text with the mouse (drag, double-click for a word, triple-click for a line, Shift+click to extend) and with the keyboard (Shift+Arrow, Shift+Home/End, Mod+Shift+Left/Right to the line start/end on macOS, Ctrl+Shift+Home/End on Windows, Mod+A), and the selection SHALL be visible and usable by copy, cut, delete, Run selection and the other selection actions.

#### Scenario: Select with the mouse
- **WHEN** the user drags across `SELECT id, name FROM users` in the console
- **THEN** the dragged text is selected, highlighted, and Mod+C copies exactly that text

#### Scenario: Select to the line start
- **WHEN** the caret is at the end of a line and the user presses Mod+Shift+Left on macOS (Shift+Home on Windows)
- **THEN** the text from the caret back to the start of the line is selected

#### Scenario: Select to the line end
- **WHEN** the caret is at the start of a line and the user presses Mod+Shift+Right on macOS (Shift+End on Windows)
- **THEN** the text from the caret to the end of the line is selected

#### Scenario: Select to the document edges
- **WHEN** the user presses Mod+Shift+Down (macOS) or Ctrl+Shift+End (Windows)
- **THEN** everything from the caret to the end of the document is selected, and Mod+Shift+Up / Ctrl+Shift+Home selects to the start

#### Scenario: Selection runs
- **WHEN** text is selected by any of these means and the user presses Mod+Enter
- **THEN** exactly the selected text runs

#### Scenario: Selection is visible on the current statement
- **WHEN** text inside the statement under the cursor is selected, so the statement tint is drawn behind it
- **THEN** the selection highlight is drawn over the tint and nothing opaque covers it

